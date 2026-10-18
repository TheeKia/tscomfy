# The UI workflow format: ground truth

How frontend 1.55.17 (the version ComfyUI 0.41 installs) reads the workflow JSON it saves, and how
it builds a prompt from it. Researched 2026-10-18 by reading the TypeScript embedded in the
installed bundle's source maps, then checking each rule in the running frontend with headless
probes (`internal/fixtures/scripts/frontend.ts` and 45 synthetic files) and against a local corpus
of 10 real UI workflows and the prompts the frontend built for them. Paths are relative to the
frontend repository. The frontend is GPL-3.0: this file describes behavior, it does not copy code.

Marks: **[V]** verified in the running frontend or the corpus; **[S]** read in the source only.

## File shape

- **Root.** The frontend always writes `version: 0.4` with tuple links,
  `[id, origin_id, origin_slot, target_id, target_slot, type]`, plus `last_node_id`,
  `last_link_id`, `nodes`, `groups`, `config`, `extra` and `definitions.subgraphs`. Version 1
  (object links, `state.lastNodeId`) is what subgraph definitions use; the loader takes it at the
  root too. **[V]**
- **Versions decide the link form** (`LGraph.configure`): `0.4` reads tuples; anything else,
  including a missing `version`, reads objects, so tuple links there vanish. **[V]**
- **Nodes** (`LGraphNode.serialize`): `id, type, pos, size, flags, order, mode, inputs, outputs,
  title?, properties, widgets_values?, widgets_values_named?`. `title` is written only when it
  differs from the default; `order` is never read back. `widgets_values_named` (new in 1.55)
  holds the same values by widget name; the frontend doesn't restore from it unless an
  experimental setting is on. **[S][V]**
- **Cosmetic, never part of the prompt:** groups, native reroutes (`extra.reroutes`,
  `linkExtensions`, `floatingLinks`), `pos`, `size`, `flags`. On load a node's size becomes the
  larger of the saved size and what it needs, snapped to 10 px. **[V]**

## Rebuilding nodes

- **Connectivity is the `links` array.** A link connects even when no input mentions it; an
  `inputs[].link` whose id the array lacks connects nothing; `outputs[].links` is never read.
  **[V]**
- **Competing links** (`normalizeConfiguredTopology`): of links to one target slot the first in
  the array survives, unless only a later one is referenced by an input; references to a dropped
  link move to the survivor. **[V]**
- **Placement.** A link lands on `target_slot` of the node as created. A link that a saved input
  of its own target references then moves to the slot of that name (`realignInputLinkSlots`):
  among several names the current slot if it is one, else the first; a move onto a slot another
  link keeps is skipped. An input naming another node's link moves nothing; a link past the
  node's slots still moves by name. **[V]**
- **Node ids** are strings internally (`toNodeId`), so `4` and `"4"` are one node; a fractional
  id too. At the root, nodes are added in file order, and one whose id is already in the graph
  gets the next free number after the counter, so a later node whose id that took is reminted in
  turn; links follow a reminted node only when no other node asked for that id
  (`recordUnambiguousRemint`). Inside a definition the later node is dropped
  (`dropSameOwnerDuplicates`). **[V][S]**
- **A node is created from its definition, then the saved node is merged in**
  (`ComfyNode.configure`): inputs by name, with saved inputs the definition lacks kept after the
  others; outputs by index. **[V]**
- **Slot order** (`addInputs`, inputs ordered by `getOrderedInputSpecs`, which matches our
  normalizer's order for all 1,758 classes of the server): first the inputs that get only a
  socket (no widget for `widgetType ?? type`, `forceInput`, MatchType, Autogrow), then a slot for
  each widget-backed input. A dynamic combo's chosen option inserts its slots right after the
  combo's own once a value is set. **[V]**
- **Widgets** (`widgets.ts`, `useIntWidget`, `useComboWidget`, `dynamicWidgets.ts`), in input
  order:
  - a value widget per input;
  - after an INT whose `control_after_generate` is truthy, or which is named `seed` or
    `noise_seed` with the option absent, a control widget (`fixed`, `increment`, `decrement`,
    `randomize`); after a FLOAT or combo with the option, one too, and a combo also gets a
    `control_filter_list` string. A string option names the control after itself (`"fixed"`
    gives a widget named `fixed`) and is its initial value; otherwise it starts at `randomize`.
    Controls are saved, never sent. **[V]**
  - a dynamic combo, then its chosen option's widgets, depth-first; **[V]**
  - pseudo-inputs that core extensions add after every input: `upload` (saved `"image"`, never
    sent) for the first required combo with `image_upload`, `video_upload` or
    `animated_image_upload`, or for a required `audio` combo with `audio_upload` (saved `""`);
    an audio player widget on audio nodes (neither saved nor sent). **[S][V]**
  - IMAGECOMPARE is not saved but is sent (`{"__value__": ["", ""]}`); RESOLUTION_PREVIEW and
    CAMERA_INFO_STATE are neither. DynamicGroup has no handler in 1.55.17: no widgets, nothing
    saved or sent. **[V]**
- **Restoring values** is positional over the saved widgets as they are created, and the list
  grows while it is restored, as dynamic-combo options add widgets; their links follow by name,
  and links on option inputs the chosen option lacks are dropped. Missing values keep the
  initial ones; extra values are ignored. `widgets_values_named` isn't read (an experimental
  setting); `widgets_values` saved as an object is read by name. Files from before 1.16 saved a
  placeholder for each `forceInput` input, which `migrateWidgetsValues` drops when the count
  lines up. Then: a combo saved as `null` takes its first option,
  KSampler's old `sample_` sampler names lose the prefix, a KSampler control saved as `true` or
  `false` becomes `randomize` or `fixed`. **[V]**
