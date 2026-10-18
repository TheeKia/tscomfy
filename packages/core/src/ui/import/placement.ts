// Where a UI graph's links land, as the frontend places them when it loads the file (docs/plan.md
// §11): `normalizeConfiguredTopology` keeps one link per slot, each lands on its `target_slot` of
// the node as created, a dynamic combo's options are rebuilt for the restored value, and
// `realignInputLinkSlots` moves a link a saved input names to the slot of that name.

import { createdWidgets, frontendSlots } from "../../frontend/node.ts";
import type { NodeDef } from "../../schema/types.ts";
import type { DefinitionFile, GraphFile, Id, UiLink, UiNode } from "./file.ts";
import type { RestoredValues } from "./widget-values.ts";

/** A slot of a node once loaded: its name and the type the frontend gives it. */
export interface LoadedSlot {
  readonly name: string;
  readonly type: string;
}

/** Where a graph's links landed. */
export interface Placement {
  /** The link a saved link id stands for once duplicates are merged, if it survives. */
  readonly liveLink: (id: number) => UiLink | undefined;
  /** Placed links by target node and the slot name each landed on. */
  readonly into: ReadonlyMap<Id, ReadonlyMap<string, UiLink>>;
  /** The slot name each placed link landed on, by link id. */
  readonly names: ReadonlyMap<number, string>;
  /** Placed links by origin node. */
  readonly outgoing: ReadonlyMap<Id, readonly UiLink[]>;
  /** The slots of each node with a placed link, once loaded, in order. */
  readonly layouts: ReadonlyMap<Id, readonly LoadedSlot[]>;
}

/** What placing a graph's links needs to know besides the graph. */
export interface PlacementContext {
  readonly definitionOf: (type: string) => NodeDef | undefined;
  readonly subgraphOf: (type: string) => DefinitionFile | undefined;
  readonly values: ReadonlyMap<Id, RestoredValues>;
}

/**
 * Places a graph's links as the frontend does. Links competing for one slot keep the first,
 * unless only a later one is referenced by an input (`normalizeConfiguredTopology`). Each lands
 * on its `target_slot` of the node as created; a dynamic combo's options are then rebuilt for the
 * restored value, dropping links on slots the chosen option doesn't have; then a link that a
 * saved input of its own target references moves to the slot of that name
 * (`realignInputLinkSlots`).
 */
export function placeLinks(graph: GraphFile, context: PlacementContext): Placement {
  const referenced = new Set<number>();
  for (const node of graph.nodes.values()) {
    for (const input of node.inputs) if (input.link !== undefined) referenced.add(input.link);
  }
  const alive = new Map<number, UiLink>();
  const remap = new Map<number, number>();
  const kept: UiLink[] = [];
  const at = new Map<string, number>();
  for (const link of graph.links.values()) {
    const key = `${link.targetId}\u0000${String(link.targetSlot)}`;
    const index = at.get(key);
    const survivor = index === undefined ? undefined : kept[index];
    if (index === undefined || survivor === undefined) {
      at.set(key, kept.length);
      kept.push(link);
      continue;
    }
    const same = survivor.originId === link.originId && survivor.originSlot === link.originSlot;
    if (!same && referenced.has(link.id) && !referenced.has(survivor.id)) {
      kept[index] = link;
      for (const [dropped, to] of remap) if (to === survivor.id) remap.set(dropped, link.id);
      remap.set(survivor.id, link.id);
    } else {
      remap.set(link.id, survivor.id);
    }
  }
  const liveLink = (id: number): UiLink | undefined => alive.get(remap.get(id) ?? id);
  const byTarget = new Map<Id, UiLink[]>();
  for (const link of kept) {
    alive.set(link.id, link);
    if (!graph.nodes.has(link.targetId)) continue;
    const links = byTarget.get(link.targetId);
    if (links === undefined) byTarget.set(link.targetId, [link]);
    else links.push(link);
  }
  const into = new Map<Id, Map<string, UiLink>>();
  const names = new Map<number, string>();
  const outgoing = new Map<Id, UiLink[]>();
  const layouts = new Map<Id, readonly LoadedSlot[]>();
  for (const [target, links] of byTarget) {
    const node = graph.nodes.get(target);
    if (node === undefined) continue;
    const created = slotsOf(node, context, true).map((slot) => slot.name);
    const loadedSlots = slotsOf(node, context, false);
    layouts.set(target, loadedSlots);
    const loaded = loadedSlots.map((slot) => slot.name);
    const onto = new Map<UiLink, string>();
    // A slot past the node's still holds the link, which realignment can move by name.
    for (const link of links) {
      onto.set(link, created[link.targetSlot] ?? `\u0000${String(link.targetSlot)}`);
    }
    const definition = context.definitionOf(node.type);
    if (node.inputs.some((input) => isOptionChild(definition, input.name))) {
      // `realignGroupWidgetChildLinks`: before the options are rebuilt, over the created slots
      // and the saved ones the definition lacks.
      realign(onto, created, node, liveLink);
    }
    // Rebuilding the options removes the slots the chosen ones lack, and their links.
    const available = new Set(loaded);
    const removable = new Set(created.filter((name) => !available.has(name)));
    for (const [link, name] of onto) if (removable.has(name)) onto.delete(link);
    realign(onto, loaded, node, liveLink);
    const placed = new Map<string, UiLink>();
    const byName = new Map([...onto].map(([link, name]) => [name, link]));
    for (const name of loaded) {
      const link = byName.get(name);
      if (link === undefined) continue;
      placed.set(name, link);
      names.set(link.id, name);
      const from = outgoing.get(link.originId);
      if (from === undefined) outgoing.set(link.originId, [link]);
      else from.push(link);
    }
    into.set(target, placed);
  }
  return { liveLink, into, names, outgoing, layouts };
}

