/**
 * @ybkk/plugin-panel-core —— 部门面板域服务（review-dsh-agent-panel-v2 Phase 1/2）。
 *
 * 数据面（opsStorage 集合，全平台此前没有 channel/message 模型，这里是最大缺口之一的落点）：
 *   panel:deptConfigs   部门↔主题/协作模式/Agent 阵容/KPI/widget 布局（数据驱动皮肤，一套骨架五种皮肤）
 *   panel:channels      协作频道
 *   panel:messages      消息（四类气泡 + Agent 操作卡片 + 钉钉同步状态；uniqueKey 支撑桥接去重）
 *   panel:tasks         任务泳道状态机（todo/doing/review/done，卡片动作落点）
 *   panel:artifacts     部门知识（Agent 产出物沉淀，引用复用）
 *   panel:readCursors   未读游标
 *   panel:activations   行业激活（org×行业，active/locked 两态落库；pending=审批中心在办）
 *
 * panelAgentRuntime（MVP 单轮，review Phase 1 第 8 条）：@Agent 唤起 → 读 Agent 资产
 * （model/systemPrompt）→ modelgw.invoke 单轮 → 产出写 messages/artifacts → usage 计量
 * （panel:<dept>.<行业code>，D1 裁决键格式）→ emit panel.message.created。
 * 模型取向：对话框显式切换（modelOverride）优先，否则跟随 Agent 资产的 model 属性；
 * 模型网关未配置时诚实降级（转人工任务），不造假 completion（对齐 modelgw 原则）。
 *
 * widget 求值 resolveWidgetSource：connector/mcp/manual/mock 四源适配，逐 widget 独立降级
 * （照抄 portal.board() 范式）；来源徽标（连接器/手工/模拟）是治理硬性 DoD。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Collection, RecordBase } from '../../platform-core/src/storage.ts'
import { PlatformEvents } from '../../platform-core/src/bus.ts'
import type { SceneActivity, ScenegraphPack } from '../../platform-core/src/scenegraph.ts'
import { ACTIVITY_LABELS } from '../../platform-core/src/scenegraph.ts'
import { newId } from '../../platform-core/src/ids.ts'
import { resolvePanelModelGateway } from './llm-bridge.ts'

// ---------------------------------------------------------------------------
// 记录模型
// ---------------------------------------------------------------------------

export interface DeptAgent {
  /** 面板展示名（@唤起的键）。 */
  name: string
  desc: string
  icon: string
  busy?: boolean
  /** 绑定的 Agent 资产引用（agent:<idOrSlug>）；缺省=未纳管，运行时诚实降级。 */
  agentRef?: string
}

export interface DeptKpi {
  label: string
  value: string
  /** 来源徽标（治理 DoD）：manual 手工 / mock 演示 / connector 业务连接器。 */
  source: 'manual' | 'mock' | 'connector'
}

export type WidgetType = 'bars' | 'funnel' | 'alerts' | 'todos' | 'feeds'

export interface DeptWidget {
  id: string
  type: WidgetType
  title: string
  live?: boolean
  /** 来源徽标（治理 DoD）：connector/mcp/manual/mock 四源。 */
  source: 'manual' | 'mock' | 'connector' | 'mcp'
  /** connector/mcp 源的引用（连接器 action / MCP 工具名）；v1 业务连接器缺位时求值降级。 */
  ref?: string
  /** 行数据（五型各自的结构，与前端渲染契约一致）。 */
  rows: unknown[][]
}

export interface DeptConfigRecord extends RecordBase {
  id: string
  label: string
  icon: string
  theme: string
  collab: string
  /** 挂载的业务活动键（场景图谱 ACT 映射，如 mfg 部门挂 mfg+scm）。 */
  acts: string[]
  colors: { accent: string; soft: string; deep: string }
  agents: DeptAgent[]
  kpis: DeptKpi[]
  widgets: DeptWidget[]
  /**
   * 绑定的平台组织（账号组织打通）：设置后部门范围权限生效——仅该组织子树内的成员
   * （及 '*' 管理员、机器凭证）可访问本部门面板；缺省=对持 panel.read 者开放。
   */
  orgId?: string
}

export interface ChannelRecord extends RecordBase {
  dept: string
  name: string
  desc?: string
  createdBy: string
}

export interface MessageCardOp {
  id: string
  label: string
  style?: 'primary' | 'dd' | 'plain'
  /** 按钮行为：task.create 建任务 / task.transition 泳道迁移 / approval.request 走审批链 / dd.push 推钉钉 / ack 仅留痕。 */
  action?: 'task.create' | 'task.transition' | 'approval.request' | 'dd.push' | 'ack'
  /** task.transition 的目标泳道。 */
  lane?: 'todo' | 'doing' | 'review' | 'done'
  /** approval.request 的风险级（high=审批中心强制二次确认）。 */
  risk?: 'high' | 'medium' | 'low'
}

export interface MessageRecord extends RecordBase {
  channelId: string
  dept: string
  senderType: 'human' | 'agent' | 'system'
  senderId?: string
  senderName: string
  senderIcon?: string
  /** 文本（白名单渲染在前端：esc 后仅放行 <b> 与 @mention span）。 */
  text: string
  mentions: string[]
  card?: { title: string; ops: MessageCardOp[]; done: string[] }
  /** 钉钉同步态：none 未开 / pending 待桥接投递 / sent 已投递 / failed 失败 / origin 来自钉钉。 */
  ddSync: 'none' | 'pending' | 'sent' | 'failed' | 'origin'
  agentName?: string
  /** Agent 回包实际使用的模型 slug（对话框切换或 Agent 资产解析结果）；人发消息无此字段。 */
  model?: string
  sceneCode?: string
  /** 桥接入向去重键（sender 提供时引擎级唯一）。 */
  uniqueKey?: string
}

