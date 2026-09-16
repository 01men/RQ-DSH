/**
 * 接入文档一致性核查：docs/*.md 引用的 API 端点 ↔ 代码注册路由（manifests + 源码）。
 * 用法：node scripts/check-docs-consistency.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// QA G-01：URL.pathname 是百分号编码形态——中文目录（如「元冰可产品」）下直接当文件路径必现
// ENOENT；fileURLToPath 负责解码并处理盘符，Windows/非 ASCII 路径均正确。
const root = fileURLToPath(new URL('..', import.meta.url))
const docFiles = [
  'docs/agent-onboarding.md', 'docs/app-onboarding.md', 'docs/app-sso-integration.md',
  'docs/portal-integration.md', 'docs/connector-integration.md', 'docs/frontend-host-switching.md',
  'docs/host-features-ops-notes.md', 'docs/deploy-enterprise.md', 'docs/nas-authz.md',
  'docs/entry-switching.md', 'docs/panel-implementation.md',
]

// 1. 汇总代码侧路由：manifests api.yaml + 源码 register/guarded 调用
const codeRoutes = new Set()
function addRoute(method, path) {
  const norm = String(path).replace(/\/+$/, '')
  if (!norm.startsWith('/')) return
  codeRoutes.add(`${method.toUpperCase()} ${norm}`)
  codeRoutes.add(norm) // 供无方法引用匹配
}
function walk(dir, cb) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'data-livecheck') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, cb)
    else cb(full)
  }
}
walk(join(root, 'packages'), (file) => {
  if (file.endsWith('manifest' + String.fromCharCode(92) + 'api.yaml') || file.endsWith('/manifest/api.yaml') || file.includes('manifest') && file.endsWith('api.yaml')) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/(get|post|put|patch|delete)\s*:\s*\n?\s*([^\s:][^\n]*)?/gi)) { /* yaml 结构多样，改用源码为准 */ }
    for (const m of text.matchAll(/'?(\/api\/[A-Za-z0-9/:_{}.\-]+)'?/g)) addRoute('ANY', m[1])
  }
  if (file.endsWith('.ts')) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/(?:guarded|http\.register)\(\s*'(GET|POST|PUT|PATCH|DELETE|OPTIONS)'\s*,\s*[''`]([^''`]+)[''`]/g)) {
      if (!m[2].startsWith('/')) continue
      if (m[1] === 'OPTIONS') continue
      addRoute(m[1], m[2])
    }
  }
})

// 2. 提取文档端点引用
// 豁免名单（对齐 contract-lint.exemptions.json 惯例）：并非平台路由的引用——
// /oauth/callback 与 /api/connections 指 open-connector sidecar 自身服务（端口 3000，非平台），
// /api 为前缀概念提及。G-01 修复后本脚本首次可在本机完整跑通，暴露的即这三处历史误报。
const DOC_REF_EXEMPTS = new Set(['/oauth/callback', '/api/connections', '/api'])
let missing = [], total = 0
for (const doc of docFiles) {
  const full = join(root, doc)
  let text
  try { text = readFileSync(full, 'utf8') } catch { console.log(`  ⚠ 文档缺失：${doc}`); continue }
  const refs = new Set()
  for (const m of text.matchAll(/(?:GET|POST|PUT|PATCH|DELETE)\s+`?(\/(?:api|oauth|\.well-known|auth|panel|rq)[A-Za-z0-9/:_{}.\-]*)`?/g)) refs.add(m[1])
  for (const m of text.matchAll(/`((?:\/(?:api|oauth|\.well-known|auth|panel)|\{base\}\/api)[A-Za-z0-9/:_{}.\-]*)`/g)) refs.add(m[1])
  for (const ref of refs) {
    if (ref.endsWith('…') || ref.endsWith('…/')) continue
    if (DOC_REF_EXEMPTS.has(ref)) continue
    total++
    const methodMatch = ref.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(.*)/)
    const method = methodMatch ? methodMatch[1] : 'ANY'
    const path = methodMatch ? methodMatch[2] : ref
    const pathNorm = path.replace(/\{[^}]+\}/g, ':x').replace(/:[a-zA-Z]+/g, ':x')
    let hit = false
    for (const route of codeRoutes) {
      const routeNorm = route.replace(/\{[^}]+\}/g, ':x').replace(/:[a-zA-Z]+/g, ':x')
      if (routeNorm === pathNorm || routeNorm === `${method} ${pathNorm}` || routeNorm.endsWith(pathNorm)) { hit = true; break }
      if (routeNorm.includes(':x') && pathNorm.split('/').length === routeNorm.split('/').length) {
        const re = new RegExp('^' + routeNorm.replace(/:x/g, '[^/]+') + '$')
        if (re.test(pathNorm) || re.test(routeNorm)) { hit = true; break }
      }
    }
    // 前缀引用（如 /api/portal/、/api/connector/）
    if (!hit && pathNorm.endsWith('/')) {
      for (const route of codeRoutes) { if (route.includes(pathNorm.replace(/\/$/, ''))) { hit = true; break } }
    }
    if (!hit) missing.push(`${doc} → ${ref}`)
  }
}

console.log(`文档端点引用核查：共 ${total} 处引用，未匹配 ${missing.length} 处`)
if (missing.length) {
  for (const m of missing) console.log(`  ✘ ${m}`)
  process.exit(1)
} else {
  console.log('  全部命中 ✔')
}
