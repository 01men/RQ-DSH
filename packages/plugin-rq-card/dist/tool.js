function defineTool(spec) {
  const properties = {};
  const required = [];
  for (const [key, param] of Object.entries(spec.parameters)) {
    const node = { type: param.type };
    if (param.description) node.description = param.description;
    if (param.enum) node.enum = param.enum;
    if (param.items) node.items = param.items;
    properties[key] = node;
    if (param.required) required.push(key);
  }
  const parameters = {
    type: "object",
    properties,
    ...required.length > 0 ? { required } : {}
  };
  return {
    name: spec.name,
    description: spec.description,
    plugin: spec.plugin,
    ...spec.permission !== void 0 ? { permission: spec.permission } : {},
    parameters,
    output: {
      schema: spec.output,
      render: spec.render ?? ((_args, value) => [
        { type: "text", text: JSON.stringify(value, null, 2) }
      ])
    },
    ...spec.timeoutMs !== void 0 ? { timeoutMs: spec.timeoutMs } : {},
    execute: spec.execute
  };
}
export {
  defineTool
};
