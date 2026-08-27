/**
 * @dsh-ops/plugin-usage —— usage 计量管道（生态设计 v1.2 第 2 步）。
 *
 * 全平台唯一的资源消耗计量入口：
 *   资源消耗方（MCP 网关 / 模型网关 / 插件运行时）
 *     → usage.record()（schema v1 校验 → SQLite 先写后发 → platformBus 广播）
 *     → 订阅方（audit 成本归集 / billing 扣费 / market 分成 / 对账引擎）
 *
 * schema 语义（定版 additive-only）：
 *   - usage.recorded schema_version=1：字段只增不改不删；新字段只能以可选形式随 minor 版本加入；
 *   - 消费端必须容忍未知新字段（前向兼容义务）；
 *   - 弃用字段走 platform.schema.deprecated 事件，历史数据不迁移不重算。
 * 投递语义（M8）：at-least-once + 消费端按 idempotency_key 幂等；先落库后分发（宕机不丢）；
 *   消费异常重试 3 次入死信集合并告警；支持按时间窗重放。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { newId, type Collection, type RecordBase } from '../../platform-core/src/index.ts'
import * as usageTools from './tools.ts'

// ---------------------------------------------------------------------------
// schema v1（定版）
// ---------------------------------------------------------------------------

export const USAGE_SCHEMA = 'usage.recorded'
export const USAGE_SCHEMA_VERSION = 1

/** 可扩展计量字典条目：替代固定 token 三件套，L3 自定义计量同结构接入。 */
export interface UsageMeter {
  key: string
  value: number
  unit: string
}

/** 价格快照（计费时点冻结，历史可复算）。 */
export interface UsagePricingSnapshot {
  currency: string
  /** 本事件应收（列表价口径，含税）。 */
  charge_cents: number
  /** 本事件平台成本（口径：L1 采购成本）。 */
  cost_cents: number
  /** 计价明细快照（费率 + 计量键），分账/审计复算依据。 */
  rate: { pattern: string; meter_key: string; list_cents_per_unit: number; cost_cents_per_unit: number; units_per_step: number; tax_rate: number }
}

/** usage.recorded v1 事件（只追加，禁改版；扩展仅允许新增可选字段）。 */
export interface UsageEvent {
  schema: typeof USAGE_SCHEMA
  schema_version: number
  event_id: string
  idempotency_key: string
  trace_id?: string
  occurred_at: string
  tenant_id: string
  org: string
  /** 最终用户/Agent（on-behalf-of 终点）：user:<id> | agent:<id> */
  subject: string
  /** 计费责任主体：org:<id> | plugin:<id> | app:<id> | platform */
  principal: string
  /** 资源：model:<slug> | plugin:<id> | mcp:<slug> | skill:<id> | nas:<id> */
  resource: string
  meters: UsageMeter[]
  pricing: UsagePricingSnapshot
}

/** 计量事件登记入参（schema 校验后由 record() 补全派生字段）。 */
export interface UsageRecordInput {
  org: string
  subject: string
  principal: string
  resource: string
  meters: UsageMeter[]
  tenant_id?: string
  trace_id?: string
  /** 幂等键：调用方自带（推荐，如 <producer>:<业务单号>）；缺省按主体+资源+窗口+序号生成。 */
  idempotency_key?: string
  occurred_at?: string
}

/** 价格簿条目：resource 模式（精确 → 前缀匹配）→ 计量键与费率。 */
export interface PriceBookEntry extends RecordBase {
  pattern: string
  meter_key: string
  list_cents_per_unit: number
  cost_cents_per_unit: number
  units_per_step: number
  tax_rate: number
  currency: string
  /** 费率版本（分录快照引用，历史可复算）。 */
  rate_version: string
}

/** 能力授权登记（M5 运行时对账基线）：market 安装插件时写入。 */
export interface CapabilityGrantRecord extends RecordBase {
  principal: string
  capabilities: string[]
  source: string
}

/** 死信（消费 3 次失败的事件）。 */
export interface DeadLetterRecord extends RecordBase {
  event_id: string
  consumer: string
  error: string
  attempts: number
}

export type UsageConsumer = (event: UsageEvent) => void

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

const DEFAULT_TENANT = 't_default'
const WINDOW_MS = 60_000

export class UsageService extends Service {
  static readonly provide = 'usage'

