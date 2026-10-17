/**
 * @module @tscomfy/layout
 *
 * Automatic layout for workflows exported to the ComfyUI frontend's UI format (docs/plan.md §11):
 * positions for `toUi`. Pure and runtime-agnostic, like core.
 */

export { layered, type LayoutBox, type LayoutSpacing, type Position } from "./layered.ts";
export { layout } from "./layout.ts";
