// UI workflow → Workflow (docs/plan.md §11): what the ComfyUI frontend would queue for a saved
// workflow, as a graph. Frontend 1.55.17, read as a specification (`LGraph.configure`,
// `linkDeduplication.ts`, `subgraphDeduplication.ts`, `ComfyNode.configure`, `graphToPrompt`,
// `ExecutableNodeDTO`, `SubgraphNode`, `searchAndReplace.ts`), in the frontend's own steps:
// 1. read the file, reminting ids as the frontend does (`import/file.ts`);
// 2. restore every node's widget values (`import/widget-values.ts`);
// 3. place the links on slots (`import/placement.ts`);
// 4. let PrimitiveNodes write their values, then replace `%Node.widget%` in file names
//    (`import/primitives.ts`);
// 5. promote subgraph inputs and resolve links through Reroutes, subgraph boundaries and modes
//    (`import/resolve.ts`);
// 6. emit the nodes the prompt holds, in its order (`import/emit.ts`).
// Real nodes keep their links and modes (bypass, mute), which the exporter then applies, so
// `toApi(importUi(x))` is the prompt the frontend builds for `x`.

import { type Link, type WireNode, wireNode } from "../api/import.ts";
import { createDiagnostic, type Diagnostic } from "../diagnostic/diagnostic.ts";
import { SCRIPTED_WIDGETS, uncreatable } from "../frontend/node.ts";
import type { Workflow } from "../graph/graph.ts";
import { assembleWorkflow, type AssembledNode } from "../graph/workflow.ts";
import { parse } from "../json/parse.ts";
import { isJsonArray, isJsonObject, type JsonObject } from "../json/value.ts";
import { definitionOf } from "../schema/lookup.ts";
import type { TypedSchema } from "../schema/typed.ts";
import type { Schema } from "../schema/types.ts";
import { emittedNodes, executionOrder, wireOf } from "./import/emit.ts";
import { type DefinitionFile, type GraphFile, type Id, readUiFile } from "./import/file.ts";
import type { Graph, Loaded, Subgraph } from "./import/graph.ts";
import { placeLinks } from "./import/placement.ts";
import { applyPrimitives, replaceFileNames, TextReplacer } from "./import/primitives.ts";
import type { Report } from "./import/report.ts";
import { LinkResolver } from "./import/resolve.ts";
import { type RestoredValues, restoreWidgetValues } from "./import/widget-values.ts";