export interface TaskRecord extends RecordBase {
  dept: string
  title: string
  detail?: string
  lane: 'todo' | 'doing' | 'review' | 'done'
  assigneeType: 'human' | 'agent'
  assigneeName?: string
  sceneCode?: string
  messageId?: string
  createdBy: string
}

export interface ArtifactRecord extends RecordBase {
  dept: string
  kind: 'report' | 'order' | 'quote' | 'diagnosis' | 'other'
  title: string
  content: string
  agentName?: string
  sceneCode?: string
  channelId?: string
  createdBy: string
}

export interface ReadCursorRecord extends RecordBase {
  userId: string
  channelId: string
  at: string
}

export interface ActivationRecord extends RecordBase {
  code: string
  orgId: string
  status: 'active'
  activatedAt: string
  approvalId?: string
  activatedBy?: string
}

/** 未激活行业的登记项（图形包缺位=即使误激活也无可渲染图谱，fail-closed）。 */
export interface IndustryRegistryEntry {
  code: string
  name: string
  icon: string
  sub: string
}

/** 内置行业登记：QB01/GCJX 有图谱包；其余为待授权占位（robot/nev/pcb 来自原型登记）。 */
export const INDUSTRY_REGISTRY: IndustryRegistryEntry[] = [
  { code: 'QB01', name: '家电行业', icon: '📺', sub: '整机/结构件/交互感知/电控/核心零部件 · 一图四清单' },
  { code: 'GCJX', name: '工程机械', icon: '🚜', sub: '整机/液压/电动化/基础零部件/售后运维 · 一图四清单' },
  { code: 'JQR', name: '机器人', icon: '🦾', sub: '零部件/本体/集成 · 场景图谱 2025 版' },
  { code: 'NEV', name: '新能源汽车', icon: '🚗', sub: '整车/三电/智能网联 · 场景图谱 2025 版' },
  { code: 'PCB', name: '印制板PCB', icon: '🔌', sub: '设计/制造/检测 · 场景图谱 2025 版' },
]

