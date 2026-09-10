import { randomUUID } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
class ToolRuntimeLite extends Service {
  static provide = "tools";
  definitions = /* @__PURE__ */ new Map();
  guards = [];
  constructor(ctx) {
    super(ctx, "tools");
  }
  register(definition) {
    const { name, output } = definition;
    if (typeof name !== "string" || !name) throw new TypeError(`[tools] \u5DE5\u5177\u540D\u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32`);
    if (output === void 0 || typeof output !== "object" || typeof output.render !== "function") {
      throw new TypeError(`\u5DE5\u5177 "${name}" \u5FC5\u987B\u58F0\u660E output { schema, render }`);
    }
    if (this.definitions.has(name)) throw new Error(`[tools] \u5DE5\u5177\u540D\u91CD\u590D\uFF1A${name}`);
    this.definitions.set(name, definition);
    try {
      this.ctx.platformBus?.emit("tools/change", { kind: "register", name });
    } catch {
    }
    return () => {
      this.definitions.delete(name);
    };
  }
  guard(guard) {
    this.guards.push(guard);
    return () => {
      const index = this.guards.indexOf(guard);
      if (index >= 0) this.guards.splice(index, 1);
    };
  }
  schemas() {
    return [...this.definitions.values()].map(({ name, description, parameters, plugin, permission }) => ({
      name,
      description,
      parameters,
      plugin,
      permission
    }));
  }
  has(name) {
    return this.definitions.has(name);
  }
  async execute(input) {
    const started = Date.now();
    const callId = randomUUID();
    const name = input.name;
    const args = input.arguments ?? {};
    const base = { callId, name };
    const definition = this.definitions.get(name);
    if (!definition) {
      return { ...base, isError: true, content: [{ type: "text", text: `\u672A\u77E5\u5DE5\u5177\uFF1A${name}` }], error: { message: `\u672A\u77E5\u5DE5\u5177\uFF1A${name}` }, durationMs: 0 };
    }
    for (const guard of this.guards) {
      const reason = guard({ name, arguments: args });
      if (reason) {
        return { ...base, isError: true, content: [{ type: "text", text: `\u8C03\u7528\u88AB\u62D2\u7EDD\uFF1A${reason}` }], error: { message: reason }, durationMs: Date.now() - started };
      }
    }
    const signal = input.signal ?? new AbortController().signal;
    const exec = { callId, name, signal, ...input.principal ? { principal: input.principal } : {} };
    try {
      const value = await definition.execute(structuredClone(args), exec);
      const content = safeRender(definition, args, value);
      return { ...base, isError: false, value, content, durationMs: Date.now() - started };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...base, isError: true, content: [{ type: "text", text: `\u5DE5\u5177\u6267\u884C\u5931\u8D25\uFF1A${message}` }], error: { message }, durationMs: Date.now() - started };
    }
  }
}
function safeRender(definition, args, value) {
  try {
    const rendered = definition.output.render(args, value);
    return Array.isArray(rendered) ? rendered : [{ type: "text", text: JSON.stringify(value) }];
  } catch {
    return [{ type: "text", text: JSON.stringify(value) }];
  }
}
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
  ToolRuntimeLite,
  defineTool
};
