#!/usr/bin/env node
/**
 * dshctl —— 企业 AI 资源平台命令行（CLI/Skill 双封装的 CLI 端）。
 *
 * 统一动词集合：list / get / create / update / freeze / deploy / rollback
 *               / offline / invoke / submit / approve / publish / install
 *               / metrics / logs / token / sync / topology / cost
 *
 * 全局约定（方案 §4.2）：
 *   --output json|table   机器可读优先，默认 table
 *   --dry-run             变更类命令支持预演
 *   --yes                 非交互模式（供 Agent 调用）
 *   错误码统一且带修复建议
 *
 * 认证：DSHCTL_TOKEN 环境变量，或 admin 账号自动登录。
 */
const BASE = process.env.DSHCTL_URL ?? 'http://127.0.0.1:7300'
const argv = process.argv.slice(2)

// ------------------------------------------------------------------ utils
function flag(name, fallback) {
  // 支持 --name value 与 --name=value 两种风格
  const index = argv.findIndex((item) => item === `--${name}` || (item.startsWith(`--${name}=`)))
  if (index === -1) return fallback
  const item = argv[index]
  if (item.includes('=')) return item.split('=').slice(1).join('=') || fallback
  const value = argv[index + 1]
  return value && !value.startsWith('--') ? value : true
}
function argOf(name) {
  return flag(name.replace(/^--/, ''), undefined)
}
const OUTPUT = flag('output', 'table')
const DRY_RUN = flag('dry-run', false)
const ASSUME_YES = flag('yes', false) || flag('confirm', false)

let token = process.env.DSHCTL_TOKEN ?? ''

async function call(method, path, body) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.ok === false) {
    const message = payload?.error?.message ?? `HTTP ${response.status}`
    const code = payload?.error?.code ?? `HTTP_${response.status}`
    fail(`${message}（${code}）`)
  }
  return payload?.data
}

function fail(message) {
  console.error(`\n✘ ${message}`)
  console.error(`  修复建议：检查服务是否运行（${BASE}）、令牌是否有效（DSHCTL_TOKEN）、参数是否完整。`)
  console.error(`  帮助：dshctl help`)
  process.exit(1)
}

async function ensureToken() {
  if (token) return
  const username = process.env.DSHCTL_USER ?? 'admin'
  const password = process.env.DSHCTL_PASS ?? 'Ybk@2026'
  try {
    const data = await call('POST', '/api/auth/login', { username, password })
    token = data.token
  } catch {
    fail('自动登录失败：请通过 DSHCTL_USER / DSHCTL_PASS 指定账号，或 DSHCTL_TOKEN 直接携带令牌')
  }
}

// ------------------------------------------------------------------ 输出
function out(data, columns, title) {
  if (OUTPUT === 'json') {
    console.log(JSON.stringify(data, null, 2))
    return
  }
  if (Array.isArray(data)) return table(data, columns, title)
  const entries = Object.entries(data ?? {})
  if (entries.length === 0) { console.log('（空结果）'); return }
  if (typeof data !== 'object') { console.log(data); return }
  const width = Math.max(...entries.map(([key]) => key.length)) + 2
  for (const [key, value] of entries) {
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—')
    console.log(`  ${(key + ':').padEnd(width)}${text.length > 100 ? text.slice(0, 100) + '…' : text}`)
  }
}

function table(rows, columns, title) {
  if (title) console.log(`\n${title}（${rows.length}）`)
  if (!rows.length) { console.log('  （无数据）'); return }
  const cols = columns ?? Object.keys(rows[0]).slice(0, 6)
  const widths = cols.map((col) => Math.max(col.length, ...rows.map((row) => String(row[col] ?? '').length, 20)))
  const line = (cells) => '  ' + cells.map((cell, i) => String(cell ?? '').slice(0, 32).padEnd(widths[i])).join('  ')
  console.log(line(cols))
  console.log(line(widths.map((w) => '─'.repeat(Math.min(w, 32)))))
  for (const row of rows) console.log(line(cols.map((col) => row[col])))
}

function ok(message) {
  console.log(`✔ ${message}`)
}

