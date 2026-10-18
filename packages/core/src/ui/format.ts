// Fields of the UI workflow format that the importer and the exporter share (docs/plan.md §11).

import type { NodeMode } from "../graph/types.ts";

/** `mode` of a muted node (`LGraphEventMode.NEVER`). */
export const MODE_MUTE = 2;
/** `mode` of a bypassed node (`LGraphEventMode.BYPASS`). */
export const MODE_BYPASS = 4;

/** A node's `mode` number as a mode of ours; the frontend's other modes run the node. */
export function nodeModeOf(mode: number): NodeMode | undefined {
  if (mode === MODE_MUTE) return "mute";
  return mode === MODE_BYPASS ? "bypass" : undefined;
}

/** A mode of ours as the `mode` number the frontend saves (`LGraphEventMode.ALWAYS` is 0). */
export function modeNumber(mode: NodeMode | undefined): number {
  if (mode === "mute") return MODE_MUTE;
  return mode === "bypass" ? MODE_BYPASS : 0;
}

/**
 * The property `%Node.widget%` replacement finds a node by first; the frontend gives it to every
 * node of a server class but the save nodes when it creates one.
 */
export const SEARCH_NAME_PROPERTY = "Node name for S&R";
