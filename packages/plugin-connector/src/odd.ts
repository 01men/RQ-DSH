/**
 * ODD（Operation Design Domain）运行时判定（OPT-P2-01，2026-09-12）。
 *
 * 连接器权限组可声明 odd 块（运营设计域）：provider 白名单 / 显式排除 action /
 * 目录数据新鲜度阈值 / 许可时间窗。`inOdd` 为纯函数——授权链在 admin 审批门之前插入域内判定，
 * 离域即拒绝并发 `connector.odd_exit`（走 OPT-P1-04 总线落审计）。
 * 边界从此可计算：目录外 action、陈旧目录、时间窗外调用不再依赖"admin 兜底"被动防御。
 */

export interface OddDeclaration {
  /** provider（service）白名单：'*' 或显式列表；未声明=不限制。 */
  allowedServices?: string[] | '*'
  /** 显式排除 action id（目录外/危险动作点名排除）。 */
  excludedActions?: string[]
  /** 目录数据新鲜度阈值（分钟）：目录 syncedAt 距今超过阈值即离域（未声明=不限制）。 */
  dataFreshnessMinutes?: number
  /** 许可时间窗（本地时，24h 制）：如 { start: 9, end: 18 }；跨零点支持 start > end；未声明=全天。 */
  activeHours?: { start: number; end: number }
}

export interface OddActionRef {
  id: string
  service: string
}

export interface OddVerdict {
  in: boolean
  reasons: string[]
}

function inActiveHours(now: Date, window: { start: number; end: number }): boolean {
  const hour = now.getHours()
  const { start, end } = window
  if (start === end) return hour === start
  if (start < end) return hour >= start && hour < end
  return hour >= start || hour < end // 跨零点：22→6
}

/**
 * 域内判定（纯函数）：全部约束命中即 in=true；任一离域给出 reasons（人可读，入审计）。
 */
export function inOdd(
  odd: OddDeclaration,
  action: OddActionRef,
  options: { now?: Date; catalogSyncedAt?: string } = {},
): OddVerdict {
  const reasons: string[] = []
  const now = options.now ?? new Date()

  if (Array.isArray(odd.allowedServices) && !odd.allowedServices.includes(action.service)) {
    reasons.push(`provider ${action.service} 不在 ODD 白名单（允许：${odd.allowedServices.join('、') || '空'}）`)
  }

  if (Array.isArray(odd.excludedActions) && odd.excludedActions.includes(action.id)) {
    reasons.push(`action ${action.id} 在 ODD 显式排除清单内`)
  }

  if (typeof odd.dataFreshnessMinutes === 'number' && odd.dataFreshnessMinutes > 0) {
    const syncedAt = options.catalogSyncedAt ? Date.parse(options.catalogSyncedAt) : NaN
    if (Number.isNaN(syncedAt)) {
      reasons.push('目录缺少同步时间戳，无法证明数据新鲜度（fail-closed）')
    } else {
      const ageMinutes = (now.getTime() - syncedAt) / 60_000
      if (ageMinutes > odd.dataFreshnessMinutes) {
        reasons.push(`目录数据已陈旧：距上次同步 ${Math.floor(ageMinutes)} 分钟，超过 ODD 阈值 ${odd.dataFreshnessMinutes} 分钟`)
      }
    }
  }

  if (odd.activeHours && !inActiveHours(now, odd.activeHours)) {
    reasons.push(`当前时间 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} 在 ODD 许可时间窗（${odd.activeHours.start}:00–${odd.activeHours.end}:00）之外`)
  }

  return { in: reasons.length === 0, reasons }
}

/** 规范化入参声明：剔除未声明字段，防止部分赋值把 undefined 语义写进台账。 */
export function normalizeOdd(input: unknown): OddDeclaration | undefined {
  if (!input || typeof input !== 'object') return undefined
  const odd = input as OddDeclaration
  const normalized: OddDeclaration = {}
  if (odd.allowedServices === '*' || (Array.isArray(odd.allowedServices) && odd.allowedServices.length > 0)) {
    normalized.allowedServices = odd.allowedServices
  }
  if (Array.isArray(odd.excludedActions) && odd.excludedActions.length > 0) normalized.excludedActions = [...odd.excludedActions]
  if (typeof odd.dataFreshnessMinutes === 'number' && odd.dataFreshnessMinutes > 0) normalized.dataFreshnessMinutes = odd.dataFreshnessMinutes
  if (odd.activeHours && Number.isInteger(odd.activeHours.start) && Number.isInteger(odd.activeHours.end)
    && odd.activeHours.start >= 0 && odd.activeHours.start <= 23 && odd.activeHours.end >= 0 && odd.activeHours.end <= 23) {
    normalized.activeHours = { start: odd.activeHours.start, end: odd.activeHours.end }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}
