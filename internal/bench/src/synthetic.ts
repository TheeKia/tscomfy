// Synthetic schemas of a given size, built from the committed mocks, so the type-check budget
// (docs/plan.md §6.6) doesn't depend on anyone's real dump.

import { type InputDef, type NodeDef, normalizeObjectInfo, type Schema } from "@tscomfy/core";
import { MOCK_OBJECT_INFO_NAMES, readMockObjectInfo } from "@tscomfy/fixtures";

/**
 * Every node class of the mocks, as templates for copies. A class two mocks define is taken from
 * the first, so each copy gets a class type of its own.
 */
export async function mockNodes(): Promise<readonly NodeDef[]> {
  const schemas = await Promise.all(
    MOCK_OBJECT_INFO_NAMES.map(
      async (name) => normalizeObjectInfo(await readMockObjectInfo(name)).schema,
    ),
  );
  const nodes = new Map<string, NodeDef>();
  for (const node of schemas.flatMap((schema) => Object.values(schema.nodes))) {
    if (!nodes.has(node.classType)) nodes.set(node.classType, node);
  }
  return [...nodes.values()];
}

/**
 * A schema of `size` nodes: the templates copied round-robin, each copy with its own class type
 * and its own combo options, so aliases don't all collapse into one as identical copies would.
 */
export function syntheticSchema(templates: readonly NodeDef[], size: number): Schema {
  const entries = Array.from({ length: size }, (_, index): [string, NodeDef] => {
    const template = templates[index % templates.length];
    if (template === undefined) throw new Error("no templates");
    const copy = Math.floor(index / templates.length);
    const classType = copy === 0 ? template.classType : `${template.classType}__${String(copy)}`;
    return [
      classType,
      { ...template, classType, inputs: template.inputs.map((input) => rename(input, copy)) },
    ];
  });
  const nodes = Object.fromEntries(entries);
  if (Object.keys(nodes).length !== size) {
    throw new Error(
      `syntheticSchema: ${String(size)} copies made only ${String(Object.keys(nodes).length)} classes`,
    );
  }
  return { formatVersion: 1, nodes };
}

function rename(input: InputDef, copy: number): InputDef {
  if (copy === 0) return input;
  switch (input.kind) {
    case "combo":
      return {
        ...input,
        options: input.options.map((option) =>
          typeof option === "string" ? `${option}#${String(copy)}` : option,
        ),
      };
    case "dynamicCombo":
      return {
        ...input,
        options: input.options.map((option) => ({
          ...option,
          inputs: option.inputs.map((child) => rename(child, copy)),
        })),
      };
    case "dynamicGroup":
      return { ...input, fields: input.fields.map((field) => rename(field, copy)) };
    case "autogrow":
      return { ...input, template: rename(input.template, copy) };
    case "socket":
    case "int":
    case "float":
    case "string":
    case "boolean":
    case "value":
    case "matchType":
    case "unknown":
      return input;
  }
}