export const TASK_LANES = ['todo', 'doing', 'review', 'done'] as const
export type TaskLane = (typeof TASK_LANES)[number]
export const LANE_LABELS: Record<TaskLane, string> = { todo: '待办', doing: '进行中', review: '待审', done: '完成' }

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class PanelService extends Service {
  static readonly provide = 'panel'

  private streamSubscribers = new Map<string, Set<(event: { name: string; payload: unknown }) => void>>()

  constructor(ctx: Context, config: Record<string, never> = {}) {
    super(ctx, 'panel')
    void config
  }

  /**
   * 可选宿主服务软读（plan-gate01 Phase 2 瘦身）：cordis 4.x 无 optional inject 语法，
   * 未声明键的 ctx.<key> 访问在激活插件内硬抛 without inject（spike 定稿）——9 个可选键
   * （iam/authn/audit/usage/modelGateway/resourceCore/behavior/mcpRegistry/skillHub）统一走
   * ctx.reflect.get(key, false)：有提供者=实例（全量形态语义不变），无=undefined
   * （01门演示态两级降级：记录类空记录 / 能力类诚实降级），绝不裸访问。
   */
  soft<T = any>(key: string): T | undefined {
    return this.ctx.reflect.get(key, false) as T | undefined
  }

  // -- 集合 -----------------------------------------------------------------

  deptConfigs(): Collection<DeptConfigRecord> {
    return this.ctx.opsStorage.collection<DeptConfigRecord>('panel:deptConfigs')
  }

  channels(): Collection<ChannelRecord> {
    return this.ctx.opsStorage.collection<ChannelRecord>('panel:channels')
  }

  messages(): Collection<MessageRecord> {
    const collection = this.ctx.opsStorage.collection<MessageRecord>('panel:messages')
    collection.uniqueOn('bridge-dedup', (m) => (m.uniqueKey ? `${m.channelId}:${m.uniqueKey}` : `id:${m.id}`))
    return collection
  }

  tasks(): Collection<TaskRecord> {
    return this.ctx.opsStorage.collection<TaskRecord>('panel:tasks')
  }

  artifacts(): Collection<ArtifactRecord> {
    return this.ctx.opsStorage.collection<ArtifactRecord>('panel:artifacts')
  }

  readCursors(): Collection<ReadCursorRecord> {
    const collection = this.ctx.opsStorage.collection<ReadCursorRecord>('panel:readCursors')
    collection.uniqueOn('user-channel', (r) => `${r.userId}:${r.channelId}`)
    return collection
  }

  activations(): Collection<ActivationRecord> {
    return this.ctx.opsStorage.collection<ActivationRecord>('panel:activations')
  }

  // -- 部门与行业 ------------------------------------------------------------

  dept(dept: string): DeptConfigRecord {
    const config = this.deptConfigs().get(dept)
    if (!config) throw new Error(`部门不存在：${dept}`)
    return config
  }

  /** 计量/激活用的组织主键：登录人所属组织（org 树根归一由调用方保证存在）。 */
  activeIndustry(orgId: string): { code: string; name: string } | undefined {
    const activation = this.activations().findOne((item) => item.orgId === orgId && item.status === 'active')
    if (!activation) return undefined
    const registry = INDUSTRY_REGISTRY.find((item) => item.code === activation.code)
    return { code: activation.code.toLowerCase(), name: registry?.name ?? activation.code }
  }

  // -- 账号组织打通：部门 ↔ 平台组织 -----------------------------------------

  /** 组织子树包含判定（orgId 沿 parentId 上溯到 rootId）。组织目录缺失（演示态）fail-closed。 */
  orgSubtreeContains(rootId: string, orgId: string): boolean {
    const iam = this.soft('iam')
    if (!iam) return false
    let current = iam.orgs().get(orgId)
    let guard = 0
    while (current && guard++ < 32) {
      if (current.id === rootId) return true
      current = current.parentId ? iam.orgs().get(current.parentId) : undefined
    }
    return false
  }

  /** 绑定组织信息（名称实时解析，组织改名不落陈旧数据）。组织目录缺失时诚实显示未绑定。 */
  deptOrg(dept: DeptConfigRecord): { id: string; name: string } | undefined {
    if (!dept.orgId) return undefined
    const org = this.soft('iam')?.orgs().get(dept.orgId)
    return org ? { id: org.id, name: org.name } : undefined
  }

  /**
   * 部门范围权限（权限控制 × 组织归属双通道）：'*' 管理员与机器凭证（经 scope 授权的集成面）
   * 直通；绑定组织后，人必须属于该组织子树；未绑定部门对所有 panel.read 持有者开放。
   * org_admin 角色跨部门治理豁免（与 iam.* 的治理语义一致）。
   */
  deptScopeAllowed(exchangeCaller: { kind: string; userId?: string; permissions: string[] }, dept: DeptConfigRecord): boolean {
    if (exchangeCaller.permissions.includes('*')) return true
    if (exchangeCaller.kind === 'machine') return true
    if (!dept.orgId) return true
    if (exchangeCaller.userId) {
      const iam = this.soft('iam')
      const user = iam?.users().get(exchangeCaller.userId)
      if (user) {
        const isOrgAdmin = user.roleIds.some((roleId) => iam?.roles().get(roleId)?.code === 'org_admin')
        if (isOrgAdmin) return true
        return this.orgSubtreeContains(dept.orgId, user.orgId)
      }
    }
    return false
  }

  /** 部门名册：绑定组织（或全组织兜底）子树内的成员（最小 PII：姓名/职务/组织名）。组织目录缺失（演示态）→ 空名册。 */
  deptMembers(dept: DeptConfigRecord, limit = 50): Array<{ id: string; name: string; title?: string; orgName?: string }> {
    const iam = this.soft('iam')
    if (!iam) return []
    const orgRoot = dept.orgId ?? iam.orgs().find((org) => org.parentId === null).at(0)?.id
    if (!orgRoot) return []
    const inScope = (orgId: string): boolean => this.orgSubtreeContains(orgRoot, orgId)
    const orgName = (orgId: string): string => iam.orgs().get(orgId)?.name ?? ''
    return iam.users().all()
      .filter((user) => user.status === 'active' && inScope(user.orgId))
      .slice(0, limit)
      .map((user) => ({ id: user.id, name: user.displayName, ...(user.title ? { title: user.title } : {}), orgName: orgName(user.orgId) }))
  }

  /** 计量键（D1 裁决）：panel:<dept>.<行业code 小写>；无激活行业回落 panel:<dept>.core。 */
  meterResource(dept: string, orgId: string): string {
    const industry = this.activeIndustry(orgId)
    return `panel:${dept}.${industry?.code ?? 'core'}`
  }

  /** 行业三态（选择器）：active 激活 / pending 审批在办 / locked 待授权。 */
  industryStates(orgId: string, pendingCodes: string[]): Array<IndustryRegistryEntry & { state: 'active' | 'pending' | 'locked'; graphLoaded: boolean }> {
    return INDUSTRY_REGISTRY.map((entry) => {
      const active = this.activations().findOne((item) => item.orgId === orgId && item.code === entry.code && item.status === 'active')
      const graphLoaded = this.ctx.scenegraphs.get(entry.code) !== undefined
      // 已激活但图谱包缺位（如被移除）→ 仍显示 active 但 graphLoaded=false，场景页诚实降级
      const pending = !active && pendingCodes.includes(entry.code)
      return { ...entry, state: active ? 'active' : pending ? 'pending' : 'locked', graphLoaded }
    })
  }

  /**
   * 行业激活执行器（audit approvals executor）：审批通过 → 置 active + grantCapabilities + 事件。
   * review D6 裁决：复用审批链 + 能力授权，license 签发链路（Ed25519 平台私钥）留待 Phase 4。
   */
  buildActivationExecutor(): (payload: Record<string, unknown>, approverId: string) => Promise<unknown> {
    return async (payload, approverId) => {
      const code = String(payload.code ?? '')
      const orgId = String(payload.orgId ?? '')
      if (!code || !orgId) throw new Error('行业激活审批单缺少 code/orgId')
      if (!INDUSTRY_REGISTRY.some((item) => item.code === code)) throw new Error(`未登记行业：${code}`)
      const existing = this.activations().findOne((item) => item.orgId === orgId && item.code === code)
      if (existing) {
        this.activations().update(existing.id, { status: 'active', activatedAt: new Date().toISOString(), activatedBy: approverId })
      } else {
        this.activations().insert({ id: newId('act'), code, orgId, status: 'active', activatedAt: new Date().toISOString(), approvalId: String(payload.approvalId ?? ''), activatedBy: approverId })
      }
      try {
        this.soft('usage')?.grantCapabilities(`org:${orgId}`, [`panel:${code.toLowerCase()}`], 'industry-activation')
      } catch { /* 计量运行期故障不阻断激活（计费面独立降级） */ }
      this.ctx.platformBus.emit(PlatformEvents.PanelIndustryActivated, { code, orgId, activatedBy: approverId })
      return { code, orgId, status: 'active' }
    }
  }

  /** Agent 阵容 × Agent 资产联动：绑定资产的存在性与生命周期状态实时解析（宿主数字员工在线面）。资产目录缺失（演示态）→ 未绑定展示。 */
  agentWithAsset(agentCard: DeptAgent): DeptAgent & { asset?: { id: string; slug?: string; name: string; status: string; model?: string } } {
    const ref = agentCard.agentRef?.replace(/^agent:/, '') ?? ''
    if (!ref) return { ...agentCard }
    const asset = this.soft('resourceCore')?.list('agent').find((item) => item.id === ref || item.slug === ref || item.name === ref)
    if (!asset) return { ...agentCard }
    const attrs = asset.attrs as Record<string, unknown> | undefined
    return {
      ...agentCard,
      asset: {
        id: asset.id, ...(asset.slug ? { slug: asset.slug } : {}), name: asset.name,
        status: String(asset.status ?? 'draft'), ...(attrs?.model ? { model: String(attrs.model) } : {}),
      },
    }
  }

  // -- widget 求值（照抄 portal.board() 的逐源独立降级范式） -------------------

  resolveWidgetSource(widget: DeptWidget): { rows: unknown[][]; degraded: boolean; sourceLabel: string } {
    const labels = { manual: '手工登记', mock: '模拟数据', connector: '连接器', mcp: 'MCP' }
    if (widget.source === 'manual' || widget.source === 'mock') {
      return { rows: widget.rows, degraded: false, sourceLabel: labels[widget.source] }
    }
    // v1 业务连接器生态缺位（评审 C 节：演示期 100% 走 manual/mock + 来源徽标），
    // connector/mcp 源 widget 显式降级，绝不拿假数据冒充真实业务面
    return {
      rows: [],
      degraded: true,
      sourceLabel: `${labels[widget.source]}（${widget.ref ?? '未配置'}）暂不可用——等待业务连接器接入`,
    }
  }

  /** 部门看板聚合：全部 widget 独立求值降级（单块故障不拖垮整板）。 */
  board(dept: DeptConfigRecord): Array<{ id: string; type: WidgetType; title: string; live?: boolean; source: string; degraded: boolean; rows: unknown[][] }> {
    return dept.widgets.map((widget) => {
      try {
        const resolved = this.resolveWidgetSource(widget)
        return { id: widget.id, type: widget.type, title: widget.title, ...(widget.live ? { live: true } : {}), source: resolved.sourceLabel, degraded: resolved.degraded, rows: resolved.rows }
      } catch {
        return { id: widget.id, type: widget.type, title: widget.title, source: '求值失败', degraded: true, rows: [] as unknown[][] }
      }
    })
  }

  // -- 消息与频道 --------------------------------------------------------------

  /** 未读数：频道内 lastReadAt 之后的非本人消息数。 */
  unreadCount(userId: string, channelId: string): number {
    const cursor = this.readCursors().findOne((item) => item.userId === userId && item.channelId === channelId)
    const since = cursor?.at ?? ''
    return this.messages().find((m) => m.channelId === channelId && m.createdAt > since && m.senderId !== userId).length
  }

  markRead(userId: string, channelId: string): void {
    const at = new Date().toISOString()
    const cursor = this.readCursors().findOne((item) => item.userId === userId && item.channelId === channelId)
    if (cursor) this.readCursors().update(cursor.id, { at })
    else this.readCursors().insert({ id: newId('cur'), userId, channelId, at })
  }

  /**
   * 发消息：落库 → 游标推进 → 事件（钉钉桥接订阅投递）→ @Agent 唤起。
   * 返回落库消息；Agent 回包异步追加（调用方随后拉取即可）。
   */
  async sendMessage(input: {
    dept: string
    channelId: string
    senderType: 'human' | 'agent' | 'system'
    senderId?: string
    senderName: string
    /** agent 型消息的展示图标（如技能直调的 ⚡）。 */
    senderIcon?: string
    text: string
    ddSync: boolean
    card?: MessageRecord['card']
    sceneCode?: string
    uniqueKey?: string
    /** 对话框模型切换：本次会话指定模型（缺省跟随各 Agent 资产的 model 属性）。 */
    modelOverride?: string
    /** 技能斜杠直调留痕用：只落消息不触发 @Agent 唤起（同一条文本不重复走 Agent 通道）。 */
    skipAgentDispatch?: boolean
    /** agent 型回包的展示字段（senderIcon/agentName/实际使用模型），仅 senderType='agent' 携带。 */
    senderIcon?: string
    agentName?: string
    replyModel?: string
  }): Promise<MessageRecord> {
    const channel = this.channels().get(input.channelId)
    if (!channel || channel.dept !== input.dept) throw new Error(`频道不存在或不属于该部门：${input.channelId}`)
    const mentions = extractMentions(input.text)
    const record = this.messages().insert({
      id: newId('pmsg'),
      channelId: input.channelId,
      dept: input.dept,
      senderType: input.senderType,
      ...(input.senderId ? { senderId: input.senderId } : {}),
      senderName: input.senderName,
      text: input.text,
      mentions,
      ...(input.senderType === 'agent' && input.senderIcon ? { senderIcon: input.senderIcon } : {}),
      ...(input.senderType === 'agent' && input.agentName ? { agentName: input.agentName } : {}),
      ...(input.senderType === 'agent' && input.replyModel ? { model: input.replyModel } : {}),
      ...(input.card ? { card: { ...input.card, done: [] } } : {}),
      ddSync: input.senderType === 'system' ? 'none' : input.ddSync ? 'pending' : 'none',
      ...(input.sceneCode ? { sceneCode: input.sceneCode } : {}),
      ...(input.uniqueKey ? { uniqueKey: input.uniqueKey } : {}),
    })
    if (input.senderId) this.markRead(input.senderId, input.channelId)
    this.ctx.platformBus.emit(PlatformEvents.PanelMessageCreated, {
      messageId: record.id, dept: input.dept, channelId: input.channelId,
      senderName: input.senderName, text: input.text, ddSync: record.ddSync,
      card: record.card, title: record.card?.title ?? '',
    })
    if (input.senderType === 'human' && input.skipAgentDispatch !== true) void this.dispatchAgentMentions(record, input.modelOverride)
    return record
  }

  /**
   * panelAgentRuntime MVP（单轮）：@Agent 唤起 → Agent 资产 → modelgw 单轮 → 回包落库。
   * 模型取向：对话框显式指定的 modelOverride 优先，否则跟随 Agent 资产的 model 属性。
   * 未绑定资产/无模型可用 → 诚实降级消息 + 转人工待办，不造假回复。
   */
  async dispatchAgentMentions(message: MessageRecord, modelOverride?: string): Promise<void> {
    const dept = this.dept(message.dept)
    for (const agentCard of dept.agents) {
      // 按名册全名匹配（Agent 名常含空格，如「质量分析 Agent」），通用 regex 兜不了
      if (!message.text.includes(`@${agentCard.name}`)) continue
      await this.invokeAgent(dept, agentCard, message, modelOverride)
    }
  }

  async invokeAgent(dept: DeptConfigRecord, agentCard: DeptAgent, trigger: MessageRecord, modelOverride?: string): Promise<void> {
    const channel = this.channels().get(trigger.channelId)
    const orgId = this.callerOrgId(trigger.senderId)
    const reply = async (text: string, card?: MessageRecord['card'], usedModel?: string) => {
      const record = this.messages().insert({
        id: newId('pmsg'), channelId: trigger.channelId, dept: dept.id,
        senderType: 'agent', senderName: agentCard.name, senderIcon: agentCard.icon,
        text, mentions: [], ...(card ? { card: { ...card, done: [] } } : {}),
        ddSync: 'none', agentName: agentCard.name, ...(usedModel ? { model: usedModel } : {}),
        ...(trigger.sceneCode ? { sceneCode: trigger.sceneCode } : {}),
      })
      this.ctx.platformBus.emit(PlatformEvents.PanelMessageCreated, {
        messageId: record.id, dept: dept.id, channelId: trigger.channelId,
        senderName: agentCard.name, text, ddSync: 'none', card: record.card, title: record.card?.title ?? '',
      })
      return record
    }
    const fallbackToHuman = async (reason: string) => {
      await reply(`「${agentCard.name}」暂不能自主应答：${reason}已转人工待办，请相关同事跟进。`)
      this.tasks().insert({
        id: newId('ptask'), dept: dept.id, title: `跟进：${trigger.text.slice(0, 40)}`,
        detail: `Agent「${agentCard.name}」不可用（${reason}），由消息 ${trigger.id} 转人工`,
        lane: 'todo', assigneeType: 'human', createdBy: `agent:${agentCard.name}`, messageId: trigger.id,
      })
    }
    // 解析 Agent 资产（agentRef = agent:<idOrSlug>）；资产目录缺失（演示态）等同未绑定 → 诚实转人工
    const ref = agentCard.agentRef?.replace(/^agent:/, '') ?? ''
    const asset = ref ? this.soft('resourceCore')?.list('agent').find((item) => item.id === ref || item.slug === ref || item.name === ref) : undefined
    if (!asset) return void fallbackToHuman('未绑定 Agent 资产（请在控制台「Agent 本体」登记并在此配置 agentRef）')
    // 模型取向：对话框显式切换的模型优先，未指定则跟随 Agent 资产的 model 属性
    const model = modelOverride ?? String((asset.attrs as Record<string, unknown> | undefined)?.model ?? '')
    if (!model) return void fallbackToHuman('Agent 资产未配置模型（model 属性为空），且本次会话未指定模型')
    // 组装频道上下文（最近 8 条）+ 部门场景图谱摘要，单轮调用
    const recent = this.messages().find((m) => m.channelId === trigger.channelId).slice(-8)
    const contextText = recent.map((m) => `${m.senderName}: ${m.text}`).join('\n')
    const sceneSummary = this.sceneSummaryForDept(dept)
    const systemPrompt = [
      String((asset.attrs as Record<string, unknown> | undefined)?.systemPrompt ?? `你是企业部门协作面板中的数字同事「${agentCard.name}」（${agentCard.desc}）。`),
      sceneSummary ? `本部门挂载的行业场景图谱要点：\n${sceneSummary}` : '',
      `以下是频道「${channel?.name ?? ''}」最近对话：\n${contextText}`,
    ].filter(Boolean).join('\n\n')
    try {
      const gateway = resolvePanelModelGateway(this.ctx)?.gateway
      if (!gateway) throw new Error('模型网关未接入（01门演示态）——连接宿主后可用')
      const result = await gateway.invoke({
        model, orgId, subject: trigger.senderId ? `user:${trigger.senderId}` : 'panel:runtime',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: trigger.text },
        ],
      })
      await reply(result.content, undefined, result.model)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await fallbackToHuman(`模型网关调用失败（${message}）。`)
    } finally {
      // 面板协作计量（D1 裁决键格式）：org 主键缺省时跳过计量（计量面不阻塞协作面）
      if (orgId) {
        try {
          this.soft('usage')?.record({
            org: orgId,
            subject: trigger.senderId ? `user:${trigger.senderId}` : 'panel:runtime',
            principal: `org:${orgId}`,
            resource: this.meterResource(dept.id, orgId),
            meters: [{ key: 'calls', value: 1, unit: 'call' }],
            idempotency_key: `panel:agent:${trigger.id}:${agentCard.name}`,
          })
        } catch { /* 计量失败不阻塞回包 */ }
      }
    }
  }

  private callerOrgId(userId?: string): string {
    if (!userId) return ''
    const user = this.soft('iam')?.users().get(userId)
    return user?.orgId ?? ''
  }

  /**
   * 面板 Agent 点名问答（M3：panel_agent_invoke 工具的服务原语——dsh 标准对话协作主通道）。
   * 与 invokeAgent 共享资产解析/模型取向/场景摘要组装，但同步返回应答文本、不落频道消息
   * （调用方决定是否经 panel_msg_send 留痕）。失败诚实返回 ok:false + reason，不造假回复。
   */
  async askAgent(
    deptId: string,
    agentName: string,
    question: string,
    options: { userId?: string; modelOverride?: string; contextNote?: string } = {},
  ): Promise<{ ok: true; reply: string; model: string } | { ok: false; reason: string }> {
    const dept = this.dept(deptId)
    const agentCard = dept.agents.find((card) => card.name === agentName)
    if (!agentCard) {
      const names = dept.agents.map((card) => card.name)
      return { ok: false, reason: `部门 ${dept.id}（${dept.label}）名册无此 Agent。可用阵容：${names.join('、') || '（无）'}` }
    }
    const ref = agentCard.agentRef?.replace(/^agent:/, '') ?? ''
    const asset = ref ? this.soft('resourceCore')?.list('agent').find((item) => item.id === ref || item.slug === ref || item.name === ref) : undefined
    if (!asset) return { ok: false, reason: `Agent「${agentName}」未绑定 Agent 资产（agentRef），无法自主应答` }
    const model = options.modelOverride ?? String((asset.attrs as Record<string, unknown> | undefined)?.model ?? '')
    if (!model) return { ok: false, reason: `Agent「${agentName}」未配置模型（model 属性为空），且本次未指定模型` }
    const orgId = this.callerOrgId(options.userId)
    const sceneSummary = this.sceneSummaryForDept(dept)
    const systemPrompt = [
      String((asset.attrs as Record<string, unknown> | undefined)?.systemPrompt ?? `你是企业部门协作面板中的数字同事「${agentCard.name}」（${agentCard.desc}）。`),
      sceneSummary ? `本部门挂载的行业场景图谱要点：\n${sceneSummary}` : '',
      options.contextNote ?? '',
    ].filter(Boolean).join('\n\n')
    try {
      const gateway = resolvePanelModelGateway(this.ctx)?.gateway
      if (!gateway) throw new Error('模型网关未接入（01门演示态）——连接宿主后可用')
      const result = await gateway.invoke({
        model, orgId, subject: options.userId ? `user:${options.userId}` : 'panel:tool',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question },
        ],
      })
      return { ok: true, reply: result.content, model: result.model }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: `模型网关调用失败（${message}）` }
    } finally {
      // 与 invokeAgent 同风格的协作计量（org 主键缺省跳过；失败不阻塞应答）
      if (orgId) {
        try {
          this.soft('usage')?.record({
            org: orgId,
            subject: options.userId ? `user:${options.userId}` : 'panel:tool',
            principal: `org:${orgId}`,
            resource: this.meterResource(dept.id, orgId),
            meters: [{ key: 'calls', value: 1, unit: 'call' }],
            idempotency_key: `panel:ask:${dept.id}:${agentName}:${newId('ask')}`,
          })
        } catch { /* 计量失败不阻塞问答 */ }
      }
    }
  }

  // -- 技能直调（C1-2 / J1 消费面：对话框 @技能名/斜杠命令主通道） ----------------------------

  /**
   * 面板可直调的已上架技能清单（skillhub published + 调用人组织可见）。
   * 与 skillhub.search 同一套可见性口径（visibility=orgs 时按调用人组织过滤）；
   * 仅 published 可直调（deprecated/offline 不给面板点名）。
   */
  listInvokeableSkills(viewerOrgId?: string): Array<{ id: string; name: string; slug: string; summary: string; category: string; version: string }> {
    const hub = this.soft('skillHub')
    if (!hub) return []
    return hub.skills().all()
      .filter((skill) => {
        if (skill.status !== 'published') return false
        if (skill.visibility === 'orgs') {
          if (!viewerOrgId || !skill.targetOrgs.includes(viewerOrgId)) return false
        }
        return true
      })
      .sort((a, b) => b.stats.downloads - a.stats.downloads)
      .map((skill) => ({
        id: skill.id, name: skill.name, slug: skill.slug,
        summary: skill.summary, category: skill.category, version: skill.currentVersion,
      }))
  }

  /**
   * 面板技能点名直调（C1-2：panel_skill_invoke 工具与面板对话框共享的服务原语）。
   * 语义：skillhub 已上架（published）技能 → 取当前版本内容作为指令上下文 → 模型网关单轮应答。
   * 失败诚实返回 ok:false + reason（不存在/未上架/不可见/无内容/网关失败），不造假回复、不静默。
   * 与 askAgent 同风格：不落频道消息，调用方决定是否经 sendMessage 留痕。
   */
  async invokeSkill(
    skillName: string,
    message: string,
    options: { userId?: string; modelOverride?: string; contextNote?: string } = {},
  ): Promise<{ ok: true; reply: string; model: string; skill: { name: string; version: string } } | { ok: false; reason: string }> {
    const name = skillName.trim()
    if (!name) return { ok: false, reason: '技能名为空（用 /技能名 或 panel_skill_invoke 点名）' }
    const orgId = this.callerOrgId(options.userId)
    const invokeable = this.listInvokeableSkills(orgId || undefined)
    // 按名全名匹配优先，slug 兜底（技能名常含中文与空格，通用 regex 兜不了）
    const skill = invokeable.find((item) => item.name === name) ?? invokeable.find((item) => item.slug === name)
    if (!skill) {
      const hint = this.soft('skillHub')?.skills().all().find((item) => item.status === 'published' && (item.name === name || item.slug === name))
      if (hint) return { ok: false, reason: `技能「${name}」未对当前用户组织开放（visibility=${hint.visibility}），无法直调` }
      const names = invokeable.slice(0, 8).map((item) => item.name)
      return { ok: false, reason: `没有已上架且对您开放的技能「${name}」。可用技能：${names.join('、') || '（无）'}` }
    }
    const record = this.soft('skillHub')?.skills().get(skill.id)
    const version = record?.versions.find((item) => item.version === skill.version && item.status === 'published')
    const content = version?.content?.trim() ?? ''
    if (!content) return { ok: false, reason: `技能「${skill.name}」当前版本（${skill.version}）无指令内容，无法直调` }
    // 模型取向：显式指定优先；未指定时不跟随 Agent 资产（技能无资产），自动取目录首个在线模型
    // （班组长没选过模型也要能一把直调——目录为空才诚实拒绝）
    let model = options.modelOverride?.trim() ?? ''
    if (!model) {
      // 只自动选「在线且已配 endpoint」的模型——无 endpoint 的模型调用必失败，不应被自动选中（J1 行为加固）
      // （dsh 桥目录条目 endpoint 为「内置通道」占位非空 → 天然可被自动选中，正是 01门装态的期望行为）
      const online = resolvePanelModelGateway(this.ctx)?.gateway.models().all()
        .filter((item: { status: string; endpoint: string }) => item.status === 'online' && item.endpoint.trim() !== '') ?? []
      if (online.length === 0) return { ok: false, reason: '模型目录暂无在线模型——请管理员在「模型管理」中接入后再直调技能' }
      model = online[0]!.slug
    }
    const systemPrompt = [
      `你在执行企业技能平台上架的技能「${skill.name}」（${skill.summary}）。严格按以下技能指令完成任务：`,
      content,
      options.contextNote ?? '',
    ].filter(Boolean).join('\n\n')
    try {
      const gateway = resolvePanelModelGateway(this.ctx)?.gateway
      if (!gateway) throw new Error('模型网关未接入（01门演示态）——连接宿主后可用')
      const result = await gateway.invoke({
        model, orgId, subject: options.userId ? `user:${options.userId}` : 'panel:tool',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message || '（无附加输入，按技能指令执行）' },
        ],
      })
      return { ok: true, reply: result.content, model: result.model, skill: { name: skill.name, version: skill.version } }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: `模型网关调用失败（${reason}）` }
    } finally {
      // 与 askAgent 同风格的协作计量（org 主键缺省跳过；失败不阻塞回包）
      if (orgId) {
        try {
          this.soft('usage')?.record({
            org: orgId,
            subject: options.userId ? `user:${options.userId}` : 'panel:tool',
            principal: `org:${orgId}`,
            // J1 契约 v1 对表：计量资源键用 skill:<ID>（slug 可能含非 ASCII，过不了 usage resource 校验）
            resource: `skill:${skill.id}`,
            meters: [{ key: 'calls', value: 1, unit: 'call' }],
            idempotency_key: `panel:skill:${skill.id}:${newId('inv')}`,
          })
        } catch { /* 计量失败不阻塞直调 */ }
      }
    }
  }

  /** 部门挂载活动的场景图谱摘要（注入 Agent 系统提示；图谱未装载则空串）。 */
  sceneSummaryForDept(dept: DeptConfigRecord): string {
    try {
      const orgId = this.soft('iam')?.orgs().all()[0]?.id ?? ''
      const active = this.activeIndustry(orgId)
      if (!active) return ''
      const pack = this.ctx.scenegraphs.get(active.code.toUpperCase())
      if (!pack) return ''
      return dept.acts.flatMap((act) => (pack.activities[act as SceneActivity] ?? [])
        .map((scene) => `${scene.code} ${scene.name}（现状 ${'★'.repeat(scene.s)}${'☆'.repeat(4 - scene.s)}，痛点：${scene.pain}）`)).join('\n')
    } catch {
      return ''
    }
  }

  // -- 卡片动作（走纯平台链：任务落点 / 审批链 / 钉钉推送） -----------------------

  async cardAction(input: { messageId: string; opId: string; actorId: string; actorName: string; reason?: string }): Promise<{ message: MessageRecord; result: string }> {
    const message = this.messages().get(input.messageId)
    if (!message?.card) throw new Error(`消息不存在或无操作卡片：${input.messageId}`)
    const op = message.card.ops.find((item) => item.id === input.opId)
    if (!op) throw new Error(`操作项不存在：${input.opId}`)
    if (message.card.done.includes(input.opId)) throw new Error('该操作已执行过（幂等保护）')
    let result = '已记录'
    const action = op.action ?? 'ack'
    if (action === 'task.create') {
      this.tasks().insert({
        id: newId('ptask'), dept: message.dept, title: message.card.title,
        detail: `来自消息卡片（${input.actorName} 确认）`, lane: 'todo', assigneeType: 'human',
        sceneCode: message.sceneCode, createdBy: input.actorId, messageId: message.id,
      })
      result = `已生成任务：${message.card.title}`
    } else if (action === 'task.transition') {
      const task = this.tasks().find((item) => item.messageId === message.id).at(-1)
        ?? this.tasks().find((item) => item.dept === message.dept && item.lane !== 'done').at(-1)
      if (!task) throw new Error('没有可流转的关联任务')
      this.transitionTask(task.id, op.lane ?? 'doing', input.actorId)
      result = `任务 ${task.title} → ${LANE_LABELS[op.lane ?? 'doing']}`
    } else if (action === 'approval.request') {
      const audit = this.soft('audit')
      if (!audit) throw new Error('审批中心未接入（01门演示态）——连接宿主后可走审批链')
      const approval = audit.createApproval({
        kind: 'panel.card-action',
        title: `${message.card.title} · ${op.label}`,
        payload: { messageId: message.id, dept: message.dept, opId: op.id, opLabel: op.label, reason: input.reason ?? '' },
        requesterId: input.actorId, requesterName: input.actorName,
        ...(op.risk ? { riskLevel: op.risk } : {}),
      })
      result = `已提交审批（${approval.id}），在审批中心跟进`
    } else if (action === 'dd.push') {
      // 桥接订阅 panel.card.action（action=dd.push）执行投递；此处仅置意图与留痕
      result = '已请求推送钉钉'
    }
    const done = [...message.card.done, input.opId]
    this.messages().update(message.id, { card: { ...message.card, done } })
    const updated = this.messages().get(message.id)!
    this.ctx.platformBus.emit(PlatformEvents.PanelCardAction, {
      messageId: message.id, dept: message.dept, opId: op.id, opLabel: op.label, action,
      title: message.card.title, text: message.text, actorId: input.actorId, actorName: input.actorName,
      ddPush: action === 'dd.push', channelName: this.channels().get(message.channelId)?.name ?? '',
    })
    return { message: updated, result }
  }

  // -- 任务 -------------------------------------------------------------------

  createTask(input: { dept: string; title: string; detail?: string; lane?: TaskLane; assigneeType?: 'human' | 'agent'; assigneeName?: string; sceneCode?: string; createdBy: string }): TaskRecord {
    this.dept(input.dept)
    return this.tasks().insert({
      id: newId('ptask'), dept: input.dept, title: input.title,
      ...(input.detail ? { detail: input.detail } : {}),
      lane: input.lane ?? 'todo',
      assigneeType: input.assigneeType ?? 'human',
      ...(input.assigneeName ? { assigneeName: input.assigneeName } : {}),
      ...(input.sceneCode ? { sceneCode: input.sceneCode } : {}),
      createdBy: input.createdBy,
    })
  }

  transitionTask(taskId: string, lane: TaskLane, actorId: string): TaskRecord {
    const task = this.tasks().get(taskId)
    if (!task) throw new Error(`任务不存在：${taskId}`)
    if (!TASK_LANES.includes(lane)) throw new Error(`非法泳道：${lane}`)
    const updated = this.tasks().update(taskId, { lane })
    this.ctx.platformBus.emit(PlatformEvents.PanelTaskUpdated, { taskId, dept: task.dept, lane, actorId, title: task.title })
    return updated
  }

  // -- 场景诊断（会话 × 图谱联动） -------------------------------------------------

  /** 场景编号规范引用（如 QB01-A-2-5）——会话产出沉淀回转型路线图的联动点。 */
  sceneContext(code: string): { pack: ScenegraphPack; activityLabel: string; sceneLabel: string } {
    const hit = this.ctx.scenegraphs.findScene(code)
    if (!hit) throw new Error(`场景编号在已装载图谱中不存在：${code}`)
    return { pack: hit.pack, activityLabel: ACTIVITY_LABELS[hit.activity], sceneLabel: `${hit.scene.name}（现状 ${'★'.repeat(hit.scene.s)}${'☆'.repeat(4 - hit.scene.s)}）` }
  }

  async diagnose(input: { dept: string; sceneCode: string; actorId: string; actorName: string }): Promise<{ message: MessageRecord; task: TaskRecord }> {
    const dept = this.dept(input.dept)
    const { pack, sceneLabel } = this.sceneContext(input.sceneCode)
    const channel = this.channels().find((item) => item.dept === input.dept).at(0)
    if (!channel) throw new Error(`部门 ${dept.label} 暂无协作频道，请先建频道`)
    const agentCard = dept.agents[0]
    const text = `@${agentCard.name} 请对「${pack.name}」场景「${sceneLabel}」（${input.sceneCode}）做数字化诊断，按一图四清单框架评估差距/选型/优先级。`
    const message = await this.sendMessage({
      dept: input.dept, channelId: channel.id, senderType: 'human', senderId: input.actorId,
      senderName: input.actorName, text, ddSync: false, sceneCode: input.sceneCode,
    })
    const task = this.createTask({
      dept: input.dept, title: `场景诊断：${input.sceneCode} ${sceneLabel}`,
      detail: `派 ${agentCard.name} 按一图四清单框架诊断（来自场景图谱 ${pack.code}）`,
      lane: 'todo', assigneeType: 'agent', assigneeName: agentCard.name,
      sceneCode: input.sceneCode, createdBy: input.actorId,
    })
    return { message, task }
  }

  // -- SSE 订阅注册表 -----------------------------------------------------------

  subscribeStream(dept: string, listener: (event: { name: string; payload: unknown }) => void): () => void {
    const set = this.streamSubscribers.get(dept) ?? new Set()
    set.add(listener)
    this.streamSubscribers.set(dept, set)
    return () => set.delete(listener)
  }

  /** 平台事件 → SSE 订阅者扇出（panel.* 与 dingtalk-bridge.delivered）。 */
  wireEventBus(): void {
    const forward = (name: string) => (payload: unknown) => {
      const dept = (payload as { dept?: string } | undefined)?.dept
      const targets = dept ? [dept] : [...this.streamSubscribers.keys()]
      for (const target of targets) {
        for (const listener of this.streamSubscribers.get(target) ?? []) {
          try { listener({ name, payload }) } catch { /* 单订阅者故障不断链 */ }
        }
      }
    }
    this.ctx.platformBus.on(PlatformEvents.PanelMessageCreated, forward(PlatformEvents.PanelMessageCreated))
    this.ctx.platformBus.on(PlatformEvents.PanelTaskUpdated, forward(PlatformEvents.PanelTaskUpdated))
    this.ctx.platformBus.on(PlatformEvents.PanelCardAction, forward(PlatformEvents.PanelCardAction))
    this.ctx.platformBus.on(PlatformEvents.PanelIndustryActivated, forward(PlatformEvents.PanelIndustryActivated))
    this.ctx.platformBus.on(PlatformEvents.DingtalkDelivered, forward(PlatformEvents.DingtalkDelivered))
    this.ctx.platformBus.on(PlatformEvents.ScenegraphUpdated, forward(PlatformEvents.ScenegraphUpdated))
  }
}

/**
 * @提及解析（展示用）：匹配中文/英文/数字昵称。Agent 名册的全名匹配（含空格）在
 * dispatchAgentMentions 里按名字面量做，这里只负责通用的高亮候选。
 */
export function extractMentions(text: string): string[] {
  const mentions = new Set<string>()
  for (const match of text.matchAll(/@([\p{L}\p{N}·]{2,20})/gu)) mentions.add(match[1]!)
  return [...mentions]
}