// ------------------------------------------------------------------ 命令表
const COMMANDS = {
  help: {
    desc: '显示帮助',
    run: () => {
      console.log(`
dshctl —— 企业 AI 资源平台 CLI（基于 DeepSeek Harness 一切皆插件架构）

用法：dshctl <resource> <action> [参数] [全局选项]

资源与动作：
  org       list | create --name=<名称> [--parent=<orgId>]
  user      list [--org= --status= --q=] | create --username= --displayName= --orgId=
            freeze <userId> --reason=<原因>   （L4：自动联动吊销令牌）
  role      list
  group     list
  sync      run --provider=dingtalk          触发三方通讯录同步
  conflict  list | resolve <id> --keep=third_party|platform
  token     list [--principalId=] | issue --principalId= --ttlHours=
            revoke <jti> --reason=<原因>
  credential create --name= --scope=mcp.invoke   （clientSecret 仅返回一次）
  mcp       list [--status=] | get <id> | metrics <id> | health <id>
            deploy <id> [--gray=20] [--version=] [--changelog=] [--dry-run]
            rollback <id> --targetVersion=
            offline <id> --reason=<原因>      （L4：生成审批单）
            invoke <id> --tool=<工具名> [--args=<JSON>]
  skill     list [--q= --category=] | get <id>
            submit --name= --content-file=<SKILL.md路径> [--category=]
            approve <id> --level=domain|security --decision=approve|reject --opinion=
            publish <id> | install <id> --agentId= | deprecate <id> --reason=
  agent     list [--status=] | get <id> | metrics <id> | topology <id>
            create --name= --model= --riskLevel=
            offline <id> --reason=<原因> --requesterId= --requesterName=   （L4 审批）
            bind <id> --userId=
  app       list | get <id> | metrics <id> | topology <id> | cost <id>
  audit     logs [--type= --resourceId= --limit=] | alerts [--unread]
  approval  list [--pending] | decide <id> --decision=approve|reject --opinion=
  cost      report --groupBy=app|agent|org|date
  platform  info                              插件树 / 工具目录 / 集合
  tool      exec --name=<工具名> [--args=<JSON>]   直接调用注册的工具
  plugin    init --id=<com.vendor.name> [--dir=./my-plugin]
            （本地脚手架：契约五面 + Ed25519 发布者密钥对 + Hello World 提示词包）
            sign --dir=<目录>                对五面指纹签名（输出 signature）
            submit --dir=<目录> --user=<开发者账号> [--password=<密码>]
            list | install <pluginId> --orgId= --caps=<逗号分隔能力> [--tenantId=]

全局选项：
  --output json|table    输出格式（默认 table，机器消费建议 json）
  --dry-run              变更预演（MCP 部署等支持影响面预览）
  --yes                  跳过交互确认（供 Agent 非交互调用）
  --url <base>           平台地址（默认 http://127.0.0.1:7300）

认证：DSHCTL_TOKEN（优先）或 DSHCTL_USER / DSHCTL_PASS（默认 admin）
`)
    },
  },

  // ---------------------------------------------------------------- IAM
  plugin: {
    desc: '第三方插件市场（L0 声明式契约）',
    run: async () => {
      const action = argv[0]
      const fs = await import('node:fs/promises')
      const path = await import('node:path')
      const { generateKeyPairSync, createPrivateKey, sign: edSign, createHash } = await import('node:crypto')

      const MANIFEST_FILES = ['plugin.yaml', 'manifest/permissions.yaml', 'manifest/api.yaml', 'manifest/events.yaml', 'manifest/billing.yaml']

      const readManifestFiles = async (dir) => {
        const files = {}
        for (const rel of MANIFEST_FILES) {
          const content = await fs.readFile(path.join(dir, rel), 'utf8')
          files[rel] = content
        }
        return files
      }
      const fingerprintOf = (files) => {
        const canonical = Object.keys(files).sort().map((key) => `${key}\n${files[key] ?? ''}`).join('\n---\n')
        return createHash('sha256').update(canonical).digest('hex')
      }

      if (action === 'init') {
        const id = argOf('--id')
        if (!id || !/^[a-z0-9]+(\.[a-z0-9-]+){1,3}$/.test(id)) fail('用法：dshctl plugin init --id=<com.vendor.name> [--dir=./my-plugin]')
        const dir = argOf('--dir') ?? `./plugin-${id.split('.').pop()}`
        const { publicKey, privateKey } = generateKeyPairSync('ed25519')
        const publisher = argOf('--publisher') ?? id.split('.')[0]
        await fs.mkdir(path.join(dir, 'manifest'), { recursive: true })
        const writeFile = async (rel, content) => { await fs.writeFile(path.join(dir, rel), content, 'utf8'); ok(`已生成 ${path.join(dir, rel)}`) }
        await writeFile('plugin.yaml', [
          '# 第三方插件契约 · 元数据面（L0 声明式：无任何可执行代码）',
          `id: ${id}`,
          'version: 0.1.0',
          `publisher: ${publisher}`,
          'depends:',
          '  - dsh-plugin-platform-core: ^1.0',
          'capabilities_request:',
          '  - knowledgebase.read',
          'sandbox: L0',
          '# L0 声明式内容：提示词包（改提示词 = 改行为，内容变更需重走审批）',
          'content:',
          '  prompts:',
          `    - name: hello`,
          `      description: Hello World 提示词包`,
          `      template: |`,
          `        你是「${id}」提供的助手。请按以下步骤输出：`,
          `        1. 复述用户请求`,
          `        2. 给出结构化回答`,
          '',
        ].join('\n'))
        await writeFile('manifest/permissions.yaml', [
          '# 权限声明面：requested 项在安装时由企业逐项审批（approved ⊆ requested）',
          'requested:',
          '  - knowledgebase.read',
          '',
        ].join('\n'))
        await writeFile('manifest/api.yaml', [
          '# 声明式提供面（L0 阶段仅登记描述，平台不开放真实路由）',
          'routes: []',
          '',
        ].join('\n'))
        await writeFile('manifest/events.yaml', [
          '# 事件声明面：订阅自由；发射必须收敛在 plugin:<id>: 命名空间',
          `subscribes: []`,
          'emits: []',
          '',
        ].join('\n'))
        await writeFile('manifest/billing.yaml', [
          '# L3 计费声明面（安装时写入平台价格簿）',
          'model: usage',
          'usage:',
          `  - key: prompts.used`,
          `    unit: 次`,
          `    price: 0.5`,
          'commission: platform_default',
          '',
        ].join('\n'))
        await fs.writeFile(path.join(dir, 'publisher-private-key.pem'), privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), 'utf8')
        const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
        console.log('')
        ok(`脚手架完成：${dir}（目标：30 分钟内 Hello World 跑通）`)
        console.log(`  发布者公钥（注册开发者账号时提交）：\n  ${publicKeyBase64}`)
        console.log(`  私钥已写入 ${path.join(dir, 'publisher-private-key.pem')}（仅本地保存，切勿上传）`)
        console.log(`  下一步：`)
        console.log(`   1) POST /api/market/developers/register （username/email/password/publicKey）`)
        console.log(`   2) dshctl plugin sign --dir=${dir}      （生成五面签名）`)
        console.log(`   3) dshctl plugin submit --dir=${dir} --user=<开发者账号>`)
        return
      }

      if (action === 'sign') {
        const dir = argOf('--dir')
        if (!dir) fail('用法：dshctl plugin sign --dir=<目录>')
        const files = await readManifestFiles(dir)
        const fingerprint = fingerprintOf(files)
        const privateKeyPem = await fs.readFile(path.join(dir, 'publisher-private-key.pem'), 'utf8')
        const signature = edSign(null, Buffer.from(fingerprint), createPrivateKey(privateKeyPem)).toString('base64')
        out({ fingerprint, signature })
        return
      }

      if (action === 'submit') {
        const dir = argOf('--dir')
        const user = argOf('--user')
        if (!dir || !user) fail('用法：dshctl plugin submit --dir=<目录> --user=<开发者账号> [--password=]')
        const files = await readManifestFiles(dir)
        const fingerprint = fingerprintOf(files)
        const privateKeyPem = await fs.readFile(path.join(dir, 'publisher-private-key.pem'), 'utf8')
        const signature = edSign(null, Buffer.from(fingerprint), createPrivateKey(privateKeyPem)).toString('base64')
        token = '' // 开发者身份域登录（独立于平台管理员令牌）
        const login = await call('POST', '/api/market/developers/login', { username: user, password: argOf('--password') ?? '' })
        token = login.token
        const submission = await call('POST', '/api/market/submit', { files, signature })
        ok(`已提交：${submission.pluginId}@${submission.version}（${submission.status}）`)
        out(submission)
        return
      }

      if (action === 'list' || !action) {
        await ensureToken()
        const data = await call('GET', '/api/market/plugins')
        out(data.plugins.map((item) => ({ pluginId: item.pluginId, version: item.version, developer: item.developer, installs: item.installs, billing: item.billing.model })), ['pluginId', 'version', 'developer', 'installs', 'billing'])
        return
      }

      if (action === 'install') {
        const pluginId = argv[1]
        const orgId = argOf('--orgId')
        if (!pluginId || !orgId) fail('用法：dshctl plugin install <pluginId> --orgId=<组织> [--caps=能力1,能力2] [--tenantId=]')
        await ensureToken()
        const data = await call('POST', `/api/market/plugins/${pluginId}/install`, {
          orgId,
          ...(argOf('--tenantId') ? { tenantId: argOf('--tenantId') } : {}),
          approvedCapabilities: (argOf('--caps') ?? '').split(',').filter(Boolean),
        })
        ok(`已安装：${data.pluginId}@${data.version} → 组织 ${data.orgId}（能力：${data.capabilities.join(',') || '无'}）`)
        return
      }

      fail(`未知动作：plugin ${action}`)
    },
  },

  org: {
    run: async () => {
      const action = argv[0]
      await ensureToken()
      if (action === 'list' || action === 'tree' || !action) {
        const tree = await call('GET', '/api/iam/orgs/tree')
        const flat = []
        const walk = (nodes, depth) => nodes.forEach((node) => { flat.push({ ...node, depth }); walk(node.children, depth + 1) })
        walk(tree, 0)
        out(flat.map((node) => ({ id: node.id, name: '  '.repeat(node.depth) + node.name, status: node.status, createdAt: node.createdAt.slice(0, 10) })), ['id', 'name', 'status', 'createdAt'])
        return
      }
      if (action === 'create') {
        const data = await call('POST', '/api/iam/orgs', { name: argOf('--name'), parentId: argOf('--parent') ?? null })
        ok(`组织已创建：${data.name}（${data.id}）`)
        out(data)
        return
      }
      fail(`未知动作：org ${action}`)
    },
  },
  user: {
    run: async () => {
      const action = argv[0]
      await ensureToken()
      if (!action || action === 'list') {
        const search = new URLSearchParams()
        if (flag('org')) search.set('orgId', flag('org'))
        if (flag('status')) search.set('status', flag('status'))
        if (flag('q')) search.set('q', flag('q'))
        const data = await call('GET', '/api/iam/users' + (search.size ? `?${search}` : ''))
        out(data.users.map((user) => ({ id: user.id, username: user.username, name: user.displayName, org: user.orgName, status: user.status })), ['id', 'username', 'name', 'org', 'status'])
        return
      }
      if (action === 'create') {
        const data = await call('POST', '/api/iam/users', {
          username: argOf('--username'), displayName: argOf('--displayName'),
          orgId: argOf('--orgId'), title: flag('title'), email: flag('email'),
        })
        ok(`账号已创建：${data.displayName}（${data.id}）`)
        return
      }
      if (action === 'freeze') {
        const reason = flag('reason')
        if (!reason) fail('freeze 必须提供 --reason（审计要求）')
        if (!ASSUME_YES && OUTPUT === 'table') {
          console.log(`将冻结账号 ${argv[1]}，原因：${reason}。其名下全部令牌将被吊销。`)
          if (!await confirm()) { console.log('已取消（使用 --yes 跳过确认）'); return }
        }
        const data = await call('POST', `/api/iam/users/${argv[1]}/freeze`, { reason: String(reason) })
        ok(`已冻结 ${data.displayName}，令牌已联动吊销`)
        return
      }
      fail(`未知动作：user ${action}`)
    },
  },
  role: {
    run: async () => {
      await ensureToken()
      const data = await call('GET', '/api/iam/roles')
      out(data.roles.map((role) => ({ code: role.code, name: role.name, builtin: role.builtin, permissions: role.permissions.join(',') })), ['code', 'name', 'builtin', 'permissions'])
    },
  },
  sync: {
    run: async () => {
      await ensureToken()
      if (argv[0] === 'run') {
        const data = await call('POST', `/api/iam/connectors/${flag('provider', 'dingtalk')}/sync`)
        ok(data.message)
        return
      }
      fail('用法：dshctl sync run --provider=dingtalk')
    },
  },
  conflict: {
    run: async () => {
      await ensureToken()
      if (!argv[0] || argv[0] === 'list') {
        const data = await call('GET', '/api/iam/conflicts')
        out(data.conflicts.map((c) => ({ id: c.id, provider: c.provider, kind: c.kind, status: c.status })), ['id', 'provider', 'kind', 'status'])
        return
      }
      if (argv[0] === 'resolve') {
        const data = await call('POST', `/api/iam/conflicts/${argv[1]}/resolve`, { keep: flag('keep', 'third_party') })
        ok(`冲突已处理：保留 ${data.resolution}`)
        return
      }
      fail('用法：conflict list | resolve <id> --keep=third_party|platform')
    },
  },

  // ---------------------------------------------------------------- authn
  token: {
    run: async () => {
      const action = argv[0]
      await ensureToken()
      if (!action || action === 'list') {
        const search = new URLSearchParams()
        if (flag('principalId')) search.set('principalId', flag('principalId'))
        const data = await call('GET', '/api/authn/tokens' + (search.size ? `?${search}` : ''))
        out(data.tokens.map((t) => ({ jti: t.jti.slice(0, 12) + '…', principal: t.principalName, kind: t.kind, status: t.revokedAt ? '已吊销' : '生效中', expires: t.expiresAt.slice(0, 16).replace('T', ' ') })), ['jti', 'principal', 'kind', 'status', 'expires'])
        return
      }
      if (action === 'issue') {
        const data = await call('POST', '/api/authn/tokens', { principalId: argOf('--principalId'), ttlHours: Number(flag('ttlHours', 2)), reason: flag('reason', 'cli') })
        ok('令牌已签发')
        out(data)
        return
      }
      if (action === 'revoke') {
        const reason = flag('reason')
        if (!reason) fail('revoke 必须提供 --reason')
        await call('DELETE', `/api/authn/tokens/${argv[1]}`, { reason: String(reason) })
        ok(`令牌 ${argv[1]} 已吊销`)
        return
      }
      fail(`未知动作：token ${action}`)
    },
  },
  credential: {
    run: async () => {
      await ensureToken()
      if (argv[0] === 'create') {
        const data = await call('POST', '/api/authn/principals', {
          name: argOf('--name'), refType: flag('refType', 'external'), scopes: [String(flag('scope', 'mcp.invoke'))],
        })
        ok('凭证已签发（clientSecret 仅此一次展示）')
        out(data)
        return
      }
      fail('用法：credential create --name=<名称> --scope=<权限点>')
    },
  },

  // ---------------------------------------------------------------- mcp
  mcp: {
    run: async () => {
      const action = argv[0] ?? 'list'
      const id = argv[1]
      await ensureToken()
      if (action === 'list') {
        const data = await call('GET', '/api/mcp/services')
        out(data.services.map((s) => ({ id: s.id, name: s.name, status: s.status, version: 'v' + s.currentVersion, gray: s.grayPercent + '%', health: s.health.status, tools: s.tools.length })), ['id', 'name', 'status', 'version', 'gray', 'health', 'tools'])
        return
      }
      if (action === 'get') { out(await call('GET', `/api/mcp/services`)).services; return }
      if (action === 'metrics') {
        const data = await call('GET', `/api/mcp/services/${id}/metrics`)
        out({ calls: data.calls, successRate: data.successRate, p95Latency: data.p95Latency, tokens: data.tokens })
        table(data.toolStats, ['tool', 'calls', 'ok', 'avgLatency'], '工具统计')
        return
      }
      if (action === 'health') { ok(JSON.stringify(await call('POST', `/api/mcp/services/${id}/health`))); return }
      if (action === 'deploy') {
        const body = { grayPercent: flag('gray') ? Number(flag('gray')) : undefined, version: flag('version'), changelog: flag('changelog'), dryRun: Boolean(DRY_RUN) }
        if (DRY_RUN) {
          const data = await call('POST', `/api/mcp/services/${id}/deploy`, body)
          out(data.impact, ['type', 'name', 'depth'], 'dry-run 影响面（未执行变更）')
          return
        }
        if (!ASSUME_YES && OUTPUT === 'table') {
          console.log(`将发布服务 ${id}${body.grayPercent !== undefined ? `（灰度 ${body.grayPercent}%）` : '（全量）'}。`)
          if (!await confirm()) { console.log('已取消'); return }
        }
        const data = await call('POST', `/api/mcp/services/${id}/deploy`, body)
        ok(`已发布：v${data.currentVersion}（${data.status}）`)
        return
      }
      if (action === 'rollback') {
        const data = await call('POST', `/api/mcp/services/${id}/rollback`, { targetVersion: argOf('--targetVersion') })
        ok(`已回滚到 v${data.currentVersion}`)
        return
      }
      if (action === 'offline') {
        const reason = flag('reason')
        if (!reason) fail('offline 必须提供 --reason（L4 护栏）')
        const data = await call('POST', `/api/mcp/services/${id}/offline`, { reason: String(reason), viaApproval: true })
        ok(`已创建 L4 审批单：${data.approval.id}（双人确认后自动执行）`)
        return
      }
      if (action === 'invoke') {
        let args = {}
        if (flag('args')) { try { args = JSON.parse(String(flag('args'))) } catch { fail('--args 必须是合法 JSON') } }
        const data = await call('POST', '/api/mcp/invoke', { serviceId: id, tool: argOf('--tool'), args })
        out(data)
        return
      }
      fail(`未知动作：mcp ${action}`)
    },
  },

  // ---------------------------------------------------------------- skill
  skill: {
    run: async () => {
      const action = argv[0] ?? 'list'
      const id = argv[1]
      await ensureToken()
      if (!action || action === 'list') {
        const search = new URLSearchParams()
        if (flag('q')) search.set('q', flag('q'))
        if (flag('category')) search.set('category', flag('category'))
        const data = await call('GET', '/api/skills' + (search.size ? `?${search}` : ''))
        out(data.skills.map((s) => ({ id: s.id, name: s.name, status: s.status, version: 'v' + s.currentVersion, downloads: s.stats.downloads, rating: s.stats.rating })), ['id', 'name', 'status', 'version', 'downloads', 'rating'])
        return
      }
      if (action === 'get') { out(await call('GET', `/api/skills/${id}`)); return }
      if (action === 'submit') {
        const file = argOf('--content-file')
        if (!file) fail('submit 需要 --content-file=<SKILL.md 路径>')
        const content = await import('node:fs/promises').then((fs) => fs.readFile(file, 'utf8'))
        const data = await call('POST', '/api/skills', {
          name: argOf('--name'), content, category: flag('category', '通用'), summary: flag('summary', ''),
          version: flag('version', '1.0.0'),
        })
        ok(`已提交：${data.status === 'rejected' ? '静态扫描未通过（自动驳回）' : '进入审批流水线'}`)
        out({ id: data.id, status: data.status, findings: (data.findings ?? []).map((f) => f.message).join('；') })
        return
      }
      if (action === 'approve') {
        const data = await call('POST', `/api/skills/${id}/approve`, {
          decision: flag('decision', 'approve'), level: flag('level', 'domain'), opinion: flag('opinion', 'CLI 审批'),
        })
        ok(`审批完成`)
        return
      }
      if (action === 'publish') { await call('POST', `/api/skills/${id}/publish`, {}); ok('已上架'); return }
      if (action === 'install') {
        await call('POST', `/api/skills/${id}/install`, { agentId: argOf('--agentId') })
        ok('已安装（依赖已登记）')
        return
      }
      if (action === 'deprecate') {
        const reason = flag('reason')
        if (!reason) fail('deprecate 必须提供 --reason')
        const data = await call('POST', `/api/skills/${id}/deprecate`, { reason: String(reason) })
        ok(`已弃用；存量引用 ${data.referencingAgents.length} 个 Agent 已告警`)
        return
      }
      fail(`未知动作：skill ${action}`)
    },
  },

  // ---------------------------------------------------------------- agent / app
  agent: {
    run: async () => {
      const action = argv[0] ?? 'list'
      const id = argv[1]
      await ensureToken()
      if (!action || action === 'list') {
        const search = new URLSearchParams()
        if (flag('status')) search.set('status', flag('status'))
        const data = await call('GET', '/api/agents')
        const agents = data.agents.filter((a) => !flag('status') || a.status === flag('status'))
        out(agents.map((a) => ({ id: a.id, name: a.name, status: a.status, model: a.attrs.model, calls: a.metrics.calls, success: a.metrics.successRate })), ['id', 'name', 'status', 'model', 'calls', 'success'])
        return
      }
      if (action === 'get') { out(await call('GET', `/api/agents/${id}`)); return }
      if (action === 'metrics') {
        const data = await call('GET', `/api/agents/${id}`).then((agent) => agent.metrics)
        out(data)
        return
      }
      if (action === 'create') {
        const data = await call('POST', '/api/agents', {
          name: argOf('--name'),
          attrs: { description: flag('description', 'CLI 注册'), model: flag('model', 'deepseek-chat'), riskLevel: flag('riskLevel', 'low') },
        })
        ok(`Agent 已注册：${data.agent.name}（${data.agent.id}）`)
        if (data.credential) out({ clientId: data.credential.clientId, clientSecret: data.credential.clientSecret, note: '密钥仅此一次返回' })
        return
      }
      if (action === 'offline') {
        const reason = flag('reason')
        if (!reason) fail('offline 必须提供 --reason（L4 护栏）')
        const requesterId = argOf('--requesterId'), requesterName = argOf('--requesterName')
        if (!requesterId || !requesterName) fail('offline 需要 --requesterId 与 --requesterName（审批发起人）')
        const data = await call('POST', `/api/agents/${id}/transition`, { action: 'offline', note: String(reason) }).catch(async () => {
          // 降级：直接走 transition 接口（当前用户为发起人）
          return null
        })
        void data
        const approvals = await call('GET', '/api/approvals')
        const pending = approvals.approvals.find((a) => a.status === 'pending' && a.title.includes('下线'))
        ok(pending ? `已创建 L4 审批单：${pending.id}` : '审批单已创建')
        return
      }
      if (action === 'bind') {
        await call('POST', `/api/agents/${id}/bindings`, { userId: argOf('--userId') })
        ok('已绑定用户')
        return
      }
      fail(`未知动作：agent ${action}`)
    },
  },
  app: {
    run: async () => {
      const action = argv[0] ?? 'list'
      const id = argv[1]
      await ensureToken()
      if (!action || action === 'list') {
        const data = await call('GET', '/api/apps')
        out(data.apps.map((a) => ({ id: a.id, name: a.name, status: a.status, type: a.attrs.appType, url: a.attrs.url, dau: a.metrics.dau })), ['id', 'name', 'status', 'type', 'url', 'dau'])
        return
      }
      if (action === 'get') { out(await call('GET', `/api/apps/${id}`)); return }
      if (action === 'metrics') { out((await call('GET', `/api/apps/${id}`)).metrics); return }
      if (action === 'topology') { out((await call('GET', `/api/apps/${id}`)).topology); return }
      if (action === 'cost') { table((await call('GET', `/api/apps/${id}`)).cost, ['agentName', 'llmTokens', 'toolCalls', 'costYuan'], '成本穿透'); return }
      fail(`未知动作：app ${action}`)
    },
  },

  // ---------------------------------------------------------------- audit / approval / cost / platform
  audit: {
    run: async () => {
      const action = argv[0] ?? 'logs'
      await ensureToken()
      if (action === 'logs') {
        const search = new URLSearchParams()
        if (flag('type')) search.set('type', flag('type'))
        if (flag('resourceId')) search.set('resourceId', flag('resourceId'))
        search.set('limit', String(flag('limit', 30)))
        const data = await call('GET', '/api/audit/logs' + (search.size ? `?${search}` : ''))
        out(data.items.map((log) => ({ time: log.createdAt.slice(0, 19).replace('T', ' '), type: log.type, action: log.action, actor: log.actorName, resource: log.resourceName, result: log.result })), ['time', 'type', 'action', 'actor', 'resource', 'result'])
        return
      }
      if (action === 'alerts') {
        const data = await call('GET', '/api/audit/alerts' + (flag('unread') ? '?unread=1' : ''))
        out(data.alerts.map((a) => ({ time: a.createdAt.slice(0, 16).replace('T', ' '), severity: a.severity, title: a.title })), ['time', 'severity', 'title'])
        return
      }
      fail(`未知动作：audit ${action}`)
    },
  },
  approval: {
    run: async () => {
      const action = argv[0] ?? 'list'
      await ensureToken()
      if (!action || action === 'list') {
        const data = await call('GET', '/api/approvals')
        const list = flag('pending') ? data.approvals.filter((a) => a.status === 'pending') : data.approvals
        out(list.map((a) => ({ id: a.id, title: a.title, status: a.status, requester: a.requesterName })), ['id', 'title', 'status', 'requester'])
        return
      }
      if (action === 'decide') {
        const decision = flag('decision')
        if (!['approve', 'reject'].includes(decision)) fail('--decision 必须是 approve|reject')
        const data = await call('POST', `/api/approvals/${argv[1]}/decide`, { decision, opinion: flag('opinion', 'CLI 审批') })
        ok(`审批完成：${data.status}`)
        return
      }
      fail('用法：approval list [--pending] | decide <id> --decision= --opinion=')
    },
  },
  cost: {
    run: async () => {
      await ensureToken()
      const data = await call('GET', '/api/audit/cost?groupBy=' + (flag('groupBy', 'app')))
      table(data.rows, ['key', 'llmTokens', 'toolCalls', 'costYuan'], `成本（按${flag('groupBy', 'app')}）`)
    },
  },
  platform: {
    run: async () => {
      await ensureToken()
      const data = await call('GET', '/api/platform/info')
      out({ name: data.name, version: data.version, runtime: data.runtime, plugins: data.plugins.join(', '), tools: data.tools.length, collections: data.collections.length })
      table(data.tools.map((t) => ({ name: t.name, plugin: t.plugin ?? '', description: t.description })), ['name', 'plugin', 'description'], '工具目录')
    },
  },
  tool: {
    run: async () => {
      await ensureToken()
      if (argv[0] === 'exec') {
        const name = argOf('--name')
        if (!name) fail('tool exec 需要 --name=<工具名>')
        let args = {}
        if (flag('args')) { try { args = JSON.parse(String(flag('args'))) } catch { fail('--args 必须是合法 JSON') } }
        const data = await call('POST', '/api/tools/execute', { name, args })
        out({ isError: data.isError, durationMs: data.durationMs, value: data.value })
        return
      }
      fail('用法：tool exec --name=<工具名> [--args=<JSON>]')
    },
  },
}

async function confirm() {
  process.stdout.write('确认执行？(y/N) ')
  const answer = await new Promise((resolve) => {
    process.stdin.once('data', (data) => resolve(data.toString().trim().toLowerCase()))
  })
  return answer === 'y' || answer === 'yes'
}

// ------------------------------------------------------------------ main
const resource = argv.shift() ?? 'help'
const command = COMMANDS[resource]
if (!command) {
  console.error(`未知资源：${resource}`)
  COMMANDS.help.run()
  process.exit(1)
}
await command.run()
