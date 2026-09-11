/**
 * dsh 模型桥（01门装态模型面兜底）：modelgw 缺席但 dsh 宿主在（提供 ctx.llm LlmRuntime）时，
 * 把面板模型面/Agent 调用落到 dsh 已配置的模型（settings.yaml agent-default-model + llm 适配器路由）。
 *
 * 动机（2026-09-11 用户实测）：01门 4-entry 装态无 modelgw，「更多-模型配置」永远 503 降级、
 * @Agent 永远转人工——用户在 dsh 默认配置里配好的模型（dsh 原生对话可用）面板却用不上。
 * 本桥让「dsh 配置 = 面板模型目录」同源：目录只读（增删改诚实拒绝，配置事实源在 dsh），
 * 测试/调用走 ctx.llm.stream 真实出站，绝不造假回复。
 *
 * 边界：ctx.llm 缺席（纯独立平台形态）→ createDshModelGateway 返回 null，行为与旧版完全一致；
 * modelgw 在场（全量形态）→ 优先用 modelgw，本桥不参与。目录条目 slug 形态 provider:model，
 * 另有合成 slug 'default' 跟随 dsh 默认模型选择（agentDefaultModel.read()，缺席时取首个可用路由）。
 */
import type { Context } from '@deepseek-ai/cordis'

/** dsh LlmRuntime 最小结构（不依赖 dsh 包；运行期形状断言）。 */
interface DshLlmLike {
  listProviders(): Array<{ id: string; name: string }>
  listModels(provider: string): Promise<Array<{ id: string; name: string; description?: string }>>
  stream(options: {
    provider: string
    model: string
    messages: Array<{ id: string; role: 'user' | 'assistant'; content: Array<{ type: 'text'; text: string }>; source: { kind: 'plugin'; plugin: string } }>
    system?: string
    maxTokens?: number
    signal?: AbortSignal
  }): AsyncIterable<{
    type: 'block-start' | 'text-delta' | 'reasoning-delta' | 'tool-call-delta' | 'block-end' | 'usage' | 'finish'
    text?: string
    usage?: { outputTokens?: number }
    reason?: { kind: string; failure?: { message?: string; code?: string } }
  }>
}

interface DshDefaultModelLike {
  read(): { provider: string; model: string }
}

/** 桥目录条目（与 modelgw ModelRecord 字面对齐，面板/服务零特判消费）。 */
export interface BridgedModelRecord {
  id: string
  slug: string
  displayName: string
  provider: string
  endpoint: string
  apiKey: string
  listCentsPerKTokens: number
  costCentsPerKTokens: number
  status: 'online'
  managedBy: 'dsh'
}

export interface BridgedInvokeInput {
  model: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  maxTokens?: number
  signal?: AbortSignal
}

export interface BridgedInvokeResult {
  model: string
  content: string
  outputTokens: number
}

const BRIDGE_PLUGIN_ID = '@ybkk/gate-01/panel-core'

/** 软读 dsh 宿主服务（与 service.ts soft 同规；缺席 = undefined）。 */
const soft = (ctx: Context, key: string): any => {
  try {
    return ctx.reflect.get(key, false)
  } catch {
    return undefined
  }
}

/** 形状断言：ctx.llm 必须长出 listProviders/stream 才算 dsh 模型面在场。 */
const asDshLlm = (value: unknown): DshLlmLike | undefined => {
  const candidate = value as DshLlmLike | undefined
  if (!candidate || typeof candidate.listProviders !== 'function' || typeof candidate.stream !== 'function') return undefined
  return candidate
}

export class DshModelGateway {
  /** modelgw 同款集合面：all/findOne/get——桥目录按需惰性发现，findone 走缓存快照。 */
  private cache = new Map<string, BridgedModelRecord>()
  private cacheAt = 0
  private readonly ttlMs = 30_000
  private inflight: Promise<void> | undefined

