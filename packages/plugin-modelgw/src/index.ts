/**
 * @dsh-ops/plugin-modelgw —— L1 模型转售网关（生态设计 v1.2 第 5 步）。
 *
 * 平台统一代理外部模型厂商（OpenAI 兼容 chat/completions 形态）：
 *   调用前预检（余额 + 月度预算，超额拒绝不计费）→ 真实 HTTP 转发 →
 *   usage 计量（input/output tokens 实测值，不伪造）→ billing 经计量管道扣费。
 *
 * 真实化红线（第 0 步原则）：模型未配置真实 endpoint 时调用直接报错，
 * 绝不生成假 completion 充数——演示环境请在目录中配置指向 stub 的 endpoint。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { newId, type Collection, type RecordBase } from '@dsh-ops/platform-core'
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
  listCentsPerKTokens: number
  costCentsPerKTokens: number
  status: 'online' | 'offline'
}

export interface ModelInvokeInput {
  model: string
  messages: Array<{ role: string; content: string }>
  /** 计费组织（钱包扣费主体）。 */
  orgId: string
  /** 最终用户/应用（on-behalf-of 终点）。 */
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
  chargeCents: number
  balanceAfterCents: number
}

const INVOKE_TIMEOUT_MS = 30_000
/** 单次调用预估成本上限（分）：预检口径（预算防超限的第一道闸）。 */
const PRECHECK_ESTIMATE_CENTS = 500

export class ModelGatewayService extends Service {
  static readonly provide = 'modelGateway'

  constructor(ctx: Context) {
    super(ctx, 'modelGateway')
  }

  models(): Collection<ModelRecord> {
    const collection = this.ctx.storage.collection<ModelRecord>('modelgw:models')
    collection.uniqueOn('model_slug', (item) => item.slug)
    return collection
  }

  upsertModel(input: Omit<ModelRecord, 'id' | 'createdAt' | 'updatedAt'>): ModelRecord {
    const existing = this.models().findOne((item) => item.slug === input.slug)
    if (existing) return this.models().update(existing.id, { ...input })
    const created = this.models().insert({ id: newId('mdl'), ...input })
    // 价格簿登记：model:<slug> 按 output_tokens 计价（v1 口径：输出 tokens 承担计费）
    this.ctx.usage.upsertPrice({
      pattern: `model:${input.slug}`,
      meter_key: 'output_tokens',
      list_cents_per_unit: input.listCentsPerKTokens,
      cost_cents_per_unit: input.costCentsPerKTokens,
      units_per_step: 1000,
      tax_rate: 0.06,
      currency: 'CNY',
      rate_version: `model:${input.slug}:v1`,
    })
    return created
  }

  async invoke(input: ModelInvokeInput): Promise<ModelInvokeResult> {
    const model = this.models().findOne((item) => item.slug === input.model)
    if (!model) throw new Error(`模型不存在：${input.model}（请先在模型目录登记）`)
    if (model.status !== 'online') throw new Error(`模型已下线：${model.slug}`)
    if (!model.endpoint) throw new Error(`模型 ${model.slug} 未配置 endpoint，拒绝调用（不生成假 completion）`)

    // 预检：余额 + 月度预算（quota.exceeded 拒绝，不计费）
    const precheck = this.ctx.billing.precheck(input.orgId, PRECHECK_ESTIMATE_CENTS)
    if (!precheck.ok) {
      throw new Error(precheck.reason)
    }

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

    // 计量：input/output tokens 实测值（先计量后返回；扣费由 billing 消费计量事件完成）
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
      chargeCents: event.pricing.charge_cents,
      balanceAfterCents: this.ctx.billing.balance('org', input.orgId),
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
export const inject = ['storage', 'usage', 'billing']

export function apply(ctx: Context) {
  ctx.plugin(ModelGatewayService)
  ctx.plugin(modelgwTools)
}