- **Autogrow** shows a contiguous run of linked slots and one empty slot after it; saved slots
  outside that run stay where the merge put them, at the end. **[V]**
- **Missing classes** become placeholder nodes with widgets `UNKNOWN`, `UNKNOWN_1`, …, and are sent
  without `class_type`, which the backend rejects. **[V]**

## Building the prompt (`graphToPrompt`)

- **Order.** Root nodes in `computeExecutionOrder`: nodes with no linked input first, in file
  order, then breadth-first along links in ascending link id; nodes on cycles last. Each
  subgraph instance's interior follows it, in the definition's node order, depth-first into
  nested instances. Integer-like keys then sort numerically, as in any JavaScript object. **[V]**
- **Inputs.** Widget values first, in widget order, then links in slot order; a link to a
  widget's key replaces the value in place. A link that resolves to nothing leaves the widget's
  value, or nothing for a socket. **[V]**
- **Resolution** (`ExecutableNodeDTO.resolveInput`, `resolveOutput`): a muted node resolves to
  nothing, a bypassed one through `_getBypassSlotIndex` (plan §12). A missing origin node or a
  loop makes the frontend refuse to build the prompt. **[S]**
- **Reroute** nodes resolve through their one input with the consumer's type; a muted one gives
  nothing; a bypassed one passes through but passes no type on. **[V]**
- **PrimitiveNode** (`widgetInputs.ts`) writes its value into every widget it links to before
  the prompt is built, whatever its mode; its link then resolves to nothing, so the widget's
  (now the primitive's) value is sent. **[V]**
- **Note** and **MarkdownNote** are never sent. **[V]**
- **File names** (`saveImageExtraOutput.ts`, `searchAndReplace.ts`): the core save nodes'
  `filename_prefix` goes through `%…%` replacement when the prompt is built: `%Node.widget%`
  becomes that widget's value, controls included (node found by its `Node name for S&R` property,
  which every node of a server class but the save nodes gets at creation, else by title, its
  default being `Primitive`, `Reroute`, `Note` or `Markdown Note` for the frontend's own nodes;
  interiors before their instance), with path-unsafe characters replaced by `_`; `%date:…%` becomes the time. A
  PrimitiveNode with `Run widget replace on values` replaces its value the same way. **[V]**

## Subgraphs

- An instance is a node whose `type` is a definition's id. Its slots are rebuilt from the
  definition's `inputs` and `outputs`. Inside, links from node `-10` enter through definition
  input `origin_slot`; links to `-20` leave through definition output `target_slot`; each
  boundary entry lists its `linkIds`, and an output resolves through the first id that exists.
  **[V]**
- **Ids.** Inner nodes are sent as the instance path joined with `:` (`40:31:21`). Inner ids
  that an earlier graph already uses (the root, then definitions in order) are reminted from
  `last_node_id` up (`normalizeSubgraphDefinitions`); two instances of one definition share their
  inner ids under different prefixes. **[V]**
- **Promoted widgets** (`SubgraphNode`): an instance input promotes the first widget its
  `linkIds` reach inside (through nested instances' own promotions). The instance's
  `widgets_values` holds one value per promoting input, in input order, linked or not; a missing
  one keeps the interior widget's value. The value is sent to every inner widget the input
  links to, unless the instance input is linked outside, in which case the link is followed.
  **[V]**
- **Loops.** The loop guard of `resolveInput`/`resolveOutput` keys steps by definition, not
  instance, so an input linked through two instances of one subgraph in a row makes the frontend
  refuse the prompt. A definition that contains itself makes it refuse the whole file. **[V]**
- **Modes.** A muted or bypassed instance at the root isn't expanded; its outputs resolve as a
  muted or bypassed node over the definition's inputs. A muted or bypassed instance nested in
  another **still sends its interior**, since the expansion doesn't check modes; only resolution
  through its outputs honors the mode. **[V]**
- **A PrimitiveNode linked to a promoted input loses its value:** the instance input is now
  linked, the link resolves to nothing, and the interior widget's own value is sent. Linking it
  also moves the instance later in the execution order. **[V]**

## Saving our own files (`toUi`)

- The frontend needs only `version: 0.4`, `nodes` (with `id` and `type`) and tuple `links`;
  everything else has defaults. Writing every slot in the order above, with `target_slot` the
  slot's index, makes the by-name realignment agree. **[V]**
- Writing controls as `fixed` keeps the frontend from changing a value after it queues the
  prompt; its default is `randomize`. **[S]**
- Subgraph definitions also need `inputNode` and `outputNode` with a `bounding` box and
  `linkIds` on every boundary entry, or they fail to load. **[V]** (`toUi` writes flat graphs.)

## Out of reach

- The queue time in `%date:…%` file names.
- Pack JavaScript changes prompts at queue time: date substitutions in its own file names, links
  that "everywhere" nodes inject, inputs that switch nodes drop, extra widgets, values serialized
  by code. None of it follows from `/object_info`; `widgets_values_named` at least names pack
  widgets' values. **[V]**
- The frontend's JSON parser rounds integers beyond 2⁵³, so a saved seed of 2⁶⁴−1 is queued
  rounded. **[V]**
- Legacy group nodes (`extra.groupNodes`, type `workflow>Name`) are converted into subgraphs on
  load; tscomfy reports them instead (`E_LEGACY_GROUP_NODE`). **[V]**
- Not probed: legacy `proxyWidgets` beyond the simple cases, multi-select combo restore.
