/**
 * @dsh-ops/plugin-billing —— 钱包 / 资金流水 / 复式分账（生态设计 v1.2 第 5/8 步）。
 *
 * 资金底线（S2/M4 消解）：
 *   - wallet_journal 只追加（服务层不暴露 UPDATE/DELETE），幂等键引擎级唯一；
 *   - 余额与流水同事务（BEGIN IMMEDIATE）：扣费失败整体回滚，不存在「流水未记余额已动」；
 *   - 余额恒等式 余额 = Σ(credit) - Σ(debit)，verifyIntegrity() 全量重放校验（selftest 断言）；
 *   - 第 8 步：事件进计量流水（实时）→ 按账期汇总结转复式分录（一借多贷复合分录）；
 *     冲正=红字（负数）分录引用原分录；金额一律整数最小货币单位（分）；费率版本随分录快照。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { PlatformEvents, newId, type Collection, type RecordBase, type SqlValue } from '../../platform-core/src/index.ts'
import type { UsageEvent } from '../../plugin-usage/src/index.ts'
import * as billingTools from './tools.ts'

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

export type WalletOwnerType = 'org' | 'developer' | 'platform'

export interface WalletJournalRow {
  id: string
  idempotency_key: string
  at: string
  tenant_id: string
  owner_type: string
  owner_id: string
  direction: 'credit' | 'debit'
  amount_cents: number
  reason: string
  ref_event: string
  balance_after_cents: number
}

export interface LedgerEntryRow {
  id: string
  period: string
  at: string
  journal_type: string
  ref: string
  account: string
  direction: 'debit' | 'credit'
  amount_cents: number
  memo: string
  rate_version: string
}

export interface BudgetRecord extends RecordBase {
  orgId: string
  /** 月度预算（分）。 */
  monthlyCents: number
  updatedBy: string
}