  private consumers = new Map<string, { handler: UsageConsumer; attempts: Map<string, number> }>()
  private seq = 0

  constructor(ctx: Context) {
    super(ctx, 'usage')
    ctx.txnStore.ensureTable('usage_events', {
      id: 'TEXT',
      idempotency_key: 'TEXT NOT NULL',
      schema_version: 'INTEGER NOT NULL',
      occurred_at: 'TEXT NOT NULL',
      tenant_id: 'TEXT NOT NULL',
      org: "TEXT NOT NULL DEFAULT ''",
      subject: "TEXT NOT NULL DEFAULT ''",
      principal: 'TEXT NOT NULL',
      resource: 'TEXT NOT NULL',
      meters_json: 'TEXT NOT NULL',
      pricing_json: 'TEXT NOT NULL',
      trace_id: "TEXT NOT NULL DEFAULT ''",
    }, { uniques: [['idempotency_key']], indexes: [['occurred_at'], ['principal'], ['tenant_id']] })
    // 消费水位（引擎级幂等）：同一消费方对同一事件只产生一次副作用——
    // replay()/死信重投不会造成 billing/audit 投影双计（评审实证缺陷的修复点）。
    ctx.txnStore.ensureTable('usage_consumptions', {
      consumer: 'TEXT NOT NULL',
      event_id: 'TEXT NOT NULL',
      at: 'TEXT NOT NULL',
    }, { primaryKey: ['consumer', 'event_id'] })
    this.ensureDefaultPriceBook()
  }

  // -- 登记与分发 -----------------------------------------------------------

  /** 全平台唯一计量入口：校验 → 计价 → 落库（幂等）→ 总线分发。 */
  record(input: UsageRecordInput): UsageEvent {
    this.validate(input)
    const tenant = input.tenant_id ?? this.resolveTenant(input.org)
    const price = this.priceOf(input.resource)
    // 硬校验：事件必须携带价格簿计价键（宁可拒绝不可静默 0 计费——
    // 价格簿对调用方不可见（usage.admin），错误信息直接携带期望键供自纠）
    if (!input.meters.some((item) => item.key === price.meter_key)) {
      throw new Error(
        `计量键不匹配：资源 ${input.resource} 按价格簿 ${price.pattern} 以「${price.meter_key}」计价，` +
        `收到 [${input.meters.map((m) => m.key).join(', ')}]。请按 ${price.meter_key} 重报，不要编造计量键`,
      )
    }
    const meter = input.meters.find((item) => item.key === price.meter_key)!
    const charge = Math.round((meter.value / price.units_per_step) * price.list_cents_per_unit)
    const cost = Math.round((meter.value / price.units_per_step) * price.cost_cents_per_unit)
    const event: UsageEvent = {
      schema: USAGE_SCHEMA,
      schema_version: USAGE_SCHEMA_VERSION,
      event_id: newId('uevt'),
      idempotency_key: input.idempotency_key ?? this.autoIdempotencyKey(input),
      ...(input.trace_id !== undefined ? { trace_id: input.trace_id } : {}),
      occurred_at: input.occurred_at ?? new Date().toISOString(),
      tenant_id: tenant,
      org: input.org,
      subject: input.subject,
      principal: input.principal,
      resource: input.resource,
      meters: input.meters,
      pricing: {
        currency: price.currency,
        charge_cents: charge,
        cost_cents: cost,
        rate: {
          pattern: price.pattern,
          meter_key: price.meter_key,
          list_cents_per_unit: price.list_cents_per_unit,
          cost_cents_per_unit: price.cost_cents_per_unit,
          units_per_step: price.units_per_step,
          tax_rate: price.tax_rate,
        },
      },
    }
    const inserted = this.ctx.txnStore.insertOrIgnore('usage_events', usageRow(event))
    if (!inserted) {
      const existing = this.ctx.txnStore.one<UsageRow>('usage_events', { idempotency_key: event.idempotency_key })
      if (!existing) throw new Error(`幂等键异常：${event.idempotency_key} 已占用但记录缺失`)
      const sameContent = existing.org === event.org
        && existing.subject === event.subject
        && existing.principal === event.principal
        && existing.resource === event.resource
        && existing.meters_json === JSON.stringify(event.meters)
      if (!sameContent) {
        throw new Error(`幂等键冲突：${event.idempotency_key} 已绑定事件 ${existing.id}，同键不同内容被拒绝`)
      }
      // 幂等重放：返回既有事件（计价快照以首次登记为准，不随费率变动重算）
      return rowToEvent(existing)
    }
    this.dispatch(event)
    return event
  }

