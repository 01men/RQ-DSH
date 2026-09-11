/**
 * 契约↔实现双向一致性比对引擎（OPT-P0-01，2026-09-12）。
 *
 * 目标：把 manifest 五面清单从"文档"升级为"可检查工件"——代码注册面（guarded 路由 /
 * http.register 路由 / 工具名 / 权限点引用）与清单声明面（api.yaml endpoints+tools、
 * permissions.yaml points、plugin.yaml permissions）双向比对，任一方向漂移即红。
 *
 * 规范语法（endpoints 摘要行的可解析子集）：
 *   fragment := METHODS ' ' PATH [ '?query' 剥离 ] [ （注解）| '# 注释' 剥离 ]
 *   METHODS  := METHOD ( '/' METHOD )*            —— GET/PUT 展开为多条
 *   PATH     := 以 / 起始的绝对路径；段内 '|' 展开候选；'[/seg]' 可选段展开；
 *               ':param' 泛化为 ':*' 后比对
 *   相对片段（首段以 ':' 起始，如 'DELETE /:id'）继承同一行上一个绝对片段的全路径。
 *   以 '#' 起始的条目为纯注解，跳过不报。
 *
 * 豁免：scripts/contract-lint.exemptions.json（{exemptions:[{kind,key,reason}]}），
 * 仅用于"结构性无法字面量提取"的少数面（如 portal 单 handler 内部前缀分发），
 * 每条豁免必须写明销账条件；lint 输出豁免条目保持透明。
 *
 * 用法：
 *   - CLI：由 scripts/lint-manifests.mjs 调 runContractLint(root)；
 *   - 测试：scripts/contract-lint.test.mjs 直接 import 本模块，对合成夹具做构造性红/绿断言。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { parseYaml } from '../packages/platform-core/src/yaml.ts'

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

/** 段内 '|' 候选展开：/a/:id/disable|enable → [/a/:id/disable, /a/:id/enable] */
export function expandAlternatives(path) {
  const segs = path.split('/').filter((seg) => seg !== '')
  let acc = ['']
  for (const seg of segs) {
    const variants = seg.includes('|') ? seg.split('|') : [seg]
    acc = acc.flatMap((base) => variants.map((variant) => `${base}/${variant}`))
  }
  return acc
}

/** '[/seg]' 可选段展开：/a/:id[/guide] → [/a/:id, /a/:id/guide]（递归处理多个可选段） */
export function expandOptionalSegments(path) {
  const match = path.match(/^(.*?)\[(\/[^\]]*)\](.*)$/)
  if (!match) return [path]
  const [, head, optional, tail] = match
  return [...expandOptionalSegments(head + tail), ...expandOptionalSegments(head + optional + tail)]
}

/** ':param' 泛化为 ':*'，消除两侧参数命名差异 */
export function generalizePath(path) {
  return path.replace(/:[^/]+/g, ':*')
}

/**
 * 单条 endpoints 摘要行 → 规范 (METHOD, 泛化路径) 列表。
 * 返回 { routes: [{ method, path }], unparseable: [string], notes: [string] }。
 */
export function parseEndpointLine(line, previousAbsolutePath = undefined) {
  const routes = []
  const unparseable = []
  const notes = []
  let prevAbsolute = previousAbsolutePath
  const trimmedLine = line.trim()
  if (trimmedLine.startsWith('#')) return { routes: [], unparseable: [], notes: [trimmedLine] }
  for (const rawFragment of line.split('·')) {
    let fragment = rawFragment.trim()
    if (fragment === '') continue
    if (fragment.startsWith('#')) {
      notes.push(fragment)
      continue
    }
    // 剥离行内 '# 注释' 尾巴、全角注解（（...））与半角查询串
    fragment = fragment.replace(/\s+#.*$/, '')
    fragment = fragment.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').replace(/\?.*$/, '').trim()
    // 剥离行尾可能残留的逗号/分号
    fragment = fragment.replace(/[,;。]+$/, '').trim()
    const methodMatch = fragment.match(/^([A-Za-z/]+)\s+(\/.*)$/)
    if (!methodMatch) {
      unparseable.push(rawFragment.trim())
      continue
    }
    const methods = methodMatch[1].split('/').map((item) => item.trim().toUpperCase())
    if (!methods.every((method) => METHODS.has(method)) || methods.length === 0) {
      unparseable.push(rawFragment.trim())
      continue
    }
    let path = methodMatch[2].trim()
    // 相对片段（首段 ':param'）继承同一行上一个绝对路径
    if (path.startsWith('/:')) {
      if (!prevAbsolute) {
        unparseable.push(rawFragment.trim())
        continue
      }
      path = prevAbsolute + path
    }
    for (const expanded of expandAlternatives(path)) {
      for (const finalPath of expandOptionalSegments(expanded)) {
        const generalized = generalizePath(finalPath)
        for (const method of methods) routes.push({ method, path: generalized })
      }
    }
    if (!path.startsWith('/:')) prevAbsolute = path
  }
  return { routes, unparseable, notes }
}

async function walkTsFiles(dir) {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.ts')) out.push(join(entry.parentPath ?? dir, entry.name))
  }
  return out
}

