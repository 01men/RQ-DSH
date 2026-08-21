/** 标识与文本工具：统一的前缀式 ID、slug 化、脱敏。 */
import { createHash, randomBytes } from 'node:crypto'

let counter = Math.floor(Math.random() * 1e6)

/** 生成短 ID：`<prefix>_<时间基36><随机>`，进程内严格递增，可读可排序。 */
export function newId(prefix: string): string {
  const t = Date.now().toString(36)
  const r = (counter++).toString(36)
  const rand = Math.floor(Math.random() * 1679616).toString(36)
  return `${prefix}_${t}${r.padStart(4, '0')}${rand.padStart(4, '0')}`
}

/** 将名称转为 URL 友好的 slug。 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || newId('slug')
}

/** 简单脱敏：保留首尾各 keep 个字符。 */
export function mask(value: string | undefined, keep = 3): string {
  if (!value) return ''
  if (value.length <= keep * 2) return '*'.repeat(value.length)
  return value.slice(0, keep) + '*'.repeat(Math.min(8, value.length - keep * 2)) + value.slice(-keep)
}

/** 生成客户端密钥（仅展示一次，库中只存哈希）。 */
export function generateSecret(prefix = 'sk'): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}