/** What {@link importUi} returns. */
export interface UiImportResult<N> {
  /** The workflow the frontend would queue, as a graph over `schema`. */
  readonly workflow: Workflow<N>;
  /** Problems reading the workflow, and frontend behavior it reproduces with a warning. */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Reads a UI workflow, as the frontend saves it (format 0.4 with tuple links, or 1), into a
 * workflow over `schema`. Takes raw text, so big integers stay exact (the frontend rounds them).
 *
 * Exporting the result gives the prompt the frontend builds for the same file, byte for byte,
 * except where JavaScript changes it at queue time (dates in file names, 3D scenes, webcam frames,
 * recordings, packs' injected links and widgets), for buttons the frontend sends under their labels
 * and the backend ignores, and for nodes of classes the schema doesn't have, which the frontend
 * sends without a class.
 */
export function importUi<N>(text: string, schema: TypedSchema<N>): UiImportResult<N> {
  const diagnostics: Diagnostic[] = [];
  const report: Report = (code, path, message) => {
    diagnostics.push(createDiagnostic(code, path, message));
  };
  const parsed = parse(text);
  diagnostics.push(...parsed.diagnostics);
  const workflow = assembleWorkflow(schema, (link) => {
    if (parsed.value === undefined) return [];
    if (!isJsonObject(parsed.value) || !isJsonArray(parsed.value["nodes"])) {
      report("E_INVALID_WORKFLOW", [], "Expected a UI workflow: an object with a nodes list.");
      return [];
    }
    return read(parsed.value, schema, link, diagnostics, report);
  });
  return { workflow, diagnostics };
}

/** The steps of the import, in the frontend's order. */
function read(
  file: JsonObject,
  schema: TypedSchema<unknown>,
  link: Link,
  diagnostics: Diagnostic[],
  report: Report,
): AssembledNode[] {
  // 1. The graphs, as the file holds them.
  const graphs = readUiFile(file, report);
  if (graphs === undefined) return [];
  // 2 and 3. Widget values, then links, graph by graph; definitions first, which instances need.
  const subgraphs = new Map<string, Subgraph>();
  const load = (graph: GraphFile): Graph => {
    const values = restoreAll(graph, schema, report);
    const placement = placeLinks(graph, {
      definitionOf: (type) => definitionOf(schema, type),
      subgraphOf: (type) => graphs.definitions.get(type),
      values,
    });
    return { file: graph, values, placement };
  };
  const loadDefinition = (definition: DefinitionFile): Subgraph => ({
    ...definition,
    graph: load(definition.graph),
  });
  const ordered = graphs.ordered.map((definition) => {
    const subgraph = loadDefinition(definition);
    subgraphs.set(definition.id, subgraph);
    return subgraph;
  });
  const loaded: Loaded = {
    schema,
    root: load(graphs.root),
    subgraphs,
    ordered,
    groupNode: (type) => isGroupNode(file, type),
    report,
  };
  // 4. PrimitiveNodes write into widgets before anything resolves, then save nodes replace
  // `%…%` in their file names, from the values as they are then.
  const rootOrder = executionOrder(loaded.root);
  const text = new TextReplacer(loaded);
  applyPrimitives(loaded, loaded.root, rootOrder, text);
  for (const { graph } of ordered) applyPrimitives(loaded, graph, graph.file.order, text);
  replaceFileNames([loaded.root, ...ordered.map((each) => each.graph)], loaded.root, text);
  // 5 and 6. Promoted values, link resolution, and the nodes of the prompt.
  const resolver = new LinkResolver(loaded);
  const wire = emittedNodes(loaded, rootOrder).map((emitted) => wireOf(loaded, resolver, emitted));
  return byId(wire, report).map((node) => wireNode(node, schema, link, diagnostics));
}

/**
 * The nodes as the frontend's prompt object holds them, by id: a node with the id of an earlier
 * one (a root node with the id `"40:31"` and node 31 inside instance 40, in an edited file)
 * replaces it, in its place.
 */
function byId(nodes: readonly WireNode[], report: Report): WireNode[] {
  const kept: WireNode[] = [];
  const at = new Map<string, number>();
  for (const node of nodes) {
    const index = at.get(node.id);
    if (index === undefined) {
      at.set(node.id, kept.length);
      kept.push(node);
      continue;
    }
    report(
      "W_FRONTEND_QUIRK",
      [node.id],
      `Two nodes of the prompt have the id ${node.id}: the frontend keeps the later one, in the earlier one's place, and so does this.`,
    );
    kept[index] = node;
  }
  return kept;
}

/** The restored widget values of a graph's nodes of known classes the frontend can create. */
function restoreAll(graph: GraphFile, schema: Schema, report: Report): Map<Id, RestoredValues> {
  const values = new Map<Id, RestoredValues>();
  for (const id of graph.order) {
    const node = graph.nodes.get(id);
    const definition = node === undefined ? undefined : definitionOf(schema, node.type);
    if (node === undefined || definition === undefined || uncreatable(definition) !== undefined) {
      continue;
    }
    // Widgets frontend JavaScript adds never fit the definition; `W_EXTENSION_WIDGETS` says so.
    const restoring: Report = SCRIPTED_WIDGETS.has(node.type)
      ? (code, path, message) => {
          if (code !== "W_WIDGET_VALUES_MISMATCH") report(code, path, message);
        }
      : report;
    values.set(
      id,
      restoreWidgetValues(
        node,
        definition,
        [...graph.prefix, node.id, "widgets_values"],
        restoring,
      ),
    );
  }
  return values;
}

/** A legacy group node: `workflow>Name` (or `workflow/Name`) with `extra.groupNodes[Name]`. */
function isGroupNode(file: JsonObject, type: string): boolean {
  const match = /^workflow[>/](.+)$/.exec(type);
  const extra = file["extra"];
  const groups = isJsonObject(extra) ? extra["groupNodes"] : undefined;
  return match?.[1] !== undefined && isJsonObject(groups) && Object.hasOwn(groups, match[1]);
}
