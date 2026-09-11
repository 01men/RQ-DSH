const BRIDGE_PLUGIN_ID = "@ybkk/gate-01/panel-core";
const soft = (ctx, key) => {
  try {
    return ctx.reflect.get(key, false);
  } catch {
    return void 0;
  }
};
const asDshLlm = (value) => {
  const candidate = value;
  if (!candidate || typeof candidate.listProviders !== "function" || typeof candidate.stream !== "function") return void 0;
  return candidate;
};
class DshModelGateway {
  /** modelgw 同款集合面：all/findOne/get——桥目录按需惰性发现，findone 走缓存快照。 */
  cache = /* @__PURE__ */ new Map();
  cacheAt = 0;
  ttlMs = 3e4;
  inflight;
  ctx;
  llm;
  constructor(ctx, llm) {
    this.ctx = ctx;
    this.llm = llm;
  }
  defaultSelection() {
    const adm = soft(this.ctx, "agentDefaultModel");
    try {
      const read = adm?.read?.();
      if (read?.provider && read?.model) return { provider: read.provider, model: read.model };
    } catch {
    }
    return void 0;
  }
  /** 目录快照：default（若可解析）+ 全部 provider 的已发现模型。发现失败的路由诚实跳过。 */
  async refresh() {
    if (Date.now() - this.cacheAt < this.ttlMs) return;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const next = /* @__PURE__ */ new Map();
      const put = (provider, model, name) => {
        const slug = `${provider}:${model}`;
        if (next.has(slug)) return;
        next.set(slug, {
          id: `dshmdl_${slug.replace(/[^A-Za-z0-9]/g, "_")}`,
          slug,
          displayName: name ?? model,
          provider,
          endpoint: "\uFF08dsh \u5185\u7F6E\u901A\u9053\uFF0C\u65E0\u9700\u767B\u8BB0\uFF09",
          apiKey: "env:DSH_MANAGED",
          listCentsPerKTokens: 0,
          costCentsPerKTokens: 0,
          status: "online",
          managedBy: "dsh"
        });
      };
      const preferred = this.defaultSelection();
      if (preferred) put(preferred.provider, preferred.model);
      let providers = [];
      try {
        providers = this.llm.listProviders() ?? [];
      } catch {
      }
      for (const provider of providers) {
        try {
          const models = await this.llm.listModels(provider.id);
          for (const model of models ?? []) put(provider.id, model.id, model.name);
        } catch {
        }
      }
      this.cache = next;
      this.cacheAt = Date.now();
    })().finally(() => {
      this.inflight = void 0;
    });
    return this.inflight;
  }
  snapshot() {
    return [...this.cache.values()];
  }
  /** modelgw models() 同构：同步集合面（读的是最近一次快照；目录面先 await ensureCatalog）。 */
  models() {
    const self = this;
    return {
      all: () => self.snapshot(),
      findOne: (predicate) => self.snapshot().find(predicate),
      get: (id) => self.snapshot().find((item) => item.id === id)
    };
  }
  /** 目录面预拉取（GET /models 用；调用面可跳过——直接按 slug 解析）。 */
  async ensureCatalog() {
    await this.refresh();
    return this.snapshot();
  }
  async resolveTarget(slug) {
    if (slug === "default") {
      const preferred = this.defaultSelection();
      if (preferred) return preferred;
      await this.refresh();
      const first = this.snapshot()[0];
      if (first) {
        const [provider, ...rest] = first.slug.split(":");
        return { provider, model: rest.join(":") };
      }
      throw new Error("dsh \u672A\u914D\u7F6E\u9ED8\u8BA4\u6A21\u578B\u4E14\u6A21\u578B\u76EE\u5F55\u4E3A\u7A7A\uFF08settings.yaml agent-default-model \u6216 llm \u9002\u914D\u5668\u914D\u7F6E\u7F3A\u5931\uFF09");
    }
    await this.refresh();
    const hit = this.cache.get(slug);
    if (hit) {
      const [provider, ...rest] = slug.split(":");
      return { provider, model: rest.join(":") };
    }
    throw new Error(`\u6A21\u578B\u4E0D\u5728 dsh \u6A21\u578B\u76EE\u5F55\u4E2D\uFF1A${slug}\uFF08\u53EF\u5728 dsh \u4FA7\u914D\u7F6E\u540E\u91CD\u8BD5\uFF1B\u9762\u677F\u6A21\u578B\u76EE\u5F55\u7531 dsh \u914D\u7F6E\u6258\u7BA1\uFF09`);
  }
  /** 真实单轮调用：走 ctx.llm.stream 全链（适配器/重试/计量归 dsh），失败如实抛出。 */
  async invoke(input) {
    let content = "";
    let outputTokens = 0;
    let finalModel = "";
    for await (const chunk of this.streamEvents(input)) {
      if (chunk.delta) content += chunk.delta;
      if (chunk.model) finalModel = chunk.model;
      if (chunk.outputTokens) outputTokens = chunk.outputTokens;
    }
    return { model: finalModel, content, outputTokens };
  }
  /**
   * 流式原语（2026-09-11 面板流式应答卡）：逐块转发模型 text-delta；结束块携带
   * finish 信息与最终 model/outputTokens。失败在迭代期如实抛出（调用方已输出的
   * 增量按失败处理：不落库、不发 done——诚实降级语义与 invoke 同规）。
   */
  async *streamEvents(input) {
    const target = await this.resolveTarget(input.model);
    const system = input.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n") || void 0;
    const messages = input.messages.filter((m) => m.role !== "system").map((m) => ({
      id: `pnl_${Math.random().toString(36).slice(2, 12)}`,
      role: m.role === "assistant" ? "assistant" : "user",
      content: [{ type: "text", text: m.content }],
      source: { kind: "plugin", plugin: BRIDGE_PLUGIN_ID }
    }));
    let content = "";
    let outputTokens = 0;
    let finishKind = "stop";
    let failureText = "";
    try {
      for await (const chunk of this.llm.stream({
        provider: target.provider,
        model: target.model,
        messages,
        ...system ? { system } : {},
        ...input.maxTokens !== void 0 ? { maxTokens: input.maxTokens } : {},
        ...input.signal ? { signal: input.signal } : {}
      })) {
        if (chunk.type === "text-delta" && chunk.text) {
          content += chunk.text;
          yield { delta: chunk.text };
        } else if (chunk.type === "usage" && chunk.usage?.outputTokens) {
          outputTokens = chunk.usage.outputTokens;
        } else if (chunk.type === "finish") {
          finishKind = chunk.reason?.kind ?? "stop";
          if (chunk.reason?.failure) {
            failureText = chunk.reason.failure.message ?? chunk.reason.failure.code ?? "\u4E0A\u6E38\u5931\u8D25";
          }
        }
      }
    } catch (error) {
      throw new Error(`dsh \u6A21\u578B\u901A\u9053\u8C03\u7528\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
    }
    if (finishKind === "aborted" || finishKind === "error") {
      throw new Error(`dsh \u6A21\u578B\u901A\u9053\u8C03\u7528\u5931\u8D25\uFF08${finishKind}\uFF09\uFF1A${failureText || "\u4E0A\u6E38\u672A\u8FD4\u56DE\u5185\u5BB9"}`);
    }
    if (!content.trim()) throw new Error("dsh \u6A21\u578B\u901A\u9053\u8FD4\u56DE\u7A7A\u5185\u5BB9\uFF08\u672A\u751F\u6210\u56DE\u590D\uFF0C\u4E0D\u9020\u5047\u56DE\u590D\uFF09");
    yield { model: input.model === "default" ? `${target.provider}:${target.model}` : input.model, outputTokens };
  }
  /** 目录只读：写操作诚实拒绝（配置事实源在 dsh）。 */
  static READ_ONLY_MESSAGE = "\u6A21\u578B\u76EE\u5F55\u7531 dsh \u914D\u7F6E\u6258\u7BA1\uFF08settings.yaml agent-default-model \u4E0E llm \u9002\u914D\u5668\u914D\u7F6E\uFF09\u2014\u201401\u95E8\u9762\u677F\u53EA\u8BFB\uFF0C\u8BF7\u5728 dsh \u4FA7\u589E\u5220\u6539\u6A21\u578B";
  upsertModel() {
    throw new Error(DshModelGateway.READ_ONLY_MESSAGE);
  }
  removeModel() {
    throw new Error(DshModelGateway.READ_ONLY_MESSAGE);
  }
}
function resolvePanelModelGateway(ctx) {
  const modelgw = soft(ctx, "modelGateway");
  if (modelgw) return { kind: "modelgw", gateway: modelgw };
  const llm = asDshLlm(soft(ctx, "llm"));
  if (llm) return { kind: "dsh", gateway: new DshModelGateway(ctx, llm) };
  return void 0;
}
export {
  DshModelGateway,
  resolvePanelModelGateway
};