  /** 注册消费方（at-least-once；3 次失败入死信）。 */
  consume(consumerId: string, handler: UsageConsumer): () => void {
    this.consumers.set(consumerId, { handler, attempts: new Map() })
    return () => this.consumers.delete(consumerId)
  }

  /**
   * 分发：at-least-once 语义下的「效果恰好一次」——
   *   1. 先占消费水位（INSERT OR IGNORE）：已消费过的事件直接跳过（replay 幂等）；
   *   2. 处理器失败即释放水位，立即退避重试（真实执行，共 3 次）；
   *   3. 3 次均失败入死信（持久化）并告警，可经 retryDeadLetters() 人工重投。
   */
  private dispatch(event: UsageEvent): void {
    this.ctx.platformBus.emit(USAGE_SCHEMA, event)
    for (const [consumerId, entry] of this.consumers) {
      const claimed = this.ctx.txnStore.insertOrIgnore('usage_consumptions', {
        consumer: consumerId, event_id: event.event_id, at: new Date().toISOString(),
      })
      if (!claimed) continue // 已消费（replay/重投）：幂等跳过
      let delivered = false
      for (let attempt = 1; attempt <= 3 && !delivered; attempt++) {
        try {
          entry.handler(event)
          entry.attempts.delete(`${consumerId}:${event.event_id}`)
          delivered = true
        } catch (error) {
          // 立即重试（同步管道不阻塞事件循环）：瞬时失败最多 3 次真实执行
          if (attempt < 3) continue
          // 释放消费水位，允许人工重投时重新消费
          this.ctx.txnStore.run('DELETE FROM usage_consumptions WHERE consumer = ? AND event_id = ?', [consumerId, event.event_id])
          this.deadLetters().insert({
            id: newId('dlq'), event_id: event.event_id, consumer: consumerId,
            error: error instanceof Error ? error.message : String(error), attempts,
          })
          this.ctx.platformBus.emit('audit.alert.fired', {
            id: newId('alt'), severity: 'critical', title: 'usage 消费死信',
            message: `消费方 ${consumerId} 处理事件 ${event.event_id} 连续失败 ${attempt} 次（含即时重试），已入死信，可通过 usage_deadletter_retry 重投`,
          })
        }
      }
    }
  }

  /** 重放窗口内事件（消费水位保证幂等：重复重放不产生重复副作用）。 */
  replay(sinceIso: string): { replayed: number } {
    const rows = this.ctx.txnStore.sql<UsageRow>(
      'SELECT * FROM usage_events WHERE occurred_at >= ? ORDER BY occurred_at',
      [sinceIso],
    )
    for (const row of rows) this.dispatch(rowToEvent(row))
    return { replayed: rows.length }
  }

  /** 死信重投：逐条重新分发，成功即移出死信队列。返回 {retried, remaining}。 */
  retryDeadLetters(): { retried: number; remaining: number } {
    const letters = this.deadLetters().all()
    let retried = 0
    for (const letter of letters) {
      const row = this.ctx.txnStore.one<UsageRow>('usage_events', { id: letter.event_id })
      if (!row) {
        this.deadLetters().remove(letter.id) // 事件已不存在（清理/过期）：死信一并移除
        continue
      }
      const consumer = this.consumers.get(letter.consumer)
      if (!consumer) continue // 消费方未注册（插件未加载）：保留死信
      this.deadLetters().remove(letter.id)
      try {
        const claimed = this.ctx.txnStore.insertOrIgnore('usage_consumptions', {
          consumer: letter.consumer, event_id: letter.event_id, at: new Date().toISOString(),
        })
        if (!claimed) {
          retried++
          continue
        }
        consumer.handler(rowToEvent(row))
        retried++
      } catch (error) {
        this.deadLetters().insert({
          id: newId('dlq'), event_id: letter.event_id, consumer: letter.consumer,
          error: `重投仍失败：${error instanceof Error ? error.message : String(error)}`, attempts: letter.attempts + 1,
        })
      }
    }
    return { retried, remaining: this.deadLetters().count() }
  }