  private readonly ctx: Context
  private readonly llm: DshLlmLike

  constructor(ctx: Context, llm: DshLlmLike) {
    this.ctx = ctx
    this.llm = llm
  }

  private defaultSelection(): { provider: string; model: string } | undefined {
    const adm = soft(this.ctx, 'agentDefaultModel') as DshDefaultModelLike | undefined
    try {
      const read = adm?.read?.()
      if (read?.provider && read?.model) return { provider: read.provider, model: read.model }
    } catch { /* 默认模型服务缺席/读取失败 → 回落首个可用路由 */ }
    return undefined
  }

  /** 目录快照：default（若可解析）+ 全部 provider 的已发现模型。发现失败的路由诚实跳过。 */
  private async refresh(): Promise<void> {
    if (Date.now() - this.cacheAt < this.ttlMs) return
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      const next = new Map<string, BridgedModelRecord>()
      const put = (provider: string, model: string, name?: string) => {
        const slug = `${provider}:${model}`
        if (next.has(slug)) return
        next.set(slug, {
          id: `dshmdl_${slug.replace(/[^A-Za-z0-9]/g, '_')}`,
          slug,
          displayName: name ?? model,
          provider,
          endpoint: '（dsh 内置通道，无需登记）',
          apiKey: 'env:DSH_MANAGED',
          listCentsPerKTokens: 0,
          costCentsPerKTokens: 0,
          status: 'online',
          managedBy: 'dsh',
        })
      }
      const preferred = this.defaultSelection()
      if (preferred) put(preferred.provider, preferred.model)
      let providers: Array<{ id: string; name: string }> = []
      try {
        providers = this.llm.listProviders() ?? []
      } catch { /* 注册表读取失败 → 目录为空，诚实呈现 */ }
      for (const provider of providers) {
        try {
          const models = await this.llm.listModels(provider.id)
          for (const model of models ?? []) put(provider.id, model.id, model.name)
        } catch { /* 单路由发现失败不拖垮目录 */ }
      }
      this.cache = next
      this.cacheAt = Date.now()
    })().finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  private snapshot(): BridgedModelRecord[] {
    return [...this.cache.values()]
  }

  /** modelgw models() 同构：同步集合面（读的是最近一次快照；目录面先 await ensureCatalog）。 */
  models() {
    const self = this
    return {
      all: (): BridgedModelRecord[] => self.snapshot(),
      findOne: (predicate: (item: BridgedModelRecord) => boolean): BridgedModelRecord | undefined =>
        self.snapshot().find(predicate),
      get: (id: string): BridgedModelRecord | undefined => self.snapshot().find((item) => item.id === id),
    }
  }

  /** 目录面预拉取（GET /models 用；调用面可跳过——直接按 slug 解析）。 */
  async ensureCatalog(): Promise<BridgedModelRecord[]> {
    await this.refresh()
    return this.snapshot()
  }

  private async resolveTarget(slug: string): Promise<{ provider: string; model: string }> {
    if (slug === 'default') {
      const preferred = this.defaultSelection()
      if (preferred) return preferred
      // 默认模型未配置/不可解析 → 回落目录首个条目（目录序：已配置默认优先，其后按 provider 枚举序）
      await this.refresh()
      const first = this.snapshot()[0]
      if (first) {
        const [provider, ...rest] = first.slug.split(':')
        return { provider: provider!, model: rest.join(':') }
      }
      throw new Error('dsh 未配置默认模型且模型目录为空（settings.yaml agent-default-model 或 llm 适配器配置缺失）')
    }
    await this.refresh()
    const hit = this.cache.get(slug)
    if (hit) {
      const [provider, ...rest] = slug.split(':')
      return { provider: provider!, model: rest.join(':') }
    }
    throw new Error(`模型不在 dsh 模型目录中：${slug}（可在 dsh 侧配置后重试；面板模型目录由 dsh 配置托管）`)
  }

  /** 真实单轮调用：走 ctx.llm.stream 全链（适配器/重试/计量归 dsh），失败如实抛出。 */
  async invoke(input: BridgedInvokeInput): Promise<BridgedInvokeResult> {
    let content = ''
    let outputTokens = 0
    let finalModel = ''
    for await (const chunk of this.streamEvents(input)) {
      if (chunk.delta) content += chunk.delta
      if (chunk.model) finalModel = chunk.model
      if (chunk.outputTokens) outputTokens = chunk.outputTokens
    }
    return { model: finalModel, content, outputTokens }
  }

  /**
   * 流式原语（2026-09-11 面板流式应答卡）：逐块转发模型 text-delta；结束块携带
   * finish 信息与最终 model/outputTokens。失败在迭代期如实抛出（调用方已输出的
   * 增量按失败处理：不落库、不发 done——诚实降级语义与 invoke 同规）。
   */
  async *streamEvents(input: BridgedInvokeInput): AsyncIterable<{ delta?: string; model?: string; outputTokens?: number }> {
    const target = await this.resolveTarget(input.model)
    const system = input.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n') || undefined
    const messages = input.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        id: `pnl_${Math.random().toString(36).slice(2, 12)}`,
        role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
        content: [{ type: 'text' as const, text: m.content }],
        source: { kind: 'plugin' as const, plugin: BRIDGE_PLUGIN_ID },
      }))
    let content = ''
    let outputTokens = 0
    let finishKind = 'stop'
    let failureText = ''
    try {
      for await (const chunk of this.llm.stream({
        provider: target.provider,
        model: target.model,
        messages,
        ...(system ? { system } : {}),
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      })) {
        if (chunk.type === 'text-delta' && chunk.text) {
          content += chunk.text
          yield { delta: chunk.text }
        } else if (chunk.type === 'usage' && chunk.usage?.outputTokens) {
          outputTokens = chunk.usage.outputTokens
        } else if (chunk.type === 'finish') {
          finishKind = chunk.reason?.kind ?? 'stop'
          if (chunk.reason?.failure) {
            failureText = chunk.reason.failure.message ?? chunk.reason.failure.code ?? '上游失败'
          }
        }
      }
    } catch (error) {
      throw new Error(`dsh 模型通道调用失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (finishKind === 'aborted' || finishKind === 'error') {
      throw new Error(`dsh 模型通道调用失败（${finishKind}）：${failureText || '上游未返回内容'}`)
    }
    if (!content.trim()) throw new Error('dsh 模型通道返回空内容（未生成回复，不造假回复）')
    yield { model: input.model === 'default' ? `${target.provider}:${target.model}` : input.model, outputTokens }
  }

  /** 目录只读：写操作诚实拒绝（配置事实源在 dsh）。 */
  private static readonly READ_ONLY_MESSAGE =
    '模型目录由 dsh 配置托管（settings.yaml agent-default-model 与 llm 适配器配置）——01门面板只读，请在 dsh 侧增删改模型'

  upsertModel(): never {
    throw new Error(DshModelGateway.READ_ONLY_MESSAGE)
  }

  removeModel(): never {
    throw new Error(DshModelGateway.READ_ONLY_MESSAGE)
  }
}

/**
 * 解析面板模型网关：modelgw 在场优先（全量形态语义不变）；否则 dsh llm 在场时落桥；
 * 两者皆缺席（纯独立演示态）返回 null——调用方走既有 503 诚实降级。
 */
export function resolvePanelModelGateway(ctx: Context): { kind: 'modelgw' | 'dsh'; gateway: any } | undefined {
  const modelgw = soft(ctx, 'modelGateway')
  if (modelgw) return { kind: 'modelgw', gateway: modelgw }
  const llm = asDshLlm(soft(ctx, 'llm'))
  if (llm) return { kind: 'dsh', gateway: new DshModelGateway(ctx, llm) }
  return undefined
}