/**
 * 从 api.yaml 原始文本提取 endpoints 列表项（字符串字面量行）。
 * 不走 parseYaml：子集解析器会把摘要行里的 ':param' 误切为键值对（OPT-P0-01 实测），
 * 而摘要行是给人看的事实源，必须按原文逐条取出。
 */
export function extractEndpointLines(apiYamlText) {
  const items = []
  let inEndpoints = false
  for (const line of apiYamlText.split(/\r?\n/)) {
    if (/^endpoints:/.test(line)) {
      inEndpoints = true
      continue
    }
    if (!inEndpoints) continue
    if (/^\s/.test(line)) {
      const match = line.match(/^\s{2}-\s(.*)$/)
      if (match) items.push(match[1].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))
    } else if (line.trim() !== '' && !line.trim().startsWith('#')) {
      break
    }
  }
  return items
}

/** 从单个 ts 源文件提取：guarded 路由 / http.register 路由 / 工具名 / 权限点引用（均要求字符串字面量） */
export function extractCodeSurface(text) {
  const lines = text.split(/\r?\n/)
  const routes = []
  const tools = []
  const perms = []
  const routeRe = /guarded\(\s*'([A-Za-z]+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'/g
  const httpRe = /http\.register\(\s*'([A-Za-z]+)'\s*,\s*'([^']+)'/g
  const toolRe = /(?:defineTool\(\{|tools\.register\(\{)([\s\S]{0,400}?)\bname:\s*'([^']+)'/g
  const permRe = /permission:\s*'([^']+)'/g
  for (let i = 0; i < lines.length; i++) {
    for (const match of lines[i].matchAll(routeRe)) {
      routes.push({ method: match[1].toUpperCase(), path: generalizePath(match[2]), permission: match[3], line: i + 1 })
      // guarded 第三参即权限点引用：与 permission: 字面量同口径计入已用集合
      for (const part of match[3].split(',')) {
        const perm = part.trim()
        if (perm !== '') perms.push(perm)
      }
    }
    // http.register 的 OPTIONS（CORS 预检）/HEAD 不属契约面，跳过
    for (const match of lines[i].matchAll(httpRe)) {
      const method = match[1].toUpperCase()
      if (method === 'OPTIONS' || method === 'HEAD') continue
      routes.push({ method, path: generalizePath(match[2]), permission: '', line: i + 1 })
    }
    for (const match of lines[i].matchAll(permRe)) {
      // 权限字面量支持逗号多值（'a.b,c.d' = 任一即可）——逐个拆开参与声明比对
      for (const part of match[1].split(',')) {
        const perm = part.trim()
        if (perm !== '') perms.push(perm)
      }
    }
  }
  // 工具名允许跨行（defineTool({ 换行 name: 'x'）——对整文匹配，行号取 name 所在行
  const nameLineOf = (name) => {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`name: '${name}'`)) return i + 1
    }
    return 0
  }
  for (const match of text.matchAll(toolRe)) {
    tools.push({ name: match[2], line: nameLineOf(match[2]) })
  }
  return { routes, tools, perms }
}

/** 从 PUBLIC_PATHS 集合字面量提取公开路径（method=ANY，路径泛化后参与 ANY 匹配） */
export function extractPublicPaths(text) {
  const start = text.indexOf('PUBLIC_PATHS = new Set([')
  if (start < 0) return []
  const end = text.indexOf('])', start)
  if (end < 0) return []
  const block = text.slice(start, end)
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]).filter((path) => path.startsWith('/'))
}

