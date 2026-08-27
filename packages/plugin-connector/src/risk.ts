/**
 * riskLevel 启发式映射（计划书 §2.4 P2 修正⑭）：
 * open-connector action 本体无 risk 字段——由目录同步时按 requiredScopes/providerPermissions
 * 加 action 名称启发式映射；无法判定的默认 admin 兜底 fail-closed。
 */

export type RiskLevel = 'read' | 'write' | 'admin'

export const RISK_RANK: Record<RiskLevel, number> = { read: 0, write: 1, admin: 2 }

export function rankOf(level: RiskLevel): number {
  return RISK_RANK[level]
}

const READ_SCOPE = /(^|[:.])(read|readonly|profile|userinfo|email|public|view)([:.]|$)/i
const ADMIN_SCOPE = /(admin|delete|destroy|revoke|invite|permission|role|org|billing|webhook.*(write|admin)|token)/i

const READ_NAME = /(^|[._])(list|get|search|fetch|query|top|read|find|browse)[._]?|get[A-Z_]/
const ADMIN_NAME = /(delete|remove|destroy|revoke|suspend|ban|invite|permission|role|owner|transfer|admin)/i
const WRITE_NAME = /(create|update|write|send|post|edit|add|merge|deploy|assign|close|reopen|run|trigger|upload|star|watch|pin)/i

interface RiskInputLike {
  id?: string
  name?: string
  description?: string
  requiredScopes?: Array<unknown>
  providerPermissions?: Array<unknown>
}

function scopeStrings(input: RiskInputLike): string[] {
  return [
    ...(Array.isArray(input.requiredScopes) ? input.requiredScopes : []),
    ...(Array.isArray(input.providerPermissions) ? input.providerPermissions : []),
  ].map((item) => String(item))
}

/** 目录同步与授权链共用的风险分级入口。显式 riskLevel 存在时直接采信（前向兼容上游加字段）。 */
export function heuristicRiskLevel(action: RiskInputLike): RiskLevel {
  if ((action as { riskLevel?: unknown }).riskLevel === 'read' || (action as { riskLevel?: unknown }).riskLevel === 'write' || (action as { riskLevel?: unknown }).riskLevel === 'admin') {
    return (action as { riskLevel: RiskLevel }).riskLevel
  }
  const scopes = scopeStrings(action)
  if (scopes.length > 0) {
    if (scopes.every((scope) => READ_SCOPE.test(scope))) return 'read'
    if (scopes.some((scope) => ADMIN_SCOPE.test(scope))) return 'admin'
    if (scopes.some((scope) => !READ_SCOPE.test(scope))) return 'write'
  }
  const text = `${action.id ?? ''} ${action.name ?? ''}`
  if (ADMIN_NAME.test(text)) return 'admin'
  if (READ_NAME.test(text)) return 'read'
  if (WRITE_NAME.test(text)) return 'write'
  if ((action.description ?? '').length > 0 && WRITE_NAME.test(action.description!)) return 'write'
  return 'admin'
}
