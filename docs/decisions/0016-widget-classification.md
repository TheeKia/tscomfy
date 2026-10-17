# ADR-0016: An input is a widget exactly when the frontend makes it one

Status: accepted, 2026-10-17

## Context

Whether an input takes a value or only a link decides its generated type and whether the exporter sends a value. `/object_info` doesn't say so directly. The plan modelled five widget kinds (INT, FLOAT, STRING, BOOLEAN, COMBO) and treated every other type as a socket. A real dump showed that this is not enough:

- 25 inputs use other widgets of the frontend's core registry (COLOR, BOUNDING_BOX, COLORS, CURVE, VIDEO_EDIT, …), mostly `socketless`, with object or list defaults. As sockets they could never be set.
- 12 inputs carry `widgetType`, which separates the widget from the socket type: `frame_rate` is a FLOAT widget on a `FLOAT,INT` socket; Painter's `mask` is a PAINTER widget on a STRING.
- `INT:seed` (3 inputs) looks like an INT variant but is its own type.

## Decision

Follow the frontend's rule (ComfyUI_frontend 1.55.17, `litegraphService.ts` `addInputSocket`/`addInputWidget`, registry in `widgets.ts`): look up `widgetType ?? type` in the core widget registry.

- When `type` is primitive (INT, FLOAT, STRING, BOOLEAN, COMBO), the kind follows `type`: the backend coerces and validates by it (combo membership, `int()`), whatever widget the frontend draws. A differing `widgetType` is recorded.
- Otherwise a primitive widget (e.g. FLOAT on a `FLOAT,INT` socket, COMBO on a pack type) gives its kind, and the other core widgets give a `value` input holding the server's default as JSON.
- Everything else is a socket, including `TYPE:name` types, pack types with widget-like options, and widgets a pack registers in the browser on a non-primitive type.
- `forceInput` makes a widget a socket, except legacy combos (their exact-list link rule can't be expressed as a COMBO socket, and the backend accepts constants for them).
- The socket type (for links and for the backend's coercion) is always `type`, never the widget. A COMBO widget on another type therefore takes no option-list links.

## Consequences

- The schema matches which inputs get values in the frontend's prompts.
- The registry list is frontend knowledge kept in `core/src/object-info/frontend-widgets.ts`, with its source cited. A frontend that adds a core widget needs a new entry; until then such inputs are sockets, which is stricter, never looser.
- Widgets registered by packs in the browser are invisible in `/object_info`. Inputs that depend on one with a non-primitive type stay sockets; `raw()` remains the escape hatch.
- How each value widget serializes (some never send a value, CURVE wraps its value) is decided in Phase 3, against the frontend source.

## Evidence

Plan §16: the registry contents, the dump counts, and the backend's handling of `INT:seed`.
