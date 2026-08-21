/**
 * @dsh-ops/plugin-market —— 第三方插件市场 + 开发者身份域（生态设计 v1.2 第 3/5/7 步）。
 *
 * 契约五面（L0 声明式，无任何可执行代码）：
 *   plugin.yaml                 元数据 + capabilities_request + sandbox + L0 内容（提示词包）
 *   manifest/permissions.yaml   权限声明（requested；安装时企业逐项审批 → approved）
 *   manifest/api.yaml           声明式提供面（L0 阶段仅登记描述）
 *   manifest/events.yaml        事件声明（订阅/发射均收敛在 plugin:<id>: 命名空间）
 *   manifest/billing.yaml       L3 计费声明（安装时登记价格簿）
 *
 * 市场准入门禁（硬性）：sandbox 仅受理 L0——L1 有码沙箱（第 10 步）交付前，
 * 任何有码插件提交直接拒绝，杜绝「内部信任」例外。
 *
 * 开发者身份域（M2）：独立于内部员工 iam 域；Ed25519 发布者密钥对验签提交。
 * 签名对象 = 五面文件内容指纹（按文件名排序拼接的 SHA-256）。
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { PlatformEvents, newId, parseYaml, sha256Hex, type Collection, type RecordBase } from '@dsh-ops/platform-core'
import * as marketTools from './tools.ts'

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

export interface DeveloperRecord extends RecordBase {
  username: string
  displayName: string
  email: string
  status: 'active' | 'suspended'
  passwordSalt: string
  passwordHash: string
  /** 发布者 Ed25519 公钥（SPKI DER → base64）。 */
  publicKey: string
  company?: string
  /** 收款账户登记（资金通道依赖清单就位前的登记位，v1.2 §六）。 */
  payoutAccount?: string
  principalId: string
}

/** 契约五面解析结果。 */
export interface PluginManifest {
  id: string
  version: string
  publisher: string
  depends: string[]
  capabilities_request: string[]
  sandbox: string
  permissions: { requested: string[] }
  api: { routes: Array<{ path: string; method: string; description: string }> }
  events: { subscribes: string[]; emits: string[] }
  billing: {
    model: string
    subscription?: { monthly: number }
    usage: Array<{ key: string; unit: string; price: number }>
    commission: string
  }
  content: {
    prompts: Array<{ name: string; description: string; template: string }>
  }
}

export type PluginStatus = 'scanning' | 'rejected' | 'pending_approval' | 'listed' | 'suspended' | 'deprecated'

export interface PluginSubmissionRecord extends RecordBase {
  pluginId: string
  version: string
  developerId: string
  developerName: string
  status: PluginStatus
  /** 五面原文（文件路径 → 内容）。 */
  files: Record<string, string>
  parsed: PluginManifest
  fingerprint: string
  signature: string
  /** L0 内容指纹：提示词/配置变更 = 行为变更，强制重走审批（M5）。 */
  contentHash: string
  reviewNote?: string
  reviewedBy?: string
  installs: number
}

export interface PluginInstallRecord extends RecordBase {
  pluginId: string
  version: string
  orgId: string
  tenantId: string
  /** 安装时企业审批通过的能力子集（approved ⊆ requested）。 */
  capabilities: string[]
  permissions: string[]
  status: 'running' | 'suspended' | 'uninstalled'
  installedBy: string
}

/** L3 订阅代收登记（资金通道未就位：先记账期权益，结算走人工对账单，v1.2 §六过渡形态）。 */
export interface PluginSubscriptionRecord extends RecordBase {
  pluginId: string
  orgId: string
  tenantId: string
  monthlyCents: number
  startedAt: string
  channel: 'manual-settlement'
}

// ---------------------------------------------------------------------------
// 契约校验
// ---------------------------------------------------------------------------

export const REQUIRED_FILES = ['plugin.yaml', 'manifest/permissions.yaml', 'manifest/api.yaml', 'manifest/events.yaml', 'manifest/billing.yaml']

