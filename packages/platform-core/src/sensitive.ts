/**
 * 敏感入参卫生（OPT-P2-02，2026-09-12）：审批存储不得携带敏感值。
 * 连接器 admin 审批与审计中心共用同一份键名清单——双处口径一致由单一定义保证。
 */

/** 敏感键名清单（审计核验 #11 升级项）：命中即不入审批存储（掩码或拒绝开单）。 */
export const SENSITIVE_KEY_RE = /(password|passwd|secret|token|apikey|api[_-]?key|access[_-]?key|private[_-]?key|credential|client[_-]?secret)/i

/** 递归扫描敏感键路径（不改动原值）。 */
export function scanSensitiveKeys(value: unknown, prefix = ''): string[] {
  const paths: string[] = []
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`))
      return
    }
    if (node && typeof node === 'object') {
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        const childPath = path ? `${path}.${key}` : key
        if (SENSITIVE_KEY_RE.test(key) && item !== null && typeof item !== 'object') paths.push(childPath)
        else walk(item, childPath)
      }
    }
  }
  walk(value, prefix)
  return paths
}

/** 深度掩码：敏感键的值替换为 ***（保留键名与结构，供复核对照 inputHash 使用）。 */
export function maskSensitivePayload<T>(value: T): { masked: T; maskedKeys: string[] } {
  const maskedKeys: string[] = []
  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((item, index) => walk(item, `${path}[${index}]`))
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        out[key] = SENSITIVE_KEY_RE.test(key) && item !== null && typeof item !== 'object'
          ? (maskedKeys.push(path ? `${path}.${key}` : key), '***')
          : walk(item, path ? `${path}.${key}` : key)
      }
      return out
    }
    return node
  }
  return { masked: walk(value, '') as T, maskedKeys }
}