/** 平台默认分账费率（commission: platform_default 的版本化取值；历史分录快照可复算）。 */
export const COMMISSION_RATES: Record<string, { developerShare: number; version: string }> = {
  platform_default: { developerShare: 0.2, version: 'v2026.08' },
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class BillingService extends Service {
  static readonly provide = 'billing'

  constructor(ctx: Context) {
    super(ctx, 'billing')
    ctx.txnStore.ensureTable('wallets', {
      owner_type: 'TEXT NOT NULL',
      owner_id: 'TEXT NOT NULL',
      tenant_id: "TEXT NOT NULL DEFAULT 't_default'",
      balance_cents: 'INTEGER NOT NULL DEFAULT 0',
      updated_at: 'TEXT NOT NULL',
    }, { primaryKey: ['owner_type', 'owner_id'] })
    ctx.txnStore.ensureTable('wallet_journal', {
      id: 'TEXT',
      idempotency_key: 'TEXT NOT NULL',
      at: 'TEXT NOT NULL',
      tenant_id: "TEXT NOT NULL DEFAULT 't_default'",
      owner_type: 'TEXT NOT NULL',
      owner_id: 'TEXT NOT NULL',
      direction: 'TEXT NOT NULL',
      amount_cents: 'INTEGER NOT NULL',
      reason: 'TEXT NOT NULL',
      ref_event: "TEXT NOT NULL DEFAULT ''",
      balance_after_cents: 'INTEGER NOT NULL',
    }, { uniques: [['idempotency_key']], indexes: [['owner_type', 'owner_id'], ['at']] })
    ctx.txnStore.ensureTable('ledger_entries', {
      id: 'TEXT',
      period: 'TEXT NOT NULL',
      at: 'TEXT NOT NULL',
      journal_type: 'TEXT NOT NULL',
      ref: "TEXT NOT NULL DEFAULT ''",
      account: 'TEXT NOT NULL',
      direction: 'TEXT NOT NULL',
      amount_cents: 'INTEGER NOT NULL',
      memo: "TEXT NOT NULL DEFAULT ''",
      rate_version: "TEXT NOT NULL DEFAULT ''",
    }, { primaryKey: ['id'], indexes: [['period'], ['account']] })

    // 计费口径消费：usage.recorded → org 钱包扣费（幂等键=事件幂等键，重复投递不重复扣）
    ctx.usage.consume('billing', (event) => {
      ctx.usage.project('billing', event)
      if (!event.principal.startsWith('org:')) return // 开发者/平台主体的分账走账期结转，不实时扣钱包
      try {
        this.charge({
          ownerType: 'org',
          ownerId: event.principal.slice(4),
          tenantId: event.tenant_id,
          amountCents: event.pricing.charge_cents,
          reason: `用量扣费 ${event.resource}`,
          refEvent: event.event_id,
          idempotencyKey: `wallet-charge:${event.idempotency_key}`,
        })
      } catch (error) {
        // 事后扣费失败（余额不足/预算外）→ 欠费告警，计量不回滚（先服务后结算语义由预检兜底）
        ctx.platformBus.emit(PlatformEvents.AlertFired, {
          id: newId('alt'), severity: 'critical', title: '钱包扣费失败（欠费）',
          message: `主体 ${event.principal} 扣费 ${event.pricing.charge_cents} 分失败：${error instanceof Error ? error.message : String(error)}`,
          resourceType: 'wallet', resourceId: event.principal,
        })
      }
    })
  }

  budgets(): Collection<BudgetRecord> {
    const collection = this.ctx.storage.collection<BudgetRecord>('billing:budgets')
    collection.uniqueOn('budget_org', (item) => item.orgId)
    return collection
  }

  // -- 钱包 ---------------------------------------------------------------

  balance(ownerType: WalletOwnerType, ownerId: string): number {
    const row = this.ctx.txnStore.one<{ balance_cents: number }>('wallets', { owner_type: ownerType, owner_id: ownerId })
    return Number(row?.balance_cents ?? 0)
  }

  /** 充值（credit）：幂等键=渠道单号；资金通道未就位时由管理员手工录入（v1.2 §六过渡形态）。 */
  recharge(input: { ownerType: WalletOwnerType; ownerId: string; tenantId?: string; amountCents: number; channelRef: string; idempotencyKey: string; actor?: string }): { balanceCents: number; journalId: string; duplicated: boolean } {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new Error('充值金额必须为正整数（分）')
    const existing = this.requireJournalForKey(input.idempotencyKey, input.ownerType, input.ownerId)
    if (existing) return { balanceCents: this.balance(input.ownerType, input.ownerId), journalId: existing.id, duplicated: true }
    const journalId = newId('wjr')
    const tenant = input.tenantId ?? 't_default'
    const result = this.ctx.txnStore.txn((): { balance: number } => {
      const current = this.balance(input.ownerType, input.ownerId)
      const next = current + input.amountCents
      this.ctx.txnStore.run(
        'INSERT OR IGNORE INTO wallets (owner_type, owner_id, tenant_id, balance_cents, updated_at) VALUES (?, ?, ?, ?, ?)',
        [input.ownerType, input.ownerId, tenant, next, new Date().toISOString()],
      )
      this.ctx.txnStore.run(
        'UPDATE wallets SET balance_cents = ?, updated_at = ? WHERE owner_type = ? AND owner_id = ?',
        [next, new Date().toISOString(), input.ownerType, input.ownerId],
      )
      this.ctx.txnStore.insert('wallet_journal', {
        id: journalId,
        idempotency_key: input.idempotencyKey,
        at: new Date().toISOString(),
        tenant_id: tenant,
        owner_type: input.ownerType,
        owner_id: input.ownerId,
        direction: 'credit',
        amount_cents: input.amountCents,
        reason: `充值（${input.channelRef}）${input.actor ? ` by ${input.actor}` : ''}`,
        ref_event: input.channelRef,
        balance_after_cents: next,
      })
      return { balance: next }
    })
    this.ctx.platformBus.emit(PlatformEvents.WalletChanged, {
      ownerType: input.ownerType, ownerId: input.ownerId, balanceCents: result.balance, deltaCents: input.amountCents, kind: 'recharge',
    })
    return { balanceCents: result.balance, journalId, duplicated: false }
  }

  /** 扣费（debit）：余额与流水同事务；不足抛错且不留任何写入（原子回滚）。 */
  charge(input: { ownerType: WalletOwnerType; ownerId: string; tenantId?: string; amountCents: number; reason: string; refEvent?: string; idempotencyKey: string }): { balanceCents: number; journalId: string; duplicated: boolean } {
    if (!Number.isInteger(input.amountCents) || input.amountCents < 0) throw new Error('扣费金额必须为非负整数（分）')
    const existing = this.requireJournalForKey(input.idempotencyKey, input.ownerType, input.ownerId)
    if (existing) return { balanceCents: this.balance(input.ownerType, input.ownerId), journalId: existing.id, duplicated: true }
    if (input.amountCents === 0) return { balanceCents: this.balance(input.ownerType, input.ownerId), journalId: '', duplicated: false }
    const journalId = newId('wjr')
    const tenant = input.tenantId ?? 't_default'
    const result = this.ctx.txnStore.txn((): { balance: number } => {
      const current = this.balance(input.ownerType, input.ownerId)
      if (current < input.amountCents) {
        throw new Error(`余额不足：当前 ${current} 分，需扣 ${input.amountCents} 分（请充值或调低预算）`)
      }
      const next = current - input.amountCents
      const updated = this.ctx.txnStore.run(
        'UPDATE wallets SET balance_cents = ?, updated_at = ? WHERE owner_type = ? AND owner_id = ? AND balance_cents = ?',
        [next, new Date().toISOString(), input.ownerType, input.ownerId, current],
      )
      if (updated !== 1) throw new Error('并发扣费冲突，请重试（乐观锁）')
      this.ctx.txnStore.insert('wallet_journal', {
        id: journalId,
        idempotency_key: input.idempotencyKey,
        at: new Date().toISOString(),
        tenant_id: tenant,
        owner_type: input.ownerType,
        owner_id: input.ownerId,
        direction: 'debit',
        amount_cents: input.amountCents,
        reason: input.reason,
        ref_event: input.refEvent ?? '',
        balance_after_cents: next,
      })
      return { balance: next }
    })
    this.ctx.platformBus.emit(PlatformEvents.WalletChanged, {
      ownerType: input.ownerType, ownerId: input.ownerId, balanceCents: result.balance, deltaCents: -input.amountCents, kind: 'charge',
    })
    return { balanceCents: result.balance, journalId, duplicated: false }
  }

  /**
   * 幂等键查找并绑定主体校验：同键异主体（钱包）视为攻击面直接拒绝，
   * 不得返回他人钱包状态（评审：幂等键未绑定钱包主体）。
   */
  private requireJournalForKey(idempotencyKey: string, ownerType: WalletOwnerType, ownerId: string): WalletJournalRow | undefined {
    const existing = this.ctx.txnStore.one<WalletJournalRow>('wallet_journal', { idempotency_key: idempotencyKey })
    if (existing && (existing.owner_type !== ownerType || existing.owner_id !== ownerId)) {
      throw new Error(`幂等键 ${idempotencyKey} 已绑定主体 ${existing.owner_type}:${existing.owner_id}，不能用于 ${ownerType}:${ownerId}`)
    }
    return existing
  }

  journal(filter: { ownerType?: string; ownerId?: string; tenantId?: string; limit?: number } = {}): WalletJournalRow[] {
    const conditions: string[] = []
    const params: SqlValue[] = []
    if (filter.ownerType) { conditions.push('owner_type = ?'); params.push(filter.ownerType) }
    if (filter.ownerId) { conditions.push('owner_id = ?'); params.push(filter.ownerId) }
    if (filter.tenantId) { conditions.push('tenant_id = ?'); params.push(filter.tenantId) }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    return this.ctx.txnStore.sql<WalletJournalRow>(`SELECT * FROM wallet_journal${where} ORDER BY at DESC LIMIT ?`, [...params, Math.min(filter.limit ?? 100, 1000)])
  }

  /** 余额恒等式全量重放校验：wallets.balance ≡ Σ(credit) − Σ(debit)。 */
  verifyIntegrity(): { ok: boolean; wallets: number; mismatches: Array<{ owner: string; recorded: number; actual: number }> } {
    const rows = this.ctx.txnStore.sql<{ owner_type: string; owner_id: string; net: number }>(
      "SELECT owner_type, owner_id, SUM(CASE direction WHEN 'credit' THEN amount_cents ELSE -amount_cents END) AS net FROM wallet_journal GROUP BY owner_type, owner_id",
    )
    const mismatches: Array<{ owner: string; recorded: number; actual: number }> = []
    for (const row of rows) {
      const actual = this.balance(row.owner_type as WalletOwnerType, row.owner_id)
      if (Number(row.net) !== actual) mismatches.push({ owner: `${row.owner_type}:${row.owner_id}`, recorded: Number(row.net), actual })
    }
    return { ok: mismatches.length === 0, wallets: rows.length, mismatches }
  }

  // -- 预算与限额 ----------------------------------------------------------

  setBudget(orgId: string, monthlyCents: number, actor: string): BudgetRecord {
    if (!Number.isInteger(monthlyCents) || monthlyCents < 0) throw new Error('预算必须为非负整数（分）')
    const existing = this.budgets().findOne((item) => item.orgId === orgId)
    if (existing) return this.budgets().update(existing.id, { monthlyCents, updatedBy: actor })
    return this.budgets().insert({ id: newId('bud'), orgId, monthlyCents, updatedBy: actor })
  }

  /** 当月已扣费（分）：org 钱包当月 debit 合计。 */
  monthSpent(orgId: string, month?: string): number {
    const period = month ?? new Date().toISOString().slice(0, 7)
    const row = this.ctx.txnStore.sql<{ total: number }>(
      "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM wallet_journal WHERE owner_type = 'org' AND owner_id = ? AND direction = 'debit' AND at LIKE ?",
      [orgId, `${period}%`],
    )[0]
    return Number(row?.total ?? 0)
  }

  /** 预检：余额 + 月度预算（模型网关调用前执行，超额拒绝，不计费）。 */
  precheck(orgId: string, estimateCents: number): { ok: true } | { ok: false; reason: string } {
    const balance = this.balance('org', orgId)
    if (balance < estimateCents) return { ok: false, reason: `余额不足：${balance} 分 < 预估 ${estimateCents} 分（quota.exceeded）` }
    const budget = this.budgets().findOne((item) => item.orgId === orgId)
    if (budget && this.monthSpent(orgId) + estimateCents > budget.monthlyCents) {
      return { ok: false, reason: `月度预算将超限：已用 ${this.monthSpent(orgId)} 分 + 预估 ${estimateCents} 分 > 预算 ${budget.monthlyCents} 分（quota.exceeded）` }
    }
    return { ok: true }
  }

  // -- 复式分账 ledger（第 8 步） -------------------------------------------

  ledger(period?: string): LedgerEntryRow[] {
    return period
      ? this.ctx.txnStore.sql<LedgerEntryRow>('SELECT * FROM ledger_entries WHERE period = ? ORDER BY at, id', [period])
      : this.ctx.txnStore.sql<LedgerEntryRow>('SELECT * FROM ledger_entries ORDER BY at, id LIMIT 500')
  }

  /** 试算平衡：期间内借方合计 = 贷方合计。 */
  trialBalance(period: string): { balanced: boolean; debitCents: number; creditCents: number } {
    const rows = this.ctx.txnStore.sql<{ direction: string; total: number }>(
      'SELECT direction, SUM(amount_cents) AS total FROM ledger_entries WHERE period = ? GROUP BY direction',
      [period],
    )
    const debit = Number(rows.find((row) => row.direction === 'debit')?.total ?? 0)
    const credit = Number(rows.find((row) => row.direction === 'credit')?.total ?? 0)
    return { balanced: debit === credit, debitCents: debit, creditCents: credit }
  }

  /**
   * 账期汇总结转：计量流水（usage 事件）→ 复式分录。
   * 规则（M4）：逐事件归集、按 (借方org, 贷方账户) 汇总生成复合分录（一借多贷）；
   *   借 org:<消费组织> 应收 = Σ charge；插件资源 → 贷 developer:<发布者>（费率版本快照）+ 贷 platform（差额）；
   *   平台自营资源 → 全额贷 platform；尾差（分账取整）归 platform 损益。
   * 修复（评审 S1）：keyset 分页全量归集（不再单页 limit:1000 截断），
   *   且归集条数与 SQL COUNT 对账不符时拒绝结转——宁可不结，不可结错。
   */
  settle(period: string, actor: string): { period: string; entries: number; debitCents: number; creditCents: number; balanced: boolean; events: number } {
    if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('账期格式应为 YYYY-MM')
    const already = this.ctx.txnStore.count('ledger_entries', { period })
    if (already > 0) throw new Error(`账期 ${period} 已结转（${already} 条分录）；调整请走红字冲正`)
    const [from, to] = periodBounds(period)
    const expected = Number(this.ctx.txnStore.sql<{ n: number }>(
      'SELECT COUNT(*) AS n FROM usage_events WHERE occurred_at >= ? AND occurred_at < ?', [from, to],
    )[0]?.n ?? 0)
    // keyset 分页全量归集（occurred_at + id 稳定排序，页间无重叠无遗漏）
    const debits = new Map<string, number>()
    const credits = new Map<string, number>()
    const rateVersions = new Map<string, string>()
    let processed = 0
    let cursor: Array<string> = [from, '']
    for (;;) {
      const rows = this.ctx.txnStore.sql<{ org: string; resource: string; charge_cents: number; occurred_at: string; id: string }>(
        "SELECT id, occurred_at, org, resource, CAST(json_extract(pricing_json, '$.charge_cents') AS INTEGER) AS charge_cents FROM usage_events WHERE occurred_at >= ? AND occurred_at < ? AND (occurred_at > ? OR (occurred_at = ? AND id > ?)) ORDER BY occurred_at, id LIMIT 1000",
        [from, to, cursor[0], cursor[0], cursor[1]],
      )
      for (const row of rows) {
        debits.set(`org:${row.org}`, (debits.get(`org:${row.org}`) ?? 0) + Number(row.charge_cents))
        if (row.resource.startsWith('plugin:')) {
          const pluginId = row.resource.slice(7)
          const submission = this.ctx.storage.collection<{ developerId: string }>('market:submissions').findOne((item) => item.pluginId === pluginId)
          const rate = COMMISSION_RATES.platform_default
          rateVersions.set(`developer:${submission?.developerId ?? 'unknown'}`, rate.version)
          const devShare = Math.floor(Number(row.charge_cents) * rate.developerShare)
          credits.set(`developer:${submission?.developerId ?? 'unknown'}`, (credits.get(`developer:${submission?.developerId ?? 'unknown'}`) ?? 0) + devShare)
          credits.set('platform', (credits.get('platform') ?? 0) + (Number(row.charge_cents) - devShare)) // 尾差归平台
        } else {
          credits.set('platform', (credits.get('platform') ?? 0) + Number(row.charge_cents))
        }
      }
      processed += rows.length
      if (rows.length < 1000) break
      const last = rows[rows.length - 1]!
      cursor = [last.occurred_at, last.id]
    }
    if (processed !== expected) {
      throw new Error(`结转对账失败：账期内事件 COUNT=${expected}，归集 ${processed} 条（归集与口径不一致，拒绝结转）`)
    }
    const at = new Date().toISOString()
    const entries: Array<Record<string, SqlValue>> = []
    for (const [account, amount] of debits) {
      entries.push({ id: newId('led'), period, at, journal_type: 'usage_settlement', ref: `settle:${period}`, account, direction: 'debit', amount_cents: amount, memo: `${period} 用量结转`, rate_version: '' })
    }
    for (const [account, amount] of credits) {
      entries.push({ id: newId('led'), period, at, journal_type: 'usage_settlement', ref: `settle:${period}`, account, direction: 'credit', amount_cents: amount, memo: `${period} 用量结转`, rate_version: rateVersions.get(account) ?? '' })
    }
    this.ctx.txnStore.txn(() => {
      for (const entry of entries) this.ctx.txnStore.insert('ledger_entries', entry)
    })
    const trial = this.trialBalance(period)
    this.ctx.platformBus.emit(PlatformEvents.LedgerSettled, { period, actor, entries: entries.length, ...trial })
    return { period, entries: entries.length, debitCents: trial.debitCents, creditCents: trial.creditCents, balanced: trial.balanced, events: processed }
  }

  /** 红字冲正：引用既有结转，生成负数分录（反向）。同一账期至多冲正一次（防二次冲正破坏借贷）。 */
  reverse(period: string, reason: string, actor: string): { entries: number; balanced: boolean } {
    const reversed = this.ctx.txnStore.count('ledger_entries', { period, journal_type: 'reversal' })
    if (reversed > 0) throw new Error(`账期 ${period} 已存在红字冲正（${reversed} 条）；如需调整请先重新结转或联系平台管理员`)
    const originals = this.ctx.txnStore.sql<LedgerEntryRow>('SELECT * FROM ledger_entries WHERE period = ? AND journal_type = ?', [period, 'usage_settlement'])
    if (originals.length === 0) throw new Error(`账期 ${period} 无可冲正分录`)
    const at = new Date().toISOString()
    this.ctx.txnStore.txn(() => {
      for (const entry of originals) {
        this.ctx.txnStore.insert('ledger_entries', {
          id: newId('led'), period, at, journal_type: 'reversal', ref: entry.id,
          account: entry.account, direction: entry.direction, amount_cents: -entry.amount_cents,
          memo: `红字冲正：${reason}（by ${actor}）`, rate_version: entry.rate_version,
        })
      }
    })
    const trial = this.trialBalance(period)
    if (!trial.balanced) throw new Error(`冲正后试算不平衡（借 ${trial.debitCents} / 贷 ${trial.creditCents}），请立即核查`)
    return { entries: originals.length, balanced: trial.balanced }
  }

  /** 开发者分成应收（账期）：credit developer:<id> 合计。 */
  developerReceivable(developerId: string, period: string): number {
    const row = this.ctx.txnStore.sql<{ total: number }>(
      "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM ledger_entries WHERE period = ? AND account = ? AND direction = 'credit'",
      [period, `developer:${developerId}`],
    )[0]
    return Number(row?.total ?? 0)
  }
}

/** 账期边界：[当月 1 日 00:00, 次月 1 日 00:00)，与事件 ISO 时间词法比较兼容。 */
function periodBounds(period: string): [string, string] {
  const [year, month] = period.split('-').map(Number)
  const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`
  return [`${period}-01T00:00:00`, `${next}-01T00:00:00`]
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    billing: BillingService
  }
}

export const name = 'billing'
export const inject = ['storage', 'platformBus', 'txnStore', 'usage']

export function apply(ctx: Context) {
  ctx.plugin(BillingService)
  ctx.plugin(billingTools)
}

export type { UsageEvent }