  // -- 查询 -----------------------------------------------------------------

  query(filter: { tenant_id?: string; principal?: string; resource?: string; from?: string; to?: string; limit?: number } = {}): { total: number; items: UsageEvent[] } {
    const conditions: string[] = []
    const params: Array<string | number> = []
    if (filter.tenant_id) { conditions.push('tenant_id = ?'); params.push(filter.tenant_id) }
    if (filter.principal) { conditions.push('principal = ?'); params.push(filter.principal) }
    if (filter.resource) { conditions.push('resource = ?'); params.push(filter.resource) }
    if (filter.from) { conditions.push('occurred_at >= ?'); params.push(filter.from) }
    if (filter.to) { conditions.push('occurred_at <= ?'); params.push(filter.to) }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.ctx.txnStore.sql<UsageRow>(`SELECT * FROM usage_events${where} ORDER BY occurred_at DESC LIMIT ?`, [...params, Math.min(filter.limit ?? 100, 1000)])
    const total = Number((this.ctx.txnStore.sql<{ n: number }>(`SELECT COUNT(*) AS n FROM usage_events${where}`, params)[0] ?? { n: 0 }).n)
    return { total, items: rows.map(rowToEvent) }
  }

  totals(filter: { tenant_id?: string; principal?: string; from?: string; to?: string } = {}): { count: number; charge_cents: number; cost_cents: number } {
    const conditions: string[] = []
    const params: Array<string | number> = []
    if (filter.tenant_id) { conditions.push('tenant_id = ?'); params.push(filter.tenant_id) }
    if (filter.principal) { conditions.push('principal = ?'); params.push(filter.principal) }
    if (filter.from) { conditions.push('occurred_at >= ?'); params.push(filter.from) }
    if (filter.to) { conditions.push('occurred_at <= ?'); params.push(filter.to) }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    const row = this.ctx.txnStore.sql<{ n: number; charge: number; cost: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(CAST(json_extract(pricing_json, '$.charge_cents') AS INTEGER)), 0) AS charge, COALESCE(SUM(CAST(json_extract(pricing_json, '$.cost_cents') AS INTEGER)), 0) AS cost FROM usage_events${where}`,
      params,
    )[0] ?? { n: 0, charge: 0, cost: 0 }
    return { count: Number(row.n), charge_cents: Number(row.charge), cost_cents: Number(row.cost) }
  }

  /**
   * 运营分析聚合（资产运营页/成本报表）：窗口内按资源 / 计费主体（组织）/ 日趋势分组。
   * 一次 SQL 各取一份聚合，供「谁在用什么资产、花了多少」的运营口径。
   */
  breakdown(fromIso: string): {
    byResource: Array<{ resource: string; count: number; charge_cents: number; cost_cents: number }>
    byPrincipal: Array<{ principal: string; count: number; charge_cents: number }>
    byDay: Array<{ day: string; count: number; charge_cents: number }>
  } {
    const byResource = this.ctx.txnStore.sql<{ resource: string; count: number; charge_cents: number; cost_cents: number }>(
      "SELECT resource, COUNT(*) AS count, COALESCE(SUM(CAST(json_extract(pricing_json, '$.charge_cents') AS INTEGER)), 0) AS charge_cents, COALESCE(SUM(CAST(json_extract(pricing_json, '$.cost_cents') AS INTEGER)), 0) AS cost_cents FROM usage_events WHERE occurred_at >= ? GROUP BY resource ORDER BY charge_cents DESC",
      [fromIso],
    ).map((row) => ({ resource: row.resource, count: Number(row.count), charge_cents: Number(row.charge_cents), cost_cents: Number(row.cost_cents) }))
    const byPrincipal = this.ctx.txnStore.sql<{ principal: string; count: number; charge_cents: number }>(
      "SELECT principal, COUNT(*) AS count, COALESCE(SUM(CAST(json_extract(pricing_json, '$.charge_cents') AS INTEGER)), 0) AS charge_cents FROM usage_events WHERE occurred_at >= ? GROUP BY principal ORDER BY charge_cents DESC",
      [fromIso],
    ).map((row) => ({ principal: row.principal, count: Number(row.count), charge_cents: Number(row.charge_cents) }))
    const byDay = this.ctx.txnStore.sql<{ day: string; count: number; charge_cents: number }>(
      "SELECT substr(occurred_at, 1, 10) AS day, COUNT(*) AS count, COALESCE(SUM(CAST(json_extract(pricing_json, '$.charge_cents') AS INTEGER)), 0) AS charge_cents FROM usage_events WHERE occurred_at >= ? GROUP BY day ORDER BY day",
      [fromIso],
    ).map((row) => ({ day: row.day, count: Number(row.count), charge_cents: Number(row.charge_cents) }))
    return { byResource, byPrincipal, byDay }
  }

  /**
   * 观测矩阵：窗口内指定前缀资源的 资源×日 使用次数（技能热力图等观测视图数据源）。
   * prefix 由调用方以代码字面量传入（如 'skill:'），不进 LIKE 通配符。
   */
  matrix(fromIso: string, prefix: string): Array<{ resource: string; day: string; count: number }> {
    return this.ctx.txnStore.sql<{ resource: string; day: string; count: number }>(
      "SELECT resource, substr(occurred_at, 1, 10) AS day, COUNT(*) AS count FROM usage_events WHERE occurred_at >= ? AND resource LIKE ? GROUP BY resource, day ORDER BY day",
      [fromIso, `${prefix}%`],
    ).map((row) => ({ resource: row.resource, day: String(row.day), count: Number(row.count) }))
  }

  // -- 价格簿 ---------------------------------------------------------------

  priceBook(): Collection<PriceBookEntry> {
    return this.ctx.opsStorage.collection<PriceBookEntry>('usage:priceBook')
  }

  upsertPrice(entry: Omit<PriceBookEntry, 'id' | 'createdAt' | 'updatedAt'>): PriceBookEntry {
    const existing = this.priceBook().findOne((item) => item.pattern === entry.pattern)
    if (existing) return this.priceBook().update(existing.id, { ...entry })
    return this.priceBook().insert({ id: newId('rate'), ...entry })
  }

  private priceOf(resource: string): PriceBookEntry {
    const book = this.priceBook().all()
    const exact = book.find((item) => item.pattern === resource)
    if (exact) return exact
    const prefix = book.filter((item) => item.pattern.endsWith(':*')).sort((a, b) => b.pattern.length - a.pattern.length)
      .find((item) => resource.startsWith(item.pattern.slice(0, -1)))
    if (prefix) return prefix
    throw new Error(`资源 ${resource} 无计价规则：请先在价格簿登记（usage 价格簿）`)
  }

  private ensureDefaultPriceBook(): void {
    // 逐条幂等播种：存量部署升级时只补缺失的默认规则，不覆盖运营已改过的费率
    const defaults: Array<Omit<PriceBookEntry, 'id' | 'createdAt' | 'updatedAt'>> = [
      { pattern: 'mcp:*', meter_key: 'tokens', list_cents_per_unit: 30, cost_cents_per_unit: 15, units_per_step: 1000, tax_rate: 0.06, currency: 'CNY', rate_version: 'v2026.08' },
      { pattern: 'platform:*', meter_key: 'calls', list_cents_per_unit: 0, cost_cents_per_unit: 0, units_per_step: 1, tax_rate: 0.06, currency: 'CNY', rate_version: 'v2026.08' },
      // 观测补齐：skill/nas 先零费率采集（价格簿有规则即可入管道），是否计费由运营调价决定
      { pattern: 'skill:*', meter_key: 'calls', list_cents_per_unit: 0, cost_cents_per_unit: 0, units_per_step: 1, tax_rate: 0.06, currency: 'CNY', rate_version: 'v2026.08' },
      { pattern: 'nas:*', meter_key: 'calls', list_cents_per_unit: 0, cost_cents_per_unit: 0, units_per_step: 1, tax_rate: 0.06, currency: 'CNY', rate_version: 'v2026.08' },
      // 连接器纳管（open-connector 融合）：同上零费率起步；record() 硬校验要求有规则方可入管道，
      // 运营按需把特定 connector:<provider> 调整为非零费率（dev-plan-connector §2.6）
      { pattern: 'connector:*', meter_key: 'calls', list_cents_per_unit: 0, cost_cents_per_unit: 0, units_per_step: 1, tax_rate: 0.06, currency: 'CNY', rate_version: 'v2026.08' },
    ]
    for (const entry of defaults) {
      if (!this.priceBook().findOne((item) => item.pattern === entry.pattern)) this.upsertPrice(entry)
    }
  }

  // -- 对账（三方口径比对） -----------------------------------------------

  /**
   * 对账：usage 口径（事件流水）vs 已登记消费方投影口径，全量比对。
   * 消费方通过 consume() 挂载时同步登记投影集合 usage:projection:<consumerId>。
   */
  reconcile(windowFromIso?: string): {
    usage: { count: number; charge_cents: number }
    projections: Array<{ consumer: string; count: number; charge_cents: number; mismatch: boolean }>
    mismatch: boolean
  } {
    const usageTotals = this.totals(windowFromIso ? { from: windowFromIso } : {})
    const projections: Array<{ consumer: string; count: number; charge_cents: number; mismatch: boolean }> = []
    for (const consumerId of this.consumers.keys()) {
      const rows = this.ctx.opsStorage.collection<ProjectionRow>(`usage:projection:${consumerId}`).all()
        .filter((row) => (windowFromIso ? row.window >= windowFromIso.slice(0, 10) : true))
      const count = rows.reduce((sum, row) => sum + row.count, 0)
      const charge = rows.reduce((sum, row) => sum + row.charge_cents, 0)
      projections.push({
        consumer: consumerId,
        count,
        charge_cents: charge,
        mismatch: count !== usageTotals.count || charge !== usageTotals.charge_cents,
      })
    }
    const mismatch = projections.some((item) => item.mismatch)
    if (mismatch) {
      this.ctx.platformBus.emit('audit.alert.fired', {
        id: newId('alt'), severity: 'critical', title: 'usage 对账不平',
        message: `usage 口径 count=${usageTotals.count} charge=${usageTotals.charge_cents} 分；消费方投影存在偏差：${JSON.stringify(projections)}`,
      })
    }
    return { usage: { count: usageTotals.count, charge_cents: usageTotals.charge_cents }, projections, mismatch }
  }

  /** 消费方投影累加（供 consume() 回调内部调用）。 */
  project(consumerId: string, event: UsageEvent): void {
    const collection = this.ctx.opsStorage.collection<ProjectionRow>(`usage:projection:${consumerId}`)
    const day = event.occurred_at.slice(0, 10)
    const existing = collection.findOne((row) => row.window === day)
    if (existing) {
      collection.update(existing.id, { count: existing.count + 1, charge_cents: existing.charge_cents + event.pricing.charge_cents })
    } else {
      collection.insert({ id: newId('prj'), window: day, count: 1, charge_cents: event.pricing.charge_cents })
    }
  }

  // -- 运行时对账（M5：声明 vs 行为） --------------------------------------

  capabilityGrants(): Collection<CapabilityGrantRecord> {
    return this.ctx.opsStorage.collection<CapabilityGrantRecord>('usage:capabilityGrants')
  }

  grantCapabilities(principal: string, capabilities: string[], source: string): CapabilityGrantRecord {
    const existing = this.capabilityGrants().findOne((item) => item.principal === principal)
    if (existing) return this.capabilityGrants().update(existing.id, { capabilities, source })
    return this.capabilityGrants().insert({ id: newId('cap'), principal, capabilities, source })
  }

  /** 能力漂移检测：窗口内实际消耗的资源 vs 声明授权；未声明的实际消耗即告警。 */
  capabilityDrift(sinceIso?: string): { drift: Array<{ principal: string; consumed: string[]; granted: string[]; ungranted: string[] }> } {
    const { items } = this.query({ from: sinceIso, limit: 1000 })
    const consumedByPrincipal = new Map<string, Set<string>>()
    for (const event of items) {
      const set = consumedByPrincipal.get(event.principal) ?? new Set<string>()
      set.add(event.resource)
      consumedByPrincipal.set(event.principal, set)
    }
    const drift: Array<{ principal: string; consumed: string[]; granted: string[]; ungranted: string[] }> = []
    for (const [principal, consumedSet] of consumedByPrincipal) {
      const grant = this.capabilityGrants().findOne((item) => item.principal === principal)
      const granted = grant?.capabilities ?? []
      const ungranted = [...consumedSet].filter((resource) => !granted.some((cap) =>
        cap === '*' || cap === resource || (cap.endsWith(':*') && resource.startsWith(cap.slice(0, -1))),
      ))
      if (ungranted.length > 0) {
        drift.push({ principal, consumed: [...consumedSet], granted, ungranted })
        this.ctx.platformBus.emit('audit.alert.fired', {
          id: newId('alt'), severity: 'critical', title: 'usage 能力漂移',
          message: `主体 ${principal} 实际消耗了未声明授权的资源：${ungranted.join(', ')}（运行时对账 M5）`,
          resourceType: 'usage_capability', resourceId: principal,
        })
      }
    }
    return { drift }
  }

  deadLetters(): Collection<DeadLetterRecord> {
    return this.ctx.opsStorage.collection<DeadLetterRecord>('usage:deadLetters')
  }

  // -- 内部 -----------------------------------------------------------------

  private validate(input: UsageRecordInput): void {
    if (!input.org?.trim()) throw new Error('usage 事件 org 必填')
    if (!input.subject?.trim()) throw new Error('usage 事件 subject 必填（user:<id> / agent:<id>）')
    if (!input.principal?.trim()) throw new Error('usage 事件 principal 必填（org:<id> / plugin:<id> / platform）')
    if (!input.resource?.trim() || !/^[a-z]+:[A-Za-z0-9._-]+$/.test(input.resource)) {
      throw new Error(`usage 事件 resource 格式非法：${input.resource}（应为 model:<slug> / mcp:<slug> / plugin:<id> / skill:<id> / nas:<id>）`)
    }
    if (!Array.isArray(input.meters) || input.meters.length === 0) throw new Error('usage 事件 meters 至少一项')
    for (const meter of input.meters) {
      if (!meter.key || !/^[a-z][a-z0-9_.]*$/.test(meter.key)) throw new Error(`计量键非法：${meter.key}（^[a-z][a-z0-9_.]*$）`)
      if (!Number.isFinite(meter.value) || meter.value < 0) throw new Error(`计量值非法：${meter.key}=${meter.value}`)
    }
  }

  /** 租户解析：org → tenant（多租户最小集，v1.2 第 2 步）。 */
  private resolveTenant(orgId: string): string {
    if (!orgId || orgId === '') return DEFAULT_TENANT
    return this.ctx.iam.orgs().get(orgId)?.tenantId ?? DEFAULT_TENANT
  }

  private autoIdempotencyKey(input: UsageRecordInput): string {
    const window = new Date().toISOString().slice(0, 16)
    return `usage:${input.principal}:${input.resource}:${window}:${++this.seq}`
  }
}

interface ProjectionRow extends RecordBase {
  window: string
  count: number
  charge_cents: number
}

interface UsageRow {
  id: string
  idempotency_key: string
  schema_version: number
  occurred_at: string
  tenant_id: string
  org: string
  subject: string
  principal: string
  resource: string
  meters_json: string
  pricing_json: string
  trace_id: string
}

function usageRow(event: UsageEvent): Record<string, string | number> {
  return {
    id: event.event_id,
    idempotency_key: event.idempotency_key,
    schema_version: event.schema_version,
    occurred_at: event.occurred_at,
    tenant_id: event.tenant_id,
    org: event.org,
    subject: event.subject,
    principal: event.principal,
    resource: event.resource,
    meters_json: JSON.stringify(event.meters),
    pricing_json: JSON.stringify(event.pricing),
    trace_id: event.trace_id ?? '',
  }
}

function rowToEvent(row: UsageRow): UsageEvent {
  return {
    schema: USAGE_SCHEMA,
    schema_version: row.schema_version,
    event_id: row.id,
    idempotency_key: row.idempotency_key,
    ...(row.trace_id !== '' ? { trace_id: row.trace_id } : {}),
    occurred_at: row.occurred_at,
    tenant_id: row.tenant_id,
    org: row.org,
    subject: row.subject,
    principal: row.principal,
    resource: row.resource,
    meters: JSON.parse(row.meters_json) as UsageMeter[],
    pricing: JSON.parse(row.pricing_json) as UsagePricingSnapshot,
  }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    usage: UsageService
  }
}

export const name = 'usage'
export const inject = ['opsStorage', 'platformBus', 'txnStore', 'iam']

export function apply(ctx: Context) {
  ctx.plugin(UsageService)
  ctx.plugin(usageTools)
}
