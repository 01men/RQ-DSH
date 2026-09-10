const CAPABILITY_SERVICES = {
  "model-gateway.invoke": ["modelGateway"],
  "knowledgebase.read": [],
  "audit.emit": [],
  "usage.meter": ["usage"],
  "storage.scoped": []
};
function createPluginContext(ctx, options) {
  const { pluginId, capabilities } = options;
  const allowed = new Set(capabilities);
  const platformBus = {
    on: (event, cb) => ctx.platformBus.on(event, cb),
    /** 插件事件：只允许自有命名空间；总线层再强制一次 source 一致性。 */
    emit: (name, payload) => {
      if (!name.startsWith(`plugin:${pluginId}:`)) {
        throw new Error(`[plugin-ctx] \u63D2\u4EF6 ${pluginId} \u53EA\u80FD\u53D1\u5C04 plugin:${pluginId}: \u524D\u7F00\u7684\u4E8B\u4EF6\uFF0C\u6536\u5230\uFF1A${name}`);
      }
      return ctx.platformBus.emit(name, payload, { source: `plugin:${pluginId}` });
    },
    recent: (limit) => ctx.platformBus.recent(limit)
  };
  const proxy = /* @__PURE__ */ new Map();
  return {
    pluginId,
    capabilities: [...allowed],
    platformBus,
    /** 能力裁剪的服务访问入口：未授权服务抛错（运行时强制）。 */
    service(name) {
      const entry = Object.entries(CAPABILITY_SERVICES).find(([, services]) => services.includes(name));
      const capability = entry?.[0] ?? name;
      if (!allowed.has(capability) && !allowed.has("*")) {
        throw new Error(`[plugin-ctx] \u63D2\u4EF6 ${pluginId} \u672A\u83B7\u80FD\u529B ${capability}\uFF0C\u7981\u6B62\u8BBF\u95EE\u670D\u52A1 ${name}\uFF08\u5B89\u88C5\u65F6\u5BA1\u6279\u7684\u80FD\u529B\u96C6\u4E3A\u51C6\uFF09`);
      }
      if (!proxy.has(name)) {
        const target = ctx[name];
        if (target === void 0) throw new Error(`[plugin-ctx] \u5E73\u53F0\u670D\u52A1\u4E0D\u5B58\u5728\uFF1A${name}`);
        proxy.set(name, target);
      }
      return proxy.get(name);
    }
  };
}
export {
  CAPABILITY_SERVICES,
  createPluginContext
};