/**
 * The slots of a node in the frontend's order: as created (`fresh`, links land there by
 * `target_slot`) or once loaded, then the saved inputs the definition lacks, typed `*`. A
 * subgraph instance's slots are its definition's inputs; a node of an unknown class has its saved
 * inputs.
 */
function slotsOf(node: UiNode, context: PlacementContext, fresh: boolean): LoadedSlot[] {
  const definition = context.definitionOf(node.type);
  if (definition === undefined) {
    const instance = context.subgraphOf(node.type);
    return instance === undefined
      ? node.inputs.map((input) => ({ name: input.name, type: "*" }))
      : instance.inputs.map((input) => ({ name: input.name, type: input.type }));
  }
  const linkedNames = new Set(
    node.inputs.filter((input) => input.link !== undefined).map((input) => input.name),
  );
  const values = context.values.get(node.id)?.values;
  const slots = frontendSlots(definition, {
    chosen: (key) => values?.get(key),
    autogrow: (key, input) => {
      const created = Math.max(input.min + 1, 1);
      if (fresh) return input.slots.slice(0, created);
      // Linked slots from the first grow the group, with one empty slot after them.
      let chain = 0;
      while (chain < input.slots.length && linkedNames.has(`${key}.${input.slots[chain] ?? ""}`))
        chain++;
      return input.slots.slice(0, Math.max(created, chain + 1));
    },
    fresh,
  });
  const known = new Set(slots.map((slot) => slot.name));
  const extra = node.inputs.filter((input) => !known.has(input.name));
  return [
    ...slots.map((slot) => ({ name: slot.name, type: slot.type })),
    ...extra.map((input) => ({ name: input.name, type: "*" })),
  ];
}

/**
 * Moves each link a saved input of its own target references to the slot of that name, as
 * `realignInputLinkSlots` does: in passes, a link whose slot isn't among its names moving to the
 * first; links that would land on a slot another link keeps are skipped, and a referenced link
 * whose names the node lacks gives way to one moving onto its slot.
 */
function realign(
  onto: Map<UiLink, string>,
  layout: readonly string[],
  node: UiNode,
  liveLink: (id: number) => UiLink | undefined,
): void {
  const index = new Map(layout.map((name, at) => [name, at]));
  const referenced = new Map<UiLink, string[]>();
  for (const input of node.inputs) {
    if (input.link === undefined) continue;
    const link = liveLink(input.link);
    if (link === undefined || link.targetId !== node.id || !onto.has(link)) continue;
    const names = referenced.get(link) ?? [];
    names.push(input.name);
    referenced.set(link, names);
  }
  const skipped = new Set<UiLink>();
  let passes = 0;
  while (passes < referenced.size) {
    const moved: { readonly link: UiLink; readonly name: string }[] = [];
    for (const [link, names] of referenced) {
      if (skipped.has(link) || !onto.has(link)) continue;
      const slots = names
        .filter((name) => index.has(name))
        .toSorted((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
      const first = slots[0];
      if (first === undefined) continue;
      const current = onto.get(link) ?? "";
      const name = slots.includes(current) ? current : first;
      if (name !== current) moved.push({ link, name });
    }
    if (moved.length === 0) break;
    const unmatched = [...referenced]
      .filter(([link, names]) => onto.has(link) && !names.some((name) => index.has(name)))
      .map(([link]) => link);
    const destinations = new Set(moved.map(({ name }) => name));
    const removals = unmatched.filter((link) => destinations.has(onto.get(link) ?? ""));
    const participants = new Set([...moved.map(({ link }) => link), ...removals]);
    const occupant = new Map([...onto].map(([link, name]) => [name, link]));
    const blocked = moved.filter(({ name }) => {
      const there = occupant.get(name);
      return there !== undefined && !participants.has(there);
    });
    if (blocked.length > 0 || destinations.size < moved.length) {
      for (const { link } of blocked.length > 0 ? blocked : moved) skipped.add(link);
      continue;
    }
    passes++;
    for (const link of removals) onto.delete(link);
    for (const { link, name } of moved) onto.set(link, name);
  }
}

/**
 * Whether a saved input is named under a widget of the node as created, as dynamic-combo option
 * inputs are (`isGroupWidgetChildInput`).
 */
function isOptionChild(definition: NodeDef | undefined, name: string): boolean {
  const separator = name.lastIndexOf(".");
  if (definition === undefined || separator < 1) return false;
  const group = name.slice(0, separator);
  return createdWidgets(definition).some((widget) => widget.name === group);
}
