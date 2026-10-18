import { local } from "./comfy/local/index.ts";
import type { Nodes } from "./comfy/local/nodes.ts";

type Inputs<Class extends keyof Nodes> = NonNullable<Parameters<Nodes[Class]>[0]>;

/** The options the server lists for a combo input, in its order, typed by the generated union. */
export function options<Class extends keyof Nodes, Input extends keyof Inputs<Class> & string>(
  classType: Class,
  input: Input,
): Extract<Inputs<Class>[Input], string>[] {
  const definition = local.nodes[classType]?.inputs.find((each) => each.name === input);
  const listed = definition?.kind === "combo" ? definition.options : [];
  return listed.filter(
    (option): option is Extract<Inputs<Class>[Input], string> => typeof option === "string",
  );
}
