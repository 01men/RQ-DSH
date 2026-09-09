/**
 * @dsh-ops/plugin-modelgw —— 统一模型接入网关（用量透明计量版，榕器开发计划 M0-3）。
 *
 * 平台统一代理外部模型厂商（OpenAI 兼容 chat/completions 形态）：
 *   真实 HTTP 转发 → usage 计量（input/output tokens 实测值，不伪造）→
 *   零价快照入账（charge_cents=0，不对外呈现任何金额结算语义）+ 内部采购成本参考（成本穿透报表口径）。
 *
 * 商业模式（M0 收敛）：私有化年费 + 治理包——网关不再做「转售/预检/扣费」，
 * 价格簿仅内部成本参考（cost_cents_per_unit），list 侧恒零价。
 *
 * 真实化红线（第 0 步原则）：模型未配置真实 endpoint 时调用直接报错，
 * 绝不生成假 completion 充数——演示环境请在目录中配置指向 stub 的 endpoint。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { newId, type Collection, type RecordBase } from '../../platform-core/src/index.ts'
import * as modelgwTools from './tools.ts'

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

export interface ModelRecord extends RecordBase {
  slug: string
  displayName: string
  provider: string
  /** OpenAI 兼容基址（如 https://api.deepseek.com/v1）；未配置则不可调用。 */
  endpoint: string
  /** API Key（仅存引用名，真实密钥经环境变量注入；测试可直填 stub key）。 */
  apiKey: string
  /** 内部采购成本参考（分/千 tokens）：仅用于成本穿透报表，不对外呈现金额结算。 */
  costCentsPerKTokens: number
  status: 'online' | 'offline'
}

export interface ModelInvokeInput {
  model: string
  messages: Array<{ role: string; content: string }>
  /** 用量归口组织（部门维度报表口径）。 */
  orgId: string
  /** 最终用户/Agent（on-behalf-of 终点）。 */
  subject: string
  tenantId?: string
  maxTokens?: number
  temperature?: number
}

export interface ModelInvokeResult {
  ok: true
  content: string
  model: string
  inputTokens: number
  outputTokens: number
  /** 内部成本参考（分，按实测 output tokens 折算；仅报表口径，不参与任何结算）。 */
  costCents: number
}

const INVOKE_TIMEOUT_MS = 30_000

export class ModelGatewayService extends Service {
  static readonly provide = 'modelGateway'

  constructor(ctx: Context) {
    super(ctx, 'modelGateway')
  }

  models(): Collection<ModelRecord> {
    const collection = this.ctx.opsStorage.collection<ModelRecord>('modelgw:models')
    collection.uniqueOn('model_slug', (item) => item.slug)
    return collection
  }

  upsertModel(input: Omit<ModelRecord, 'id' | 'createdAt' | 'updatedAt'>): ModelRecord {
    const existing = this.models().findOne((item) => item.slug === input.slug)
    if (existing) return this.models().update(existing.id, { ...input })
    const created = this.models().insert({ id: newId('mdl'), ...input })
    // 价格簿登记：model:<slug> 按 output_tokens 计量——list 恒零价（不对外结算），
    // cost 为内部采购成本参考（成本穿透报表口径）
    this.ctx.usage.upsertPrice({
      pattern: `model:${input.slug}`,
      meter_key: 'output_tokens',
      list_cents_per_unit: 0,
      cost_cents_per_unit: input.costCentsPerKTokens,
      units_per_step: 1000,
      tax_rate: 0.06,
      currency: 'CNY',
      rate_version: `model:${input.slug}:cost-v1`,
    })
    return created
  }

  async invoke(input: ModelInvokeInput): Promise<ModelInvokeResult> {
    const model = this.models().findOne((item) => item.slug === input.model)
    if (!model) throw new Error(`模型不存在：${input.model}（请先在模型目录登记）`)
    if (model.status !== 'online') throw new Error(`模型已下线：${model.slug}`)
    if (!model.endpoint) throw new Error(`模型 ${model.slug} 未配置 endpoint，拒绝调用（不生成假 completion）`)

    const apiKey = model.apiKey.startsWith('env:') ? (process.env[model.apiKey.slice(4)] ?? '') : model.apiKey
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), INVOKE_TIMEOUT_MS)
    let payload: {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    try {
      const response = await fetch(`${model.endpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const text = (await response.text()).slice(0, 300)
        throw new Error(`模型上游 HTTP ${response.status}：${text}`)
      }
      payload = (await response.json()) as typeof payload
    } catch (error) {
      const message = error instanceof Error ? (error.name === 'AbortError' ? `模型调用超时（${INVOKE_TIMEOUT_MS}ms）` : error.message) : String(error)
      throw new Error(message)
    } finally {
      clearTimeout(timer)
    }
    const content = payload.choices?.[0]?.message?.content ?? ''
    const inputTokens = payload.usage?.prompt_tokens ?? 0
    const outputTokens = payload.usage?.completion_tokens ?? 0

    // 计量：input/output tokens 实测值（先计量后返回）；零价快照入账（charge=0），
    // cost 按内部成本参考折算，供成本穿透报表
    const event = this.ctx.usage.record({
      org: input.orgId,
      subject: input.subject,
      principal: `org:${input.orgId}`,
      resource: `model:${model.slug}`,
      ...(input.tenantId !== undefined ? { tenant_id: input.tenantId } : {}),
      meters: [
        { key: 'input_tokens', value: inputTokens, unit: 'token' },
        { key: 'output_tokens', value: outputTokens, unit: 'token' },
      ],
      idempotency_key: `modelgw:${newId('mi')}`,
    })

    return {
      ok: true,
      content,
      model: model.slug,
      inputTokens,
      outputTokens,
      costCents: event.pricing.cost_cents,
    }
  }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelGateway: ModelGatewayService
  }
}

export const name = 'modelgw'
export const inject = ['opsStorage', 'usage']

export function apply(ctx: Context) {
  ctx.plugin(ModelGatewayService)
  ctx.plugin(modelgwTools)
}