/** L0 内容静态扫描规则（复用 skillhub 治理模式；声明式内容变更=行为变更）。 */
const CONTENT_BLOCK_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+-rf\s+\//i, reason: '疑似破坏性命令' },
  { pattern: /sk-[A-Za-z0-9]{16,}/, reason: '疑似明文密钥' },
  { pattern: /eval\s*\(|new\s+Function\s*\(/, reason: '疑似动态代码执行（L0 禁止可执行内容）' },
  { pattern: /require\s*\(|import\s*\(/, reason: '疑似模块加载（L0 禁止可执行内容）' },
]

export function fingerprintOf(files: Record<string, string>): string {
  const canonical = Object.keys(files).sort()
    .map((key) => `${key}\n${files[key] ?? ''}`)
    .join('\n---\n')
  return sha256Hex(canonical)
}

export function contentHashOf(manifest: PluginManifest): string {
  return sha256Hex(JSON.stringify(manifest.content))
}

/** 解析并校验契约五面（结构性校验 + 准入门禁）。 */
export function parseManifest(files: Record<string, string>): PluginManifest {
  for (const file of REQUIRED_FILES) {
    if (typeof files[file] !== 'string' || files[file]!.trim() === '') {
      throw new Error(`契约五面缺少文件：${file}`)
    }
  }
  let root: Record<string, unknown>
  let permissions: Record<string, unknown>
  let api: Record<string, unknown>
  let events: Record<string, unknown>
  let billing: Record<string, unknown>
  try {
    root = parseYaml(files['plugin.yaml']!) as Record<string, unknown>
    permissions = parseYaml(files['manifest/permissions.yaml']!) as Record<string, unknown>
    api = parseYaml(files['manifest/api.yaml']!) as Record<string, unknown>
    events = parseYaml(files['manifest/events.yaml']!) as Record<string, unknown>
    billing = parseYaml(files['manifest/billing.yaml']!) as Record<string, unknown>
  } catch (error) {
    throw new Error(`YAML 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof root.id !== 'string' || !/^[a-z0-9]+(\.[a-z0-9-]+){1,3}$/.test(root.id)) {
    throw new Error(`plugin.yaml id 格式非法（应为反向域名如 com.vendor.name）：${String(root.id)}`)
  }
  if (typeof root.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(root.version)) throw new Error('plugin.yaml version 必须为语义化版本 x.y.z')
  if (root.sandbox !== 'L0') {
    throw new Error(`市场准入门禁：当前仅受理 sandbox: L0（声明式插件），收到 ${String(root.sandbox)}。L1 有码沙箱为第 10 步交付项，交付前不开放有码插件上架。`)
  }
  const content = (root.content ?? {}) as PluginManifest['content']
  if (!Array.isArray(content.prompts) || content.prompts.length === 0) {
    throw new Error('L0 插件必须在 plugin.yaml content.prompts 声明至少一个提示词包（声明式内容的唯一载体）')
  }
  for (const prompt of content.prompts) {
    if (typeof prompt.name !== 'string' || typeof prompt.template !== 'string' || prompt.template.trim() === '') {
      throw new Error(`提示词包 ${String(prompt.name)} 缺少 name/template`)
    }
    for (const rule of CONTENT_BLOCK_RULES) {
      if (rule.pattern.test(prompt.template)) throw new Error(`L0 内容扫描拦截（${rule.reason}）：提示词包 ${prompt.name}`)
    }
  }
  const manifest: PluginManifest = {
    id: root.id,
    version: root.version,
    publisher: typeof root.publisher === 'string' ? root.publisher : '',
    depends: Array.isArray(root.depends) ? root.depends.map(String) : [],
    capabilities_request: Array.isArray(root.capabilities_request) ? root.capabilities_request.map(String) : [],
    sandbox: String(root.sandbox),
    permissions: { requested: permissions.requested !== undefined ? (Array.isArray(permissions.requested) ? permissions.requested.map(String) : []) : [] },
    api: {
      routes: Array.isArray(api.routes)
        ? api.routes.map((route) => route as { path: string; method: string; description: string })
        : [],
    },
    events: {
      subscribes: Array.isArray(events.subscribes) ? events.subscribes.map(String) : [],
      emits: Array.isArray(events.emits) ? events.emits.map(String) : [],
    },
    billing: {
      model: typeof billing.model === 'string' ? billing.model : 'free',
      ...(billing.subscription !== undefined && billing.subscription !== null ? { subscription: billing.subscription as { monthly: number } } : {}),
      usage: Array.isArray(billing.usage) ? billing.usage as PluginManifest['billing']['usage'] : [],
      commission: typeof billing.commission === 'string' ? billing.commission : 'platform_default',
    },
    content,
  }
  for (const emit of manifest.events.emits) {
    if (!emit.startsWith(`plugin:${manifest.id}:`)) {
      throw new Error(`events.yaml 发射事件必须收敛在 plugin:${manifest.id}: 命名空间：${emit}`)
    }
  }
  return manifest
}

/** Ed25519 验签：指纹必须由开发者登记公钥签出。 */
export function verifySignature(publicKeyBase64: string, fingerprint: string, signatureBase64: string): boolean {
  try {
    const publicKey = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' })
    return edVerify(null, Buffer.from(fingerprint), publicKey, Buffer.from(signatureBase64, 'base64'))
  } catch {
    return false
  }
}

/** 开发者密钥对生成（脚手架/门户自助用；私钥只在调用方持有）。 */
export function generateDeveloperKeyPair(): { publicKeyBase64: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  }
}

/** 脚手架签名（dshctl plugin init 生成的 demo 私钥 → 对指纹签名）。 */
export function signFingerprint(privateKeyPem: string, fingerprint: string): string {
  const privateKey = createPrivateKey(privateKeyPem)
  return edSign(null, Buffer.from(fingerprint), privateKey).toString('base64')
}

/** 能力 → 可消耗资源前缀（运行时对账 M5 的授权基线）。 */
const CAPABILITY_RESOURCE_MAP: Record<string, string> = {
  'model-gateway.invoke': 'model:*',
  'knowledgebase.read': 'kb:*',
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class MarketService extends Service {
  static readonly provide = 'market'

  constructor(ctx: Context) {
    super(ctx, 'market')
    // 自营种子须在服务构造器内做（插件 apply 里 ctx.market 未注入，cordis 红线）
    seedOfficialPlugins(this)
  }

  developers(): Collection<DeveloperRecord> {
    const collection = this.ctx.storage.collection<DeveloperRecord>('market:developers')
    collection.uniqueOn('developer_username', (dev) => dev.username)
    return collection
  }

  submissions(): Collection<PluginSubmissionRecord> {
    const collection = this.ctx.storage.collection<PluginSubmissionRecord>('market:submissions')
    collection.uniqueOn('submission_plugin_version', (item) => `${item.pluginId}@${item.version}`)
    return collection
  }

  installs(): Collection<PluginInstallRecord> {
    return this.ctx.storage.collection<PluginInstallRecord>('market:installs')
  }

  subscriptions(): Collection<PluginSubscriptionRecord> {
    return this.ctx.storage.collection<PluginSubscriptionRecord>('market:subscriptions')
  }

  // -- 开发者身份域（M2：独立于内部员工 iam） --------------------------------

  registerDeveloper(input: { username: string; displayName: string; email: string; password: string; publicKey: string; company?: string; payoutAccount?: string }): { developer: DeveloperRecord; token: string } {
    if (!/^[a-z][a-z0-9_-]{2,31}$/.test(input.username)) throw new Error('开发者账号格式非法（^[a-z][a-z0-9_-]{2,31}$）')
    if (input.password.length < 8) throw new Error('密码至少 8 位')
    try {
      createPublicKey({ key: Buffer.from(input.publicKey, 'base64'), format: 'der', type: 'spki' })
    } catch {
      throw new Error('发布者公钥格式非法（应为 Ed25519 SPKI DER base64）')
    }
    const credential = this.ctx.authn.createMachineCredential({
      name: `developer:${input.username}`,
      refType: 'external',
      scopes: ['market.developer'],
    })
    const salt = randomBytes(16).toString('hex')
    const record = this.developers().insert({
      id: newId('dev'),
      username: input.username,
      displayName: input.displayName,
      email: input.email,
      status: 'active',
      passwordSalt: salt,
      passwordHash: sha256Hex(`${salt}:${input.password}`),
      publicKey: input.publicKey,
      ...(input.company !== undefined ? { company: input.company } : {}),
      ...(input.payoutAccount !== undefined ? { payoutAccount: input.payoutAccount } : {}),
      principalId: credential.principal.id,
    })
    this.ctx.authn.principals().update(credential.principal.id, { refId: record.id })
    // 开发者主体默认授予平台能力白名单（计量授权，运行时对账基线）
    this.ctx.usage.grantCapabilities(`developer:${record.id}`, ['plugin:*'], 'developer-register')
    return { developer: record, token: this.developerToken(record) }
  }

  loginDeveloper(username: string, password: string): { developer: DeveloperRecord; token: string } {
    const developer = this.developers().findOne((item) => item.username === username)
    if (!developer || developer.passwordHash !== sha256Hex(`${developer.passwordSalt}:${password}`)) {
      throw new Error('开发者账号或密码错误')
    }
    if (developer.status !== 'active') throw new Error('开发者账号已停用')
    return { developer, token: this.developerToken(developer) }
  }

  private developerToken(developer: DeveloperRecord): string {
    const { token } = this.ctx.authn.issueToken(developer.principalId, {
      kind: 'machine',
      ttlHours: 2,
      scopes: ['market.developer'],
      issuedBy: 'market-portal',
    })
    return token
  }

  /** 由令牌主体定位开发者（开发者路由鉴权）。 */
  developerOfPrincipal(principalId: string): DeveloperRecord | undefined {
    return this.developers().findOne((item) => item.principalId === principalId)
  }

  // -- 提交与审批 ------------------------------------------------------------

  submit(developer: DeveloperRecord, files: Record<string, string>, signature: string): PluginSubmissionRecord {
    const parsed = parseManifest(files)
    if (parsed.publisher !== developer.username) {
      throw new Error(`plugin.yaml publisher 必须为提交者账号（${developer.username}），收到 ${parsed.publisher}`)
    }
    const fingerprint = fingerprintOf(files)
    if (!verifySignature(developer.publicKey, fingerprint, signature)) {
      throw new Error('签名验签失败：五面指纹与发布者公钥签名不匹配')
    }
    const duplicate = this.submissions().findOne((item) => item.pluginId === parsed.id && item.version === parsed.version)
    if (duplicate) throw new Error(`版本不可变：${parsed.id}@${parsed.version} 已提交（${duplicate.status}）`)
    const record = this.submissions().insert({
      id: newId('sub'),
      pluginId: parsed.id,
      version: parsed.version,
      developerId: developer.id,
      developerName: developer.displayName,
      status: 'pending_approval',
      files,
      parsed,
      fingerprint,
      signature,
      contentHash: contentHashOf(parsed),
      installs: 0,
    })
    this.ctx.platformBus.emit(PlatformEvents.PluginSubmitted, {
      pluginId: parsed.id, version: parsed.version, developer: developer.username, type: 'plugin', id: record.id,
    })
    return record
  }

  approve(id: string, approver: string, opinion: string): PluginSubmissionRecord {
    const record = this.requireSubmission(id)
    if (record.status !== 'pending_approval') throw new Error(`当前状态 ${record.status} 不允许审批`)
    const updated = this.submissions().update(id, { status: 'listed', reviewNote: opinion, reviewedBy: approver })
    this.ctx.platformBus.emit(PlatformEvents.PluginListed, {
      pluginId: updated.pluginId, version: updated.version, approver, type: 'plugin', id: updated.id, name: updated.pluginId,
    })
    return updated
  }

  reject(id: string, approver: string, reason: string): PluginSubmissionRecord {
    const record = this.requireSubmission(id)
    if (record.status !== 'pending_approval') throw new Error(`当前状态 ${record.status} 不允许审批`)
    return this.submissions().update(id, { status: 'rejected', reviewNote: reason, reviewedBy: approver })
  }

  /** 上架后内容变更（同版本内容指纹变化）→ 强制重走审批：旧版本 suspend 待迁移。 */
  suspend(id: string, reason: string): PluginSubmissionRecord {
    const record = this.requireSubmission(id)
    const updated = this.submissions().update(id, { status: 'suspended', reviewNote: reason })
    for (const install of this.installs().find((item) => item.pluginId === record.pluginId && item.status === 'running')) {
      this.installs().update(install.id, { status: 'suspended' })
    }
    return updated
  }

  listed(): PluginSubmissionRecord[] {
    return this.submissions().find((item) => item.status === 'listed')
  }

  // -- 安装（权限确认 + 能力固化 + 价格簿登记） ------------------------------

  install(input: {
    pluginId: string
    orgId: string
    tenantId: string
    approvedCapabilities: string[]
    approvedPermissions?: string[]
    installedBy: string
  }): PluginInstallRecord {
    const submission = this.submissions().findOne((item) => item.pluginId === input.pluginId && item.status === 'listed')
    if (!submission) throw new Error(`插件未上架或已下架：${input.pluginId}`)
    const existing = this.installs().findOne((item) => item.pluginId === input.pluginId && item.orgId === input.orgId && item.status !== 'uninstalled')
    if (existing) throw new Error(`组织 ${input.orgId} 已安装 ${input.pluginId}（${existing.status}）`)
    for (const cap of input.approvedCapabilities) {
      if (!submission.parsed.capabilities_request.includes(cap)) {
        throw new Error(`能力 ${cap} 不在插件请求清单内（approved ⊆ requested）`)
      }
    }
    const record = this.installs().insert({
      id: newId('ins'),
      pluginId: input.pluginId,
      version: submission.version,
      orgId: input.orgId,
      tenantId: input.tenantId,
      capabilities: input.approvedCapabilities,
      permissions: input.approvedPermissions ?? [],
      status: 'running',
      installedBy: input.installedBy,
    })
    // 能力固化：运行时对账基线（M5）——插件主体只许消耗获批能力对应的资源
    const grantedResources = [`plugin:${input.pluginId}`, ...input.approvedCapabilities.map((cap) => CAPABILITY_RESOURCE_MAP[cap] ?? cap)]
    this.ctx.usage.grantCapabilities(`plugin:${input.pluginId}`, grantedResources, `market-install:${record.id}`)
    // L3 计费登记：安装即写入价格簿（meter key 取 billing.usage[0]）
    const usageEntry = submission.parsed.billing.usage[0]
    if (usageEntry) {
      this.ctx.usage.upsertPrice({
        pattern: `plugin:${input.pluginId}`,
        meter_key: usageEntry.key,
        list_cents_per_unit: Math.round(usageEntry.price * 100),
        cost_cents_per_unit: 0,
        units_per_step: 1,
        tax_rate: 0.06,
        currency: 'CNY',
        rate_version: `plugin:${input.pluginId}:v${submission.version}`,
      })
    }
    this.submissions().update(submission.id, { installs: submission.installs + 1 })
    // L3 订阅代收：billing.yaml 声明订阅 → 登记账期权益（资金通道未就位 → 人工对账单结算）
    if (submission.parsed.billing.subscription && submission.parsed.billing.subscription.monthly > 0) {
      this.subscriptions().insert({
        id: newId('subr'),
        pluginId: input.pluginId,
        orgId: input.orgId,
        tenantId: input.tenantId,
        monthlyCents: Math.round(submission.parsed.billing.subscription.monthly * 100),
        startedAt: new Date().toISOString(),
        channel: 'manual-settlement',
      })
    }
    this.ctx.platformBus.emit(PlatformEvents.PluginInstalledEvent, {
      pluginId: input.pluginId, version: submission.version, orgId: input.orgId, tenantId: input.tenantId,
      capabilities: input.approvedCapabilities, installedBy: input.installedBy,
    })
    return record
  }

  uninstall(pluginId: string, orgId: string, actor: string): PluginInstallRecord {
    const record = this.installs().findOne((item) => item.pluginId === pluginId && item.orgId === orgId && item.status === 'running')
    if (!record) throw new Error(`插件 ${pluginId} 未在该组织运行中`)
    const updated = this.installs().update(record.id, { status: 'uninstalled' })
    this.ctx.usage.grantCapabilities(`plugin:${pluginId}`, [], `market-uninstall:${actor}`)
    return updated
  }

  installedFor(orgId: string): PluginInstallRecord[] {
    return this.installs().find((item) => item.orgId === orgId && item.status === 'running')
  }

  /** L0 运行时：读取已安装插件的提示词包（Agent 消费面，纯声明式内容）。 */
  promptPacks(orgId: string): Array<{ pluginId: string; version: string; name: string; description: string; template: string }> {
    const packs: Array<{ pluginId: string; version: string; name: string; description: string; template: string }> = []
    for (const install of this.installedFor(orgId)) {
      const submission = this.submissions().findOne((item) => item.pluginId === install.pluginId && item.version === install.version)
      if (!submission) continue
      for (const prompt of submission.parsed.content.prompts) {
        packs.push({ pluginId: install.pluginId, version: install.version, name: prompt.name, description: prompt.description ?? '', template: prompt.template })
      }
    }
    return packs
  }

  /** L0 内容计量：Agent 每次取用提示词包 → usage 事件（L3 计费）。 */
  meterPromptUse(orgId: string, pluginId: string, promptName: string, subject: string): void {
    const install = this.installs().findOne((item) => item.pluginId === pluginId && item.orgId === orgId && item.status === 'running')
    if (!install) throw new Error(`插件 ${pluginId} 未在组织 ${orgId} 安装`)
    const submission = this.submissions().findOne((item) => item.pluginId === pluginId && item.version === install.version)
    if (!submission) throw new Error('插件版本记录缺失')
    if (!submission.parsed.content.prompts.some((prompt) => prompt.name === promptName)) {
      throw new Error(`提示词包不存在：${promptName}`)
    }
    this.ctx.usage.record({
      org: orgId,
      subject,
      principal: `plugin:${pluginId}`,
      resource: `plugin:${pluginId}`,
      tenant_id: install.tenantId,
      meters: [{ key: submission.parsed.billing.usage[0]?.key ?? 'prompts.used', value: 1, unit: submission.parsed.billing.usage[0]?.unit ?? '次' }],
      idempotency_key: `plugin-use:${newId('pu')}`,
    })
  }

  private requireSubmission(id: string): PluginSubmissionRecord {
    const record = this.submissions().get(id)
    if (!record) throw new Error(`提交记录不存在：${id}`)
    return record
  }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    market: MarketService
  }
}

export const name = 'market'
export const inject = ['storage', 'platformBus', 'authn', 'usage']

export function apply(ctx: Context) {
  ctx.plugin(MarketService)
  ctx.plugin(marketTools)
}

// ---------------------------------------------------------------------------
// 平台自营首批供给（M3 消解：L0 供给空窗 → 3 个可收费标杆场景）
// 走与第三方完全相同的提交/签名/审批流水线（吃自己的狗粮）。
// ---------------------------------------------------------------------------

const OFFICIAL_PLUGINS: Array<{ id: string; name: string; description: string; template: string; usageKey: string; unit: string; price: number; monthly?: number }> = [
  {
    id: 'com.platform.contract-review', name: '合同审查提示词包', description: '按企业合同红线清单输出结构化审查意见',
    template: '你是合同审查专家。对输入合同执行：1) 标的主体与签署权限核验；2) 付款/违约/知识产权条款风险标注（高/中/低）；3) 输出结构化审查意见表。',
    usageKey: 'contract.docs', unit: '份', price: 2.0, monthly: 999,
  },
  {
    id: 'com.platform.weekly-report', name: '周报生成器', description: '把零散工作记录收敛为管理层周报',
    template: '你是周报整理助手。将输入的工作记录归纳为：本周进展（按优先级）/ 数据亮点 / 风险与求助 / 下周计划，保持事实忠实不夸大。',
    usageKey: 'report.count', unit: '次', price: 1.0,
  },
  {
    id: 'com.platform.pii-mask', name: '数据脱敏模板', description: '对外输出前的 PII 脱敏规则包',
    template: '你是数据脱敏助手。按规则处理输入文本：手机号/身份证/银行卡保留前三后四；姓名保留姓；邮箱打码域名前部分；输出脱敏后文本与脱敏项清单。',
    usageKey: 'mask.count', unit: '次', price: 0.5,
  },
]

function seedOfficialPlugins(market: MarketService): void {
  try {
    const ctx = market.ctx
    if (market.submissions().count() > 0) return
    const keys = generateDeveloperKeyPair()
    let official = market.developers().findOne((item) => item.username === 'platform-official')
    if (!official) {
      official = market.registerDeveloper({
        username: 'platform-official',
        displayName: '平台官方（自营）',
        email: 'official@platform.internal',
        password: randomBytes(24).toString('base64url'),
        publicKey: keys.publicKeyBase64,
      }).developer
    }
    for (const spec of OFFICIAL_PLUGINS) {
      const files: Record<string, string> = {
        'plugin.yaml': [
          `id: ${spec.id}`,
          'version: 1.0.0',
          'publisher: platform-official',
          'depends:',
          '  - dsh-plugin-platform-core: ^1.0',
          'capabilities_request:',
          '  - knowledgebase.read',
          'sandbox: L0',
          'content:',
          '  prompts:',
          `    - name: main`,
          `      description: ${spec.description}`,
          '      template: |',
          `        ${spec.template}`,
          '',
        ].join('\n'),
        'manifest/permissions.yaml': 'requested:\n  - knowledgebase.read\n',
        'manifest/api.yaml': 'routes: []\n',
        'manifest/events.yaml': 'subscribes: []\nemits: []\n',
        'manifest/billing.yaml': [
          `model: ${spec.monthly !== undefined ? 'hybrid' : 'usage'}`,
          ...(spec.monthly !== undefined ? ['', `subscription:`, `  monthly: ${spec.monthly}`] : []),
          'usage:',
          `  - key: ${spec.usageKey}`,
          `    unit: ${spec.unit}`,
          `    price: ${spec.price}`,
          'commission: platform_default',
          '',
        ].join('\n'),
      }
      const signature = signFingerprint(keys.privateKeyPem, fingerprintOf(files))
      const submission = market.submit(official, files, signature)
      market.approve(submission.id, 'platform-seed', '自营首批供给（M3：标杆场景打破供给空窗）')
    }
    ctx.logger('market').info(`自营首批供给已上架：${OFFICIAL_PLUGINS.length} 个 L0 插件`)
  } catch (error) {
    ctx.logger('market').warn('自营插件种子失败（跳过，不影响启动）', error)
  }
}