async function readYamlOrNull(file) {
  try {
    return parseYaml(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function loadExemptions(root) {
  try {
    const parsed = JSON.parse(await readFile(join(root, 'scripts', 'contract-lint.exemptions.json'), 'utf8'))
    return new Map((parsed.exemptions ?? []).map((item) => [`${item.kind}::${item.key}`, item]))
  } catch {
    return new Map()
  }
}

/**
 * 全量比对入口。root 为仓库根（含 packages/）。
 * 返回 { ok, diffs: [{severity: 'red'|'warn'|'exempt', kind, message}], stats }。
 */
export async function runContractLint(root) {
  const packagesDir = join(root, 'packages')
  const exemptions = await loadExemptions(root)
  const diffs = []
  const stats = {
    packages: 0, withManifest: 0, codeRoutes: 0, manifestRoutes: 0,
    codeTools: 0, manifestTools: 0, unparseable: 0, exempted: 0,
  }

  // 红项统一发射口：命中豁免清单 → 降级为 exempt（保持透明，不计红）
  const pushRed = (kind, key, message) => {
    const hit = exemptions.get(`${kind}::${key}`)
    if (hit) {
      stats.exempted++
      diffs.push({ severity: 'exempt', kind, message: `[豁免] ${message} —— 理由：${hit.reason ?? '未填写'}` })
      return
    }
    diffs.push({ severity: 'red', kind, message })
  }

  const codeRouteMap = new Map() // 'GET /a/:*' -> [{pkg, ref}]
  const publicPathSet = new Set()
  const manifestRouteMap = new Map() // 'GET /a/:*' -> [apiRel]
  const manifestPathSet = new Set() // 泛化路径（ANY 方法匹配用）
  const toolDeclsByPkg = new Map() // pkg -> Map(name -> {file})
  const toolManifestByPkg = new Map() // pkg -> Set(name)
  const usedPerms = new Map() // perm -> [{pkg, ref}]
  const declaredPerms = new Map() // perm -> [pkg]
  const pkgsWithoutManifest = []

  const pkgEntries = await readdir(packagesDir, { withFileTypes: true })
  for (const pkgEntry of pkgEntries) {
    if (!pkgEntry.isDirectory()) continue
    const pkg = pkgEntry.name
    stats.packages++
    const pkgDir = join(packagesDir, pkg)
    const srcDir = join(pkgDir, 'src')

    // -- 代码面提取 --
    const tsFiles = await walkTsFiles(srcDir)
    const toolDecls = new Map()
    for (const file of tsFiles) {
      const text = await readFile(file, 'utf8')
      const surface = extractCodeSurface(text)
      const relFile = relative(packagesDir, file).split(sep).join('/')
      for (const route of surface.routes) {
        stats.codeRoutes++
        const key = `${route.method} ${route.path}`
        if (!codeRouteMap.has(key)) codeRouteMap.set(key, [])
        codeRouteMap.get(key).push({ pkg, ref: `${relFile}:${route.line}` })
      }
      for (const tool of surface.tools) {
        stats.codeTools++
        if (!toolDecls.has(tool.name)) toolDecls.set(tool.name, { file: `${relFile}:${tool.line}` })
      }
      for (const perm of surface.perms) {
        if (!usedPerms.has(perm)) usedPerms.set(perm, [])
        usedPerms.get(perm).push({ pkg, ref: relFile })
      }
    }
    const publicPaths = tsFiles.length > 0
      ? extractPublicPaths(await readFile(join(srcDir, 'index.ts'), 'utf8').catch(() => ''))
      : []
    for (const path of publicPaths) publicPathSet.add(generalizePath(path))

    // -- 清单面提取 --
    const pluginYaml = await readYamlOrNull(join(pkgDir, 'plugin.yaml'))
    const apiYaml = await readYamlOrNull(join(pkgDir, 'manifest', 'api.yaml'))
    const hasManifest = pluginYaml !== null && apiYaml !== null
    if (hasManifest) stats.withManifest++

    // 权限声明面独立于 api.yaml：仅落 plugin.yaml + permissions.yaml 的包也可声明权限点
    const permissionsYaml = await readYamlOrNull(join(pkgDir, 'manifest', 'permissions.yaml'))
    for (const source of [pluginYaml?.permissions, permissionsYaml?.points]) {
      for (const perm of source ?? []) {
        const key = String(perm)
        if (!declaredPerms.has(key)) declaredPerms.set(key, [])
        if (!declaredPerms.get(key).includes(pkg)) declaredPerms.get(key).push(pkg)
      }
    }

    if (hasManifest) {
      const apiRel = `${pkg}/manifest/api.yaml`

      const endpointLines = extractEndpointLines(await readFile(join(pkgDir, 'manifest', 'api.yaml'), 'utf8'))
      let previousAbsolute
      for (const line of endpointLines) {
        const { routes, unparseable } = parseEndpointLine(String(line), previousAbsolute)
        for (const bad of unparseable) {
          stats.unparseable++
          diffs.push({ severity: 'red', kind: 'endpoint_unparseable', message: `${apiRel}：摘要片段不符合规范语法（OPT-P0-01）：「${bad}」` })
        }
        if (routes.length > 0) previousAbsolute = routes[routes.length - 1].path
        for (const route of routes) {
          stats.manifestRoutes++
          const key = `${route.method} ${route.path}`
          if (!manifestRouteMap.has(key)) manifestRouteMap.set(key, [])
          manifestRouteMap.get(key).push(apiRel)
          manifestPathSet.add(route.path)
        }
      }
      const manifestTools = new Set((apiYaml.tools ?? []).map(String))
      toolManifestByPkg.set(pkg, manifestTools)
      stats.manifestTools += manifestTools.size
    } else if (tsFiles.length > 0) {
      pkgsWithoutManifest.push(pkg)
    }

    toolDeclsByPkg.set(pkg, toolDecls)
  }

  // -- 权限声明补充源：iam PermissionCatalog（运行时 RBAC 注册权威，代码级事实源） --
  // 清单 permissions.yaml 是文档面；真正注册进 RBAC 的是该目录。已用权限点命中任一_source 即为已声明。
  const catalogText = await readFile(join(packagesDir, 'plugin-iam', 'src', 'index.ts'), 'utf8').catch(() => '')
  for (const match of catalogText.matchAll(/point:\s*'([^']+)'/g)) {
    const perm = match[1]
    if (!declaredPerms.has(perm)) declaredPerms.set(perm, [])
    if (!declaredPerms.get(perm).includes('plugin-iam#PermissionCatalog')) declaredPerms.get(perm).push('plugin-iam#PermissionCatalog')
  }

  // -- 双向比对：路由 --
  for (const [key, refs] of codeRouteMap) {
    if (!manifestRouteMap.has(key)) {
      pushRed('route_undeclared', key, `代码注册路由未见于任何清单：${key}（${refs.map((item) => item.ref).join('，')}）`)
    }
  }
  for (const [key, refs] of manifestRouteMap) {
    if (codeRouteMap.has(key)) continue
    const path = key.slice(key.indexOf(' ') + 1)
    if (publicPathSet.has(path)) continue // 公开路径以 ANY 方法匹配
    pushRed('endpoint_ghost', key, `清单声明路由无代码实现（幽灵 endpoint）：${key}（${refs.join('，')}）`)
  }
  for (const path of publicPathSet) {
    if (manifestPathSet.has(path)) continue
    const covered = [...codeRouteMap.keys()].some((key) => key.slice(key.indexOf(' ') + 1) === path)
    if (!covered) diffs.push({ severity: 'warn', kind: 'public_path_undeclared', message: `公开路径未见于任何清单（先行登记/路由未合入时允许）：${path}` })
  }

  // -- 双向比对：工具（逐包） --
  for (const [pkg, decls] of toolDeclsByPkg) {
    const manifestTools = toolManifestByPkg.get(pkg)
    if (!manifestTools) continue // 无清单包的覆盖缺口走 warn 汇总（P2-04 补齐后转红）
    for (const [name, loc] of decls) {
      if (!manifestTools.has(name)) pushRed('tool_undeclared', `${pkg}::${name}`, `代码注册工具未见于清单 api.yaml tools：${pkg}::${name}（${loc.file}）`)
    }
    for (const name of manifestTools) {
      if (!decls.has(name)) pushRed('tool_ghost', `${pkg}::${name}`, `清单声明工具无代码实现（幽灵 tool）：${pkg}::${name}（${pkg}/manifest/api.yaml）`)
    }
  }

  // -- 双向比对：权限点 --
  for (const [perm, refs] of usedPerms) {
    if (!declaredPerms.has(perm)) {
      pushRed('perm_undeclared', perm, `代码引用权限点未在清单声明：${perm}（${[...new Set(refs.map((item) => `${item.pkg}/${item.ref}`))].slice(0, 4).join('，')}${refs.length > 4 ? ' 等' : ''}）`)
    }
  }
  for (const [perm, pkgs] of declaredPerms) {
    if (!usedPerms.has(perm)) diffs.push({ severity: 'warn', kind: 'perm_unused', message: `清单声明权限点无代码引用（预留/死点，请确认）：${perm}（${pkgs.join('，')}）` })
  }

  for (const pkg of pkgsWithoutManifest) {
    diffs.push({ severity: 'warn', kind: 'manifest_missing', message: `包有 src 注册面但无完整 manifest（P2-04 补齐前豁免比对）：${pkg}` })
  }

  diffs.sort((a, b) => (a.kind + a.message).localeCompare(b.kind + b.message, 'zh-Hans-CN'))
  const reds = diffs.filter((item) => item.severity === 'red')
  return { ok: reds.length === 0, diffs, stats }
}
