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
  const username = process.env.DSHCTL_USER
  const password = process.env.DSHCTL_PASS
  if (!username || !password) {
    fail('未提供凭据：请通过 DSHCTL_USER / DSHCTL_PASS 指定账号口令，或 DSHCTL_TOKEN 直接携带令牌')
  }
  try {
    const data = await call('POST', '/api/auth/login', { username, password })
    token = data.token
  } catch {
    fail('自动登录失败：请检查 DSHCTL_USER / DSHCTL_PASS 是否正确，或改用 DSHCTL_TOKEN')
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
  credential list                                        列出机器凭证（principalId/clientId/scopes/状态）
          create --name= --scope=a,b[,c|*] [--refType= --refId=]   （clientSecret 仅返回一次）
          scopes <principalId> --scopes=a,b[,c|*]   调整权限范围（存量令牌联动吊销）
          rotate <principalId>                       轮换 clientSecret（仅本次展示，旧值立即失效）
  mcp       list [--status=] | get <id> | metrics <id> | health <id>
            deploy <id> [--gray=20] [--version=] [--changelog=] [--dry-run]
            rollback <id> --targetVersion=
            offline <id> --reason=<原因>      （L4：生成审批单）
            invoke <id> --tool=<工具名> [--args=<JSON>]
  skill     list [--q= --category=] | get <id>
            submit --name= --content-file=<SKILL.md路径> [--category=] [--package=<skill.zip>]
            approve <id> --level=domain|security --decision=approve|reject --opinion=
            publish <id> | install <id> --agentId= | deprecate <id> --reason=
            storage get | storage set --mode=local|nas [--nas-id= --base-path=]
  nas       list [--status= --q=] | get <id>
            create --name= --gateway-url= --token= --nas-ip= [--root-path=] [--staging-dir=]
            import --config=<mcpServers JSON 或 @文件> [--name=]   （synology-filestation 配置一键纳管）
            health <id> | online <id> | offline <id> --reason=
            shares <id> | files <id> [--path=] | mkdir <id> --path= | delete <id> --path=
            upload <id> --file=<本地路径> --dest=<NAS路径> | search <id> --pattern= [--path=]
  connector gateway get | gateway set --base-url= --admin-token-env=VAR | gateway health
            catalog providers [--search=] | catalog actions [--service=] [--search=]
            catalog action <actionId> [--guide]
            connections list [--org=] | connections create --provider= --auth-type=no_auth|api_key|oauth
                     --org=<orgId> [--alias-suffix=main] [--values=@file.json] [--scopes=a,b]
                     connections delete <id> --yes [--force]
            execute --action=<actionId> [--connection=<alias>] [--input=@file.json] [--dry-run]
            perm-groups list | get | create --file=@group.json | impact <id> | delete <id> --yes
            runs [--service=] [--ok=true|false] [--limit=50]
            reconcile                              runs 对账（有 run 无 meter 即绕行告警，人工复核口径）
            tokens                                 oct_ 台账（永不返回令牌值）
  agent     list [--status=] | get <id> | metrics <id> | topology <id>
            create --name= --model= --riskLevel=
            offline <id> --reason=<原因> --requesterId= --requesterName=   （L4 审批）
            bind <id> --userId=
  app       list | get <id> | metrics <id> | topology <id> | cost <id>
            report <id> [--dau= --sessions= --avg-depth= --retention7= --date=]   （应用指标主动上报）
  usage     record --org= --subject= --principal= --resource= --meter=key:value:unit[,...]
                                            （计量事件主动推送，schema v1 + 幂等键；
                                             meter key 须与价格簿一致：mcp:* → tokens、model:<slug> → output_tokens，
                                             不匹配会被硬拒绝，报错直接给出期望键）
            [--idempotency-key= --tenant-id=]
            events [--principal= --resource= --limit=] | totals [--principal= --from=]
  audit     logs [--type= --resourceId= --limit=] | alerts [--unread] | read-all
  approval  list [--pending] | decide <id> --decision=approve|reject --opinion=
  cost      report --groupBy=app|agent|org|date
  platform  info                              插件树 / 工具目录 / 集合
  update    status | check                    平台版本与上游更新状态 / 立即检查（60s 冷却）
            apply [--dry-run] [--reason=<原因>]  一键升级（git pull + npm install，source 形态）
            set [--auto=on|off] [--hours=24]   自动检查偏好
  connect   code [--template=readonly|operator|full] [--ttl=15] [--remark=]
            （创建一次性接入码：远程 dsh 凭此申请机器凭证）
            codes | clients | disable <clientId> --reason=<原因>
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
      const action = argv[0] ?? 'list'
      const id = argv[1]
      if (action === 'list') {
        const data = await call('GET', '/api/authn/principals')
        out(data.principals.filter((p) => p.type === 'machine').map((p) => ({
          principalId: p.id,
          clientId: p.clientId ?? '—',
          name: p.name,
          refType: p.refType ?? 'external',
          scopes: (p.scopes ?? []).join(','),
          status: p.status,
          activeTokens: p.activeTokens,
        })), ['principalId', 'clientId', 'name', 'refType', 'scopes', 'status', 'activeTokens'])
        return
      }
      if (action === 'create') {
        const scopes = String(flag('scope', 'mcp.invoke')).split(',').map((s) => s.trim()).filter(Boolean)
        const payload = { name: argOf('--name'), refType: flag('refType', 'external'), scopes }
        const refId = argOf('--refId')
        if (refId) payload.refId = String(refId)
        if (!payload.name) fail('用法：credential create --name=<名称> --scope=<权限点>[,<权限点>…] [--refType= --refId=]')
        const data = await call('POST', '/api/authn/principals', payload)
        ok('凭证已签发（clientSecret 仅此一次展示）')
        out(data)
        return
      }
      if (action === 'scopes') {
        const scopesRaw = argOf('--scopes')
        if (!id || !scopesRaw) fail('用法：credential scopes <principalId> --scopes=<权限点>[,<权限点>…|*]')
        const scopes = String(scopesRaw).split(',').map((s) => s.trim()).filter(Boolean)
        const data = await call('PATCH', `/api/authn/principals/${id}`, { scopes })
        ok(`权限范围已更新为 ${data.scopes.join(',')}（存量令牌已联动吊销，机器侧需重新换牌）`)
        out({ principalId: data.id, name: data.name, scopes: data.scopes.join(','), status: data.status })
        return
      }
      if (action === 'rotate') {
        if (!id) fail('用法：credential rotate <principalId>')
        const data = await call('POST', `/api/authn/principals/${id}/rotate-secret`)
        ok('clientSecret 已轮换（新值仅此一次展示，旧值立即失效，存量令牌已全部吊销）')
        out(data)
        return
      }
      fail('用法：credential list | create --name= --scope=a,b[,c|*] [--refType= --refId=] | scopes <principalId> --scopes=a,b[,c|*] | rotate <principalId>')
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
        ok(`已创建 L4 审批单：${data.approval.id}（审批通过后自动执行）`)
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

  // ---------------------------------------------------------------- nas
  nas: {
    desc: 'NAS 文件存储资产（FS 类，经 MCP 网关访问）',
    run: async () => {
      const action = argv[0] ?? 'list'
      const id = argv[1]
      await ensureToken()
      if (action === 'list') {
        const search = new URLSearchParams()
        if (flag('status')) search.set('status', flag('status'))
        if (flag('q')) search.set('q', flag('q'))
        const data = await call('GET', '/api/nas' + (search.size ? `?${search}` : ''))
        out(data.items.map((n) => ({ id: n.id, name: n.name, status: n.status, health: n.health?.status ?? '—', tools: n.gatewayToolCount, rootPath: n.attrs?.rootPath ?? '/' })), ['id', 'name', 'status', 'health', 'tools', 'rootPath'])
        return
      }
      if (action === 'get') { out(await call('GET', `/api/nas/${id}`)); return }
      if (action === 'create') {
        const name = argOf('--name')
        const gatewayUrl = argOf('--gateway-url')
        const accessToken = argOf('--token')
        const nasIp = argOf('--nas-ip')
        if (!name || !gatewayUrl || !accessToken || !nasIp) fail('用法：nas create --name= --gateway-url= --token= --nas-ip= [--root-path=] [--description=]')
        const data = await call('POST', '/api/nas', {
          name,
          attrs: {
            description: flag('description', 'CLI 注册'),
            gatewayUrl, accessToken, nasIp,
            rootPath: flag('root-path', '/'),
            ...(flag('staging-dir') ? { stagingDir: flag('staging-dir') } : {}),
            dataClass: 'internal',
          },
        })
        ok(`NAS 资产已创建：${data.name}（${data.id}，${data.status}）`)
        return
      }
      if (action === 'import') {
        const config = argOf('--config')
        if (!config) fail('用法：nas import --config=<mcpServers JSON 或 @文件路径> [--name=]')
        const payload = String(config).startsWith('@')
          ? await import('node:fs/promises').then((fs) => fs.readFile(String(config).slice(1), 'utf8'))
          : String(config)
        const data = await call('POST', '/api/nas/import', { config: payload, name: flag('name'), description: flag('description') })
        out(data.results, ['name', 'ok', 'nasId', 'reachable', 'tools', 'status', 'error'], `导入结果（成功 ${data.imported}）`)
        return
      }
      if (action === 'health') { out(await call('POST', `/api/nas/${id}/health`)); return }
      if (action === 'online') { const data = await call('POST', `/api/nas/${id}/transition`, { action: 'online' }); ok(`已上线：${data.name}（${data.status}）`); return }
      if (action === 'offline') {
        const reason = flag('reason')
        if (!reason) fail('offline 必须提供 --reason（护栏要求）')
        const data = await call('POST', `/api/nas/${id}/transition`, { action: 'offline', note: String(reason) })
        ok(`已下线：${data.name}（${data.status}）`)
        return
      }
      if (action === 'shares') { out(await call('GET', `/api/nas/${id}/fs`)); return }
      if (action === 'files') {
        const path = flag('path', '')
        const data = await call('GET', `/api/nas/${id}/fs` + (path ? `?path=${encodeURIComponent(String(path))}` : ''))
        out(data)
        return
      }
      if (action === 'mkdir') {
        const path = argOf('--path')
        if (!path) fail('mkdir 需要 --path=<NAS路径>')
        out(await call('POST', `/api/nas/${id}/fs/mkdir`, { path }))
        return
      }
      if (action === 'delete') {
        const path = argOf('--path')
        if (!path) fail('delete 需要 --path=<NAS路径>')
        if (!ASSUME_YES && OUTPUT === 'table') {
          console.log(`将删除 NAS ${id} 上的路径：${path}`)
          if (!await confirm()) { console.log('已取消（使用 --yes 跳过确认）'); return }
        }
        out(await call('POST', `/api/nas/${id}/fs/delete`, { paths: [path] }))
        return
      }
      if (action === 'upload') {
        const file = argOf('--file')
        const dest = argOf('--dest')
        if (!file || !dest) fail('用法：nas upload <id> --file=<本地路径> --dest=<NAS路径>')
        const buffer = await import('node:fs/promises').then((fs) => fs.readFile(file))
        out(await call('POST', `/api/nas/${id}/fs/upload`, { contentBase64: buffer.toString('base64'), destPath: dest }))
        ok(`已上传 → ${dest}`)
        return
      }
      if (action === 'search') {
        const pattern = argOf('--pattern')
        if (!pattern) fail('search 需要 --pattern=<关键字>')
        out(await call('POST', `/api/nas/${id}/fs/search`, { pattern, path: flag('path', '/') }))
        return
      }
      fail(`未知动作：nas ${action}`)
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
        const fs = await import('node:fs/promises')
        const content = await fs.readFile(file, 'utf8')
        const packageFile = argOf('--package')
        const packageBase64 = packageFile ? (await fs.readFile(packageFile)).toString('base64') : undefined
        const data = await call('POST', '/api/skills', {
          name: argOf('--name'), content, category: flag('category', '通用'), summary: flag('summary', ''),
          version: flag('version', '1.0.0'),
          ...(packageBase64 !== undefined ? { packageBase64 } : {}),
        })
        ok(`已提交：${data.status === 'rejected' ? '静态扫描未通过（自动驳回）' : '进入审批流水线'}${data.hasPackage ? '（含 skill.zip 包）' : ''}`)
        out({ id: data.id, status: data.status, findings: (data.findings ?? []).map((f) => f.message).join('；') })
        return
      }
      if (action === 'storage') {
        const sub = argv[1] ?? 'get'
        if (sub === 'get') {
          const data = await call('GET', '/api/skill-storage')
          out(data.config)
          table(data.nasOptions, ['id', 'name', 'rootPath'], '可用 NAS（online）')
          return
        }
        if (sub === 'set') {
          const mode = String(flag('mode', ''))
          if (mode !== 'local' && mode !== 'nas') fail('storage set 需要 --mode=local|nas')
          const body = { mode }
          if (mode === 'nas') {
            body.nasId = argOf('--nas-id')
            if (!body.nasId) fail('--mode=nas 需要 --nas-id=<NAS资产ID>')
            body.basePath = flag('base-path', '/skills')
          }
          const data = await call('PUT', '/api/skill-storage', body)
          ok(`Skill 包存储已切换：${data.mode}${data.nasId ? ` → ${data.nasId}:${data.basePath}` : ''}`)
          return
        }
        fail('用法：skill storage get | set --mode=local|nas [--nas-id= --base-path=]')
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
  connector: {
    desc: 'SaaS 连接器纳管（open-connector 数据面网关适配）',
    run: async () => {
      const group = argv[0] ?? 'gateway'
      const sub = argv[1]
      await ensureToken()
      const jsonBodyFromFile = async (raw) => {
        if (!raw) return {}
        return JSON.parse(String(raw).startsWith('@')
          ? await import('node:fs/promises').then((fs) => fs.readFile(String(raw).slice(1), 'utf8'))
          : String(raw))
      }
      // ---- 网关 ----
      if (group === 'gateway') {
        if (sub === 'set') {
          const baseUrl = argOf('--base-url')
          if (!baseUrl) fail('用法：connector gateway set --base-url= [--admin-token-env=VAR]')
          const adminTokenEnv = argOf('--admin-token-env')
          await call('PUT', '/api/connector/gateway', {
            baseUrl,
            ...(adminTokenEnv ? { adminToken: `env:${adminTokenEnv}` } : {}),
          })
          ok(`网关已保存：${baseUrl}（探活已触发，可用 connector gateway health 复核）`)
          return
        }
        if (sub === 'health') {
          const data = await call('POST', '/api/connector/gateway/health')
          out([data], ['ok', 'latencyMs', 'reason'])
          return
        }
        out(await call('GET', '/api/connector/gateway'))
        return
      }
      // ---- 目录 ----
      if (group === 'catalog') {
        if (sub === 'providers') {
          const data = await call('GET', '/api/connector/catalog' + (flag('search') ? `?q=${encodeURIComponent(flag('search'))}&kind=providers` : '?kind=providers'))
          out(data.providers.map((p) => ({ service: p.service, name: p.name, description: p.description })), ['service', 'name', 'description'])
          return
        }
        if (sub === 'actions') {
          const params = new URLSearchParams({ kind: 'actions' })
          if (flag('service')) params.set('service', flag('service'))
          if (flag('search')) params.set('q', flag('search'))
          const data = await call('GET', `/api/connector/catalog?${params}`)
          out(data.actions.map((a) => ({ id: a.id, service: a.service, riskLevel: a.riskLevel, description: a.description })), ['id', 'service', 'riskLevel', 'description'])
          return
        }
        if (sub === 'action') {
          const actionId = argv[2]
          if (!actionId) fail('用法：connector catalog action <actionId> [--guide]')
          if (flag('guide')) {
            const raw = await fetch(`${BASE}/api/connector/catalog/actions/${encodeURIComponent(actionId)}/guide`, { headers: { authorization: `Bearer ${token}` } })
            console.log(await raw.text())
            return
          }
          out(await call('GET', `/api/connector/catalog/actions/${encodeURIComponent(actionId)}`))
          return
        }
      }
      // ---- 连接 ----
      if (group === 'connections') {
        if (sub === 'list') {
          const search = new URLSearchParams()
          if (flag('org')) search.set('orgId', flag('org'))
          const data = await call('GET', '/api/connector/connections' + (search.size ? `?${search}` : ''))
          out(data.connections.map((c) => ({
            id: c.id, provider: c.provider, alias: c.alias, authType: c.authType,
            status: c.status, org: c.ownerOrgId,
            maskedProfile: c.maskedProfile ? Object.entries(c.maskedProfile).map(([k, v]) => `${k}=${v}`).join(' ') : '',
          })), ['id', 'provider', 'alias', 'authType', 'status', 'org', 'maskedProfile'])
          return
        }
        if (sub === 'create') {
          const provider = argOf('--provider')
          const authType = argOf('--auth-type')
          const org = argOf('--org')
          const aliasSuffix = argOf('--alias-suffix', 'main')
          if (!provider || !authType || !org) fail('用法：connector connections create --provider= --auth-type=no_auth|api_key|oauth --org=<orgId> [--alias-suffix=main] [--values=@file.json]')
          const endpoint = authType === 'oauth' ? '/api/connector/connections/oauth'
            : authType === 'no_auth' ? '/api/connector/connections/no-auth'
              : '/api/connector/connections/api-key'
          const payload = { provider, aliasSuffix, orgId: org }
          if (authType !== 'no_auth' && authType !== 'oauth') payload.values = await jsonBodyFromFile(argOf('--values'))
          if (authType === 'oauth' && flag('scopes')) payload.requestedScopes = String(flag('scopes')).split(',')
          const data = await call('POST', endpoint, payload)
          if (data.approvalRequired) { ok(`已进入审批门禁：审批单 ${data.approvalId}；批准后重发并带相同参数即可完成创建（服务端校验 approvalId）`); return }
          if (data.authorizationUrl) {
            console.log(`\n✔ 授权页：${data.authorizationUrl}\n  state=${data.state}\n  完成授权后执行 dshctl connector connections list 观察状态`)
            return
          }
          out(data.reference, ['id', 'alias', 'provider', 'authType', 'status', 'ocConnectionId'])
          return
        }
        if (sub === 'delete') {
          const id = argv[2]
          if (!id) fail('用法：connector connections delete <id> --yes （仍被权限组引用时可加 --force 解除引用并镜像令牌）')
          if (!ASSUME_YES && !DRY_RUN) fail('删除连接需要确认：请携带 --yes')
          const data = await call('DELETE', `/api/connector/connections/${id}`, flag('force') ? { force: true } : {})
          console.log(`\n✔ 连接已删除${Array.isArray(data.releasedGroups) && data.releasedGroups.length > 0 ? `（解除引用组：${data.releasedGroups.join(',')}）` : ''}`)
          return
        }
      }
      // ---- 执行 ----
      if (group === 'execute') {
        const actionId = argOf('--action')
        if (!actionId) fail('用法：connector execute --action=<actionId> [--connection=<alias>] [--input=@file.json] [--dry-run]')
        const input = await jsonBodyFromFile(argOf('--input'))
        const body = { actionId, input }
        if (argOf('--connection')) body.connection = argOf('--connection')
        if (DRY_RUN) body.dryRun = true
        const data = await call('POST', '/api/connector/execute', body)
        if (data.status === 'approval_required') {
          console.log(`\n⏸ admin 级 action 已生成审批单 ${data.approvalId}\n  批准：dshctl approval decide ${data.approvalId} --decision=approve\n  批准后 executor 自动完成调用与计量`)
          return
        }
        out(data)
        return
      }
      // ---- 权限组 ----
      if (group === 'perm-groups') {
        if (sub === 'create') {
          const file = argOf('--file')
          if (!file) fail('用法：connector perm-groups create --file=@group.json（含 name/orgId/policies/subjects/rateLimitPerMin/precheckCents）')
          const payload = await jsonBodyFromFile(file)
          const data = await call('POST', '/api/connector/perm-groups', payload)
          ok(`权限组已创建：${data.id}（独立 oct_ 令牌按四数组全发语义镜像 policies）`)
          return
        }
        if (sub === 'impact') {
          const id = argv[2]
          if (!id) fail('用法：connector perm-groups impact <id>   变更影响面预览（N 令牌 / M 连接 / 主体数）')
          out(await call('POST', `/api/connector/perm-groups/${id}/impact`))
          return
        }
        if (sub === 'delete') {
          const id = argv[2]
          if (!id) fail('用法：connector perm-groups delete <id> --yes   联动 DELETE 对应运行时令牌')
          if (!ASSUME_YES) fail('删除权限组会吊销其运行时令牌：请携带 --yes')
          await call('DELETE', `/api/connector/perm-groups/${id}`)
          ok('已删除并联动吊销运行时令牌')
          return
        }
        if (sub === 'get') {
          out(await call('GET', '/api/connector/perm-groups'))
          return
        }
        const data = await call('GET', '/api/connector/perm-groups')
        out(data.groups.map((g) => ({ id: g.id, name: g.name, org: g.orgId, policies: Object.keys(g.policies).join('|'), subjects: g.subjects.length })), ['id', 'name', 'org', 'policies', 'subjects'])
        return
      }
      // ---- 运行日志 / 对账 / 台账 ----
      if (group === 'runs') {
        const search = new URLSearchParams()
        if (flag('service')) search.set('service', flag('service'))
        if (flag('ok')) search.set('ok', String(flag('ok')))
        search.set('limit', String(argOf('--limit', 50)))
        const data = await call('GET', `/api/connector/runs?${search}`)
        out(data.items.map((r) => ({ id: r.id, service: r.service, actionId: r.actionId, ok: r.ok, runtimeTokenId: r.runtimeTokenId, startedAt: r.startedAt })), ['id', 'service', 'actionId', 'ok', 'runtimeTokenId', 'startedAt'])
        return
      }
      if (group === 'reconcile') {
        const data = await call('POST', '/api/connector/reconcile')
        out([{
          checkedRuns: data.checkedRuns,
          matchedMeters: data.matchedMeters,
          bypass: (data.bypassRuns ?? []).join(',') || '-',
          cursor: data.cursor ?? '-',
        }], ['checkedRuns', 'matchedMeters', 'bypass', 'cursor'])
        return
      }
      if (group === 'tokens') {
        const data = await call('GET', '/api/connector/tokens')
        out(data.tokens.map((t) => ({ permGroupId: t.permGroupId, ocTokenId: t.ocTokenId, hash: t.policySnapshotHash, lastSyncedAt: t.lastSyncedAt })), ['permGroupId', 'ocTokenId', 'hash', 'lastSyncedAt'])
        return
      }
      fail(`未知 connector 子命令：${group}（见 dshctl help）`)
    },
  },

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
      if (action === 'report') {
        if (!id) fail('用法：app report <id> [--pv=] [--uv=] [--dau=] [--sessions=] [--avg-depth=] [--retention7=] [--date=YYYY-MM-DD]')
        const input = {}
        for (const [flagName, key] of [['pv', 'pv'], ['uv', 'uv'], ['dau', 'dau'], ['sessions', 'sessions'], ['avg-depth', 'avgDepth'], ['retention7', 'retention7']]) {
          const value = flag(flagName)
          if (value !== undefined && value !== true) input[key] = Number(value)
        }
        const date = flag('date')
        if (date && date !== true) input.date = String(date)
        if (Object.keys(input).length === 0) fail('至少上报一项指标：--pv= / --uv= / --dau= / --sessions= / --avg-depth= / --retention7=（可选 --date= 补录历史）')
        const data = await call('POST', `/api/apps/${id}/metrics-report`, input)
        ok('应用指标已上报（宿主侧已记录）')
        out(data)
        return
      }
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
      if (action === 'read-all') {
        const result = await call('POST', '/api/audit/alerts/read-all')
        out([{ read: result.read }], ['read'])
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
  usage: {
    desc: '计量事件（推送式上报 / 查询）',
    run: async () => {
      const action = argv[0] ?? 'events'
      await ensureToken()
      if (action === 'record') {
        const metersRaw = argOf('--meter')
        const input = {
          org: argOf('--org'), subject: argOf('--subject'), principal: argOf('--principal'), resource: argOf('--resource'),
        }
        if (!input.org || !input.subject || !input.principal || !input.resource || !metersRaw) {
          fail('用法：usage record --org=<orgId> --subject=user:<id>|agent:<id> --principal=org:<id>|plugin:<id>|platform --resource=model:<slug>|mcp:<slug>|plugin:<id> --meter=key:value:unit[,...] [--idempotency-key=] [--tenant-id=]')
        }
        const meters = String(metersRaw).split(',').map((item) => {
          const [key, value, unit] = item.split(':')
          if (!key || value === undefined || Number.isNaN(Number(value)) || !unit) fail(`--meter 项格式非法：${item}（应为 key:value:unit）`)
          return { key, value: Number(value), unit }
        })
        const body = { ...input, meters }
        if (argOf('--idempotency-key')) body.idempotency_key = argOf('--idempotency-key')
        if (argOf('--tenant-id')) body.tenant_id = argOf('--tenant-id')
        const data = await call('POST', '/api/usage/record', body)
        ok(`计量事件已登记：${data.event_id}（charge=${data.pricing.charge_cents}分）`)
        return
      }
      if (action === 'events') {
        const search = new URLSearchParams()
        if (flag('principal')) search.set('principal', flag('principal'))
        if (flag('resource')) search.set('resource', flag('resource'))
        if (flag('limit')) search.set('limit', String(flag('limit')))
        const data = await call('GET', '/api/usage/events' + (search.size ? `?${search}` : ''))
        out(data.items.map((e) => ({ event_id: e.event_id, resource: e.resource, subject: e.subject, meters: e.meters.map((m) => `${m.key}=${m.value}${m.unit}`).join(','), charge: e.pricing.charge_cents, time: e.occurred_at?.slice(0, 19).replace('T', ' ') })), ['event_id', 'resource', 'subject', 'meters', 'charge', 'time'], '计量事件')
        return
      }
      if (action === 'totals') {
        const search = new URLSearchParams()
        if (flag('principal')) search.set('principal', flag('principal'))
        if (flag('from')) search.set('from', flag('from'))
        out(await call('GET', '/api/usage/totals' + (search.size ? `?${search}` : '')))
        return
      }
      fail('用法：usage record --org= --subject= --principal= --resource= --meter=key:value:unit[,...] | events [--principal= --resource= --limit=] | totals [--principal= --from=]')
    },
  },
  connect: {
    desc: '远程 dsh 接入管理（接入码 / 已接入客户端）',
    run: async () => {
      const action = argv[0] ?? 'codes'
      await ensureToken()
      if (action === 'code') {
        const template = flag('template', 'readonly')
        const ttl = Number(flag('ttl', 15)) || 15
        const data = await call('POST', '/api/connect/codes', { template, ttlMinutes: ttl, remark: String(flag('remark', '')) })
        console.log(`\n  接入码（仅本次展示，${data.ttlMinutes} 分钟内一次性有效）：`)
        console.log(`  ┌─────────────────────────────────────────────────────┐`)
        console.log(`  │ ${data.code} │`)
        console.log(`  └─────────────────────────────────────────────────────┘`)
        console.log(`  模板：${template}（${data.template}）  过期：${data.expiresAt}`)
        console.log(`  远程电脑 dsh 安装插件后执行：connect_setup { hubUrl, enrollmentCode } 即完成接入；`)
        console.log(`  或让其在浏览器打开 http://127.0.0.1:7390 配置页填写。\n`)
        return
      }
      if (action === 'codes') {
        const data = await call('GET', '/api/connect/codes')
        out(data.codes.map((c) => ({ codeMask: c.codeMask, template: c.template, status: c.status, expiresAt: c.expiresAt, usedBy: c.usedBy ?? '', remark: c.remark })), ['codeMask', 'template', 'status', 'expiresAt', 'usedBy', 'remark'], '接入码')
        return
      }
      if (action === 'clients') {
        const data = await call('GET', '/api/connect/clients')
        out(data.clients.map((c) => ({ name: c.name, clientId: c.clientId, template: c.template, status: c.status, hostname: c.hostname, enrolledAt: c.enrolledAt, lastUsedAt: c.lastUsedAt || '' })), ['name', 'clientId', 'template', 'status', 'hostname', 'lastUsedAt'], '已接入客户端')
        return
      }
      if (action === 'disable') {
        const target = argv[1]
        const reason = flag('reason')
        if (!target || !reason) fail('用法：connect disable <clientId|记录ID> --reason=<原因>')
        const data = await call('POST', `/api/connect/clients/${target}/disable`, { reason })
        ok(`客户端已禁用（联动吊销全部令牌）：${data.id}`)
        return
      }
      fail('用法：connect code [--template=readonly|operator|full] [--ttl=15] [--remark=] | codes | clients | disable <clientId> --reason=')
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
  update: {
    desc: '平台自更新（上游版本检查 / 一键升级）',
    run: async () => {
      const action = argv[0] ?? 'status'
      await ensureToken()
      if (action === 'status') {
        const data = await call('GET', '/api/update/status')
        if (OUTPUT === 'json') { console.log(JSON.stringify(data, null, 2)); return }
        out({
          当前版本: `v${data.currentVersion}`,
          安装形态: data.installMode === 'source' ? '源码检出（git，可一键升级）' : '插件市场安装（bundle，宿主侧升级）',
          上游仓库: `${data.repo}@${data.branch}`,
          上游最新: data.latest ? `v${data.latest.version}（检查于 ${data.latest.checkedAt}）` : '未检查',
          有可用更新: data.hasUpdate ? `是（${data.updateKind === 'version' ? '新版本' : `上游领先 ${data.behindBy} 个提交`}）` : '否',
          自动检查: data.autoCheck ? `每 ${data.intervalHours} 小时` : '关闭',
          最近检查: data.lastCheckedAt || '从未',
          ...(data.lastError ? { 上次异常: data.lastError } : {}),
        })
        if (data.hasUpdate && (data.recentCommits ?? []).length > 0 && OUTPUT !== 'json') {
          console.log('\n  上游新增提交：')
          for (const commit of data.recentCommits.slice(0, 10)) console.log(`   ${commit.sha}  ${commit.message}`)
        }
        return
      }
      if (action === 'check') {
        const data = await call('POST', '/api/update/check')
        ok(data.hasUpdate ? `发现新版本：v${data.currentVersion} → v${data.latest?.version ?? '?'}${data.behindBy > 0 ? `（上游领先 ${data.behindBy} 个提交）` : ''}` : `已是最新版本（v${data.currentVersion}）`)
        return
      }
      if (action === 'apply') {
        const dryRun = DRY_RUN === true || flag('dry-run', false) === true
        const reason = String(flag('reason', ''))
        if (dryRun) {
          const plan = await call('POST', '/api/update/apply', { dryRun: true })
          console.log('\n  升级预演（不执行任何变更）：')
          for (const step of plan.steps ?? []) console.log(`   · ${step}`)
          for (const commit of plan.incomingCommits ?? []) console.log(`   ↑ ${commit}`)
          return
        }
        if (!reason) fail('正式升级必须 --reason=<原因>（留痕要求）；先看影响面可加 --dry-run')
        const proceed = ASSUME_YES || await confirm()
        if (!proceed) { console.log('已取消'); return }
        const data = await call('POST', '/api/update/apply', { reason })
        if (data.supported === false) {
          console.log(`\n  ${data.instructions}\n`)
          return
        }
        ok(data.notice ?? '升级完成')
        if (data.gitOutput) console.log(`\n  git 输出摘要：\n${String(data.gitOutput).split('\n').slice(0, 8).map((line) => `   ${line}`).join('\n')}`)
        return
      }
      if (action === 'set') {
        const input = {}
        const auto = flag('auto', undefined)
        if (auto !== undefined) input.autoCheck = auto === 'on' || auto === true
        const hours = flag('hours', undefined)
        if (hours !== undefined) input.intervalHours = Number(hours) || 0
        if (!Object.keys(input).length) fail('用法：update set [--auto=on|off] [--hours=24]')
        const data = await call('POST', '/api/update/settings', input)
        ok(`自动检查：${data.autoCheck ? `每 ${data.intervalHours} 小时` : '关闭'}`)
        return
      }
      fail('用法：update status | check | apply [--dry-run] [--reason=<原因>] | set [--auto=on|off] [--hours=24]')
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
