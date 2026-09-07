/**
 * @dsh-ops/plugin-panel-core —— 部门 Agent 工作台面板（review-dsh-agent-panel-v2 Phase 1/2）。
 *
 * 职责：
 *   - 静态托管面板 SPA（/panel，对外经 dsh-bridge 即 /rq/panel/；宿主 web diff=0 铁律）
 *   - /api/panel/* REST（guarded + 权限点；自注册路由推入 httpServer.routeMatrix 共享登记处，
 *     保住 selftest 的 RBAC 100% 越权断言网——Phase 0 补欠账）
 *   - SSE /api/panel/stream（EventSource 无法带 Bearer → 端点公开 + 内部 ?token= 自校验 fail-closed；
 *     降级轮询 GET /api/panel/:dept/poll——钉钉 webview 30s 轮询兜底铁律）
 *   - 行业激活审批执行器（audit approvals：申请→审批→置 active+grantCapabilities；license 签发链路 Phase 4）
 *   - panel_* 工具族（注册共享 tools 键，dsh 下即原生 ToolRuntime 可被模型调用）
 *   - 种子：基线=五部门骨架配置+内置行业激活；DEMO_SEED=1 追加演示会话/任务/知识/看板
 */
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { HttpExchange } from '../../platform-core/src/index.ts'
import { PlatformEvents } from '../../platform-core/src/bus.ts'
import { newId } from '../../platform-core/src/ids.ts'
import { PanelService, TASK_LANES, type TaskLane, type DeptWidget, type DeptKpi, type DeptAgent } from './service.ts'
import { seedPanel } from './seed/seed.ts'

export const name = 'panel-core'
export const inject = [
  'httpServer', 'opsStorage', 'platformBus', 'tools',
  'iam', 'authn', 'audit', 'usage', 'modelGateway', 'resourceCore', 'scenegraphs',
]
// 注意：panel 服务不可自 inject（cordis 的 inject 是加载前硬依赖，自依赖=永久挂起）——
// 本插件内部直接 new PanelService(ctx) 使用；类经 ctx.plugin 注册供 dingtalk-bridge 注入。

interface CallerInfo {
  kind: 'human' | 'machine'
  principalId: string
  userId?: string
  name: string
  permissions: string[]
  actChain: Array<{ name: string; type: string }>
}

const DEPT_RE = /^[a-z]{2,12}$/

export function apply(ctx: Context) {
  const http = ctx.httpServer
  ctx.plugin(PanelService)
  const panel = new PanelService(ctx)

  const caller = (exchange: HttpExchange): CallerInfo => exchange.principal as CallerInfo

  // 与 console 同款 requirePermission：缺权限 403 + audit.authz.denied 留痕（RBAC 探针的判定面）
  const requirePermission = (exchange: HttpExchange, point: string): boolean => {
    const info = caller(exchange)
    if (info.permissions.includes('*') || info.permissions.includes(point)) return true
    ctx.platformBus.emit('audit.authz.denied', {
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      point,
      path: exchange.path,
    })
    exchange.fail(403, 'FORBIDDEN', `缺少权限点 ${point}，请联系管理员调整角色`, { permission: point })
    return false
  }

  const guarded = (method: string, path: string, permission: string, handler: (exchange: HttpExchange) => unknown | Promise<unknown>): void => {
    // 自注册路由必须进共享矩阵（routeMatrix 机制下沉后的插件侧登记义务）
    http.routeMatrix.push({ method, path, permission })
    http.register(method, path, async (exchange) => {
      if (!requirePermission(exchange, permission)) return
      try {
        const result = await handler(exchange)
        if (!exchange.res.writableEnded) exchange.ok(result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        exchange.fail(400, 'BAD_REQUEST', message)
      }
    })
  }

  const body = <T extends Record<string, any>>(exchange: HttpExchange): T => (exchange.body ?? {}) as T
  const changeLog = (exchange: HttpExchange, action: string, resourceType: string, resourceId: string, resourceName: string, detail = ''): void => {
    const info = caller(exchange)
    ctx.audit.record({
      type: 'change',
      actorType: info.kind === 'human' ? 'human' : 'machine',
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      action,
      resourceType,
      resourceId,
      resourceName,
      result: 'ok',
      detail,
      ...(info.actChain.length > 0 ? { actChain: info.actChain } : {}),
    })
  }

  /** 部门参数解析 + 归属校验（部门范围权限：绑定组织后仅组织子树/管理员/机器凭证可访问）。 */
  const deptOf = (exchange: HttpExchange) => {
    const dept = String(exchange.params.dept ?? '')
    if (!DEPT_RE.test(dept)) throw new Error(`部门标识非法：${dept}`)
    const config = panel.dept(dept)
    if (!panel.deptScopeAllowed(caller(exchange), config)) {
      exchange.fail(403, 'FORBIDDEN', `部门范围受限：${config.label} 已绑定组织治理，仅该组织子树成员可访问`, { permission: 'panel.read', deptScope: config.orgId })
      throw new Error('部门范围受限')
    }
    return config
  }

  const orgIdOf = (exchange: HttpExchange): string => {
    const info = caller(exchange)
    return (info.userId ? ctx.iam.users().get(info.userId)?.orgId : undefined)
      ?? ctx.iam.orgs().find((org) => org.parentId === null).at(0)?.id
      ?? ''
  }

  // -- 部门与总览 -------------------------------------------------------------

  guarded('GET', '/api/panel/depts', 'panel.read', (exchange) => {
    const info = caller(exchange)
    return {
      depts: panel.deptConfigs().all().map((dept) => ({
        ...dept,
        allowed: panel.deptScopeAllowed(info, dept),
        org: panel.deptOrg(dept),
      })),
    }
  })

  // 组织树（配置抽屉的部门↔组织绑定选择器；最小字段，panel.config.write 管理面）
  guarded('GET', '/api/panel/orgs', 'panel.config.write', (exchange) => ({
    orgs: ctx.iam.orgs().all().map((org) => ({ id: org.id, name: org.name, parentId: org.parentId })),
  }))

  /** 部门↔组织绑定（账号组织打通的管理动作）：设置后部门范围权限即刻生效。 */
  guarded('PUT', '/api/panel/:dept/config', 'panel.config.write', (exchange) => {
    const dept = panel.dept(String(exchange.params.dept ?? ''))
    const input = body<{ orgId?: string | null }>(exchange)
    if (input.orgId !== undefined && input.orgId !== null && input.orgId !== '') {
      if (!ctx.iam.orgs().get(input.orgId)) throw new Error(`组织不存在：${input.orgId}`)
      ctx.panel.deptConfigs().update(dept.id, { orgId: input.orgId })
    } else {
      ctx.panel.deptConfigs().update(dept.id, { orgId: undefined })
    }
    const updated = panel.dept(dept.id)
    changeLog(exchange, 'panel.dept.bind_org', 'panel_dept', dept.id, dept.label, updated.orgId ?? '（解除绑定）')
    return { dept: { ...updated, org: panel.deptOrg(updated) } }
  })

  guarded('GET', '/api/panel/:dept/overview', 'panel.read', (exchange) => {
    const dept = deptOf(exchange)
    const info = caller(exchange)
    const orgId = orgIdOf(exchange)
    const channels = panel.channels().find((item) => item.dept === dept.id).map((channel) => ({
      ...channel,
      unread: info.userId ? panel.unreadCount(info.userId, channel.id) : 0,
    }))
    return {
      dept,
      org: panel.deptOrg(dept),
      members: panel.deptMembers(dept),
      industry: panel.activeIndustry(orgId),
      channels,
      agents: dept.agents.map((agent) => panel.agentWithAsset(agent)),
      kpis: dept.kpis,
      widgets: panel.board(dept),
      pendingActivations: ctx.audit.approvals().find((item) => item.kind === 'industry.activation' && item.status === 'pending')
        .map((item) => ({ id: item.id, code: String(item.payload.code ?? ''), orgId: String(item.payload.orgId ?? '') }))
        .filter((item) => !orgId || item.orgId === orgId),
    }
  })

  guarded('GET', '/api/panel/:dept/board', 'panel.read', (exchange) => ({
    dept: deptOf(exchange).id,
    widgets: panel.board(deptOf(exchange)),
  }))

  // -- 配置抽屉（widget / KPI / Agent 阵容） ------------------------------------

  guarded('GET', '/api/panel/:dept/widgets', 'panel.read', (exchange) => ({ widgets: deptOf(exchange).widgets }))

  guarded('PUT', '/api/panel/:dept/widgets', 'panel.config.write', (exchange) => {
    const dept = deptOf(exchange)
    const widgets = body<{ widgets?: DeptWidget[] }>(exchange).widgets
    if (!Array.isArray(widgets)) throw new Error('body.widgets 必须是数组')
    for (const widget of widgets) {
      if (!widget.id || !widget.type || !widget.title) throw new Error('widget 必须包含 id/type/title')
      if (!['bars', 'funnel', 'alerts', 'todos', 'feeds'].includes(widget.type)) throw new Error(`widget.type 非法：${widget.type}`)
      if (!['manual', 'mock', 'connector', 'mcp'].includes(widget.source)) throw new Error(`widget.source 非法（来源徽标必填）：${widget.source}`)
    }
    ctx.panel.deptConfigs().update(dept.id, { widgets })
    changeLog(exchange, 'panel.widget.layout', 'panel_dept', dept.id, dept.label, `${widgets.length} 块 widget`)
    return { widgets }
  })

  guarded('GET', '/api/panel/:dept/kpis', 'panel.read', (exchange) => ({ kpis: deptOf(exchange).kpis }))

  guarded('PUT', '/api/panel/:dept/kpis', 'panel.config.write', (exchange) => {
    const dept = deptOf(exchange)
    const kpis = body<{ kpis?: DeptKpi[] }>(exchange).kpis
    if (!Array.isArray(kpis)) throw new Error('body.kpis 必须是数组')
    for (const kpi of kpis) {
      if (!kpi.label || kpi.value === undefined) throw new Error('kpi 必须包含 label/value')
      if (!['manual', 'mock', 'connector'].includes(kpi.source)) throw new Error(`kpi.source 非法（来源徽标必填）：${kpi.source}`)
    }
    ctx.panel.deptConfigs().update(dept.id, { kpis })
    changeLog(exchange, 'panel.kpi.layout', 'panel_dept', dept.id, dept.label, `${kpis.length} 个 KPI`)
    return { kpis }
  })

  guarded('PUT', '/api/panel/:dept/agents', 'panel.config.write', (exchange) => {
    const dept = deptOf(exchange)
    const agents = body<{ agents?: DeptAgent[] }>(exchange).agents
    if (!Array.isArray(agents) || agents.length === 0) throw new Error('body.agents 必须是非空数组')
    for (const agent of agents) {
      if (!agent.name || !agent.icon) throw new Error('agent 必须包含 name/icon')
      if (agent.agentRef && !/^agent:[A-Za-z0-9._-]+$/.test(agent.agentRef)) throw new Error(`agentRef 格式非法（agent:<idOrSlug>）：${agent.agentRef}`)
    }
    ctx.panel.deptConfigs().update(dept.id, { agents })
    changeLog(exchange, 'panel.agent.roster', 'panel_dept', dept.id, dept.label, `${agents.length} 个 Agent 阵容位`)
    return { agents }
  })

  // -- 频道与消息 ---------------------------------------------------------------

  guarded('GET', '/api/panel/:dept/channels', 'panel.read', (exchange) => {
    const dept = deptOf(exchange)
    const info = caller(exchange)
    return {
      channels: panel.channels().find((item) => item.dept === dept.id).map((channel) => ({
        ...channel,
        unread: info.userId ? panel.unreadCount(info.userId, channel.id) : 0,
      })),
    }
  })

  guarded('POST', '/api/panel/:dept/channels', 'panel.write', (exchange) => {
    const dept = deptOf(exchange)
    const input = body<{ name?: string; desc?: string }>(exchange)
    if (!input.name?.trim()) throw new Error('频道名必填')
    const info = caller(exchange)
    const channel = panel.channels().insert({
      id: newId('pchan'), dept: dept.id, name: input.name.trim(),
      ...(input.desc ? { desc: input.desc.trim() } : {}), createdBy: info.userId ?? info.principalId,
    })
    changeLog(exchange, 'panel.channel.create', 'panel_channel', channel.id, channel.name)
    return { channel }
  })

  guarded('GET', '/api/panel/:dept/messages', 'panel.read', (exchange) => {
    const dept = deptOf(exchange)
    const channelId = exchange.query.get('channelId') ?? ''
    const after = exchange.query.get('after') ?? ''
    const limit = Math.min(Number(exchange.query.get('limit') ?? 80), 200)
    let rows = panel.messages().find((m) => m.dept === dept.id && (channelId ? m.channelId === channelId : true))
    if (after) rows = rows.filter((m) => m.createdAt > after)
    return { messages: rows.slice(-limit) }
  })

  guarded('POST', '/api/panel/:dept/messages', 'panel.write', async (exchange) => {
    const dept = deptOf(exchange)
    const input = body<{ channelId?: string; text?: string; ddSync?: boolean; uniqueKey?: string }>(exchange)
    if (!input.text?.trim()) throw new Error('消息内容必填')
    const channelId = input.channelId || panel.channels().find((item) => item.dept === dept.id).at(0)?.id
    if (!channelId) throw new Error('部门暂无频道，请先创建')
    const info = caller(exchange)
    const message = await panel.sendMessage({
      dept: dept.id, channelId, senderType: 'human', senderId: info.userId,
      senderName: info.name, text: input.text.trim(), ddSync: input.ddSync === true,
      ...(input.uniqueKey ? { uniqueKey: input.uniqueKey } : {}),
    })
    return { message }
  })

  guarded('POST', '/api/panel/channels/:id/read', 'panel.read', (exchange) => {
    const info = caller(exchange)
    if (!info.userId) throw new Error('仅平台账号可推进已读游标')
    panel.markRead(info.userId, String(exchange.params.id))
    return { ok: true }
  })

  guarded('POST', '/api/panel/messages/:id/card-action', 'panel.write', async (exchange) => {
    const input = body<{ opId?: string; reason?: string }>(exchange)
    if (!input.opId) throw new Error('opId 必填')
    const info = caller(exchange)
    const result = await panel.cardAction({
      messageId: String(exchange.params.id), opId: input.opId,
      actorId: info.userId ?? info.principalId, actorName: info.name, ...(input.reason ? { reason: input.reason } : {}),
    })
    changeLog(exchange, 'panel.card.action', 'panel_message', result.message.id, result.message.card?.title ?? '', result.result)
    return result
  })

  // -- 任务看板 -----------------------------------------------------------------

  guarded('GET', '/api/panel/:dept/tasks', 'panel.read', (exchange) => ({
    tasks: panel.tasks().find((item) => item.dept === deptOf(exchange).id),
  }))

  guarded('POST', '/api/panel/:dept/tasks', 'panel.task.write', (exchange) => {
    const dept = deptOf(exchange)
    const input = body<{ title?: string; detail?: string; lane?: string; assigneeName?: string; assigneeType?: string; sceneCode?: string }>(exchange)
    if (!input.title?.trim()) throw new Error('任务标题必填')
    if (input.lane !== undefined && !TASK_LANES.includes(input.lane as TaskLane)) throw new Error(`非法泳道：${input.lane}`)
    const info = caller(exchange)
    const task = panel.createTask({
      dept: dept.id, title: input.title.trim(),
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.lane ? { lane: input.lane as TaskLane } : {}),
      ...(input.assigneeType === 'agent' ? { assigneeType: 'agent' as const } : {}),
      ...(input.assigneeName ? { assigneeName: input.assigneeName } : {}),
      ...(input.sceneCode ? { sceneCode: input.sceneCode } : {}),
      createdBy: info.userId ?? info.principalId,
    })
    return { task }
  })

  guarded('POST', '/api/panel/tasks/:id/transition', 'panel.task.write', (exchange) => {
    const lane = body<{ lane?: string }>(exchange).lane
    if (!lane || !TASK_LANES.includes(lane as TaskLane)) throw new Error(`非法泳道：${lane}`)
    const info = caller(exchange)
    return { task: panel.transitionTask(String(exchange.params.id), lane as TaskLane, info.userId ?? info.principalId) }
  })

  // -- 部门知识 ------------------------------------------------------------------

  guarded('GET', '/api/panel/:dept/artifacts', 'panel.read', (exchange) => ({
    artifacts: panel.artifacts().find((item) => item.dept === deptOf(exchange).id).slice(-100).reverse(),
  }))

  guarded('POST', '/api/panel/:dept/artifacts', 'panel.write', (exchange) => {
    const dept = deptOf(exchange)
    const input = body<{ title?: string; content?: string; kind?: string; sceneCode?: string }>(exchange)
    if (!input.title?.trim() || !input.content?.trim()) throw new Error('标题与内容必填')
    const kind = (['report', 'order', 'quote', 'diagnosis', 'other'].includes(input.kind ?? '') ? input.kind : 'other') as 'report' | 'order' | 'quote' | 'diagnosis' | 'other'
    const info = caller(exchange)
    const artifact = panel.artifacts().insert({
      id: newId('part'), dept: dept.id, kind, title: input.title.trim(), content: input.content.trim(),
      ...(input.sceneCode ? { sceneCode: input.sceneCode } : {}), createdBy: info.userId ?? info.principalId,
    })
    changeLog(exchange, 'panel.artifact.create', 'panel_artifact', artifact.id, artifact.title)
    return { artifact }
  })

  // -- 场景图谱联动 ----------------------------------------------------------------

  guarded('POST', '/api/panel/:dept/scenes/:code/diagnose', 'panel.write', async (exchange) => {
    const info = caller(exchange)
    return panel.diagnose({
      dept: String(exchange.params.dept), sceneCode: String(exchange.params.code),
      actorId: info.userId ?? info.principalId, actorName: info.name,
    })
  })

  guarded('POST', '/api/panel/:dept/scenes/:code/sync-dingtalk', 'panel.write', (exchange) => {
    const dept = deptOf(exchange)
    const code = String(exchange.params.code)
    const { pack, sceneLabel } = panel.sceneContext(code)
    const info = caller(exchange)
    ctx.platformBus.emit(PlatformEvents.PanelCardAction, {
      dept: dept.id, opId: 'scene-sync', opLabel: '同步钉钉群', action: 'dd.push', ddPush: true,
      title: `🗺 ${pack.name}场景卡：${sceneLabel}`,
      text: `【${pack.name} · ${code}】${sceneLabel}\n痛点与四清单详见部门面板「场景图谱」页。`,
      actorId: info.userId ?? info.principalId, actorName: info.name, channelName: '',
    })
    changeLog(exchange, 'panel.scene.sync_dingtalk', 'panel_scene', code, sceneLabel)
    return { ok: true, note: '已请求钉钉桥接投递（未绑定群桥时投递失败会留痕告警）' }
  })

  // -- 行业三态 + 激活申请 + 图谱 -----------------------------------------------------

  guarded('GET', '/api/panel/industries', 'panel.read', (exchange) => {
    const orgId = orgIdOf(exchange)
    const pendingCodes = ctx.audit.approvals()
      .find((item) => item.kind === 'industry.activation' && item.status === 'pending' && String(item.payload.orgId ?? '') === orgId)
      .map((item) => String(item.payload.code ?? ''))
    return { industries: panel.industryStates(orgId, pendingCodes) }
  })

  guarded('POST', '/api/panel/industries/:code/activate-requests', 'panel.write', (exchange) => {
    const code = String(exchange.params.code ?? '').toUpperCase()
    const registry = panel.industryStates('', []).find((item) => item.code === code)
    if (!registry) throw new Error(`未登记行业：${code}`)
    const orgId = orgIdOf(exchange)
    if (!orgId) throw new Error('无法确定所属组织（组织账号缺失）')
    const existing = panel.activations().findOne((item) => item.orgId === orgId && item.code === code && item.status === 'active')
    if (existing) throw new Error(`行业 ${code} 对本组织已是激活态`)
    const info = caller(exchange)
    const approval = ctx.audit.createApproval({
      kind: 'industry.activation',
      title: `行业功能包授权激活：${registry.name}（${code}）`,
      payload: { code, orgId, requestedBy: info.name, sub: registry.sub, graphLoaded: registry.graphLoaded },
      requesterId: info.userId ?? info.principalId,
      requesterName: info.name,
      riskLevel: 'high',
    })
    changeLog(exchange, 'panel.industry.activate_request', 'panel_industry', code, registry.name, `审批单 ${approval.id}`)
    return { approval }
  })

  guarded('GET', '/api/panel/scenegraph', 'scenegraph.read', (exchange) => {
    const code = (exchange.query.get('industry') ?? '').toUpperCase()
    const pack = ctx.scenegraphs.get(code)
    if (!pack) throw new Error(`场景图谱未装载或未激活：${code}（已装载：${ctx.scenegraphs.all().map((item) => item.code).join('/') || '无'}）`)
    return { pack, problems: ctx.scenegraphs.loadProblems() }
  })

  guarded('POST', '/api/panel/scenegraphs/reload', 'panel.config.write', async (exchange) => {
    const result = await ctx.scenegraphs.reloadFromDir()
    changeLog(exchange, 'panel.scenegraph.reload', 'scenegraph', 'all', `${result.packs} 包`, `问题 ${result.problems.length} 项`)
    return result
  })

  // -- 降级轮询 + SSE（钉钉 webview 双通道铁律） --------------------------------------

  guarded('GET', '/api/panel/:dept/poll', 'panel.read', (exchange) => {
    const dept = deptOf(exchange)
    const info = caller(exchange)
    const since = exchange.query.get('since') ?? ''
    const messages = panel.messages().find((m) => m.dept === dept.id && (since ? m.createdAt > since : true)).slice(-50)
    return {
      at: new Date().toISOString(),
      messages,
      tasks: panel.tasks().find((item) => item.dept === dept.id),
      unread: info.userId
        ? panel.channels().find((item) => item.dept === dept.id).map((channel) => ({ channelId: channel.id, unread: panel.unreadCount(info.userId, channel.id) }))
        : [],
    }
  })

  // SSE：公开路径（console 白名单）+ ?token= 内部自校验（EventSource 无法带 Bearer；fail-closed）
  http.register('GET', '/api/panel/stream', (exchange) => {
    const fail = (status: number, message: string) => exchange.fail(status, 'STREAM_AUTH_FAILED', message)
    const token = exchange.query.get('token') ?? ''
    const dept = exchange.query.get('dept') ?? ''
    if (!token) return fail(401, '缺少 token 查询参数')
    if (!DEPT_RE.test(dept)) return fail(400, `部门标识非法：${dept}`)
    try {
      const verified = ctx.authn.verify(token)
      exchange.principal = { kind: verified.principal.type, principalId: verified.principal.id, name: verified.principal.name, permissions: verified.scopes, actChain: verified.actChain }
      if (!requirePermission(exchange, 'panel.read')) return
    } catch (error) {
      return fail(401, `令牌无效：${error instanceof Error ? error.message : String(error)}`)
    }
    const res = exchange.res
    if (res.headersSent) return
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write('retry: 5000\n\n')
    // 事件名进 data（EventSource.onmessage 只收默认事件；前端按 payload.name 分发）
    const unsubscribe = panel.subscribeStream(dept, (event) => {
      try {
        res.write(`data: ${JSON.stringify({ name: event.name, payload: event.payload })}\n\n`)
      } catch { /* 连接已断，cleanup 兜底 */ }
    })
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n') } catch { /* ignore */ }
    }, 25_000)
    exchange.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  // -- 行业激活审批执行器（审批通过 → 置 active + grantCapabilities + 事件） ----------------

  const offExecutor = ctx.audit.registerExecutor('industry.activation', panel.buildActivationExecutor())

  // 事件扇出（SSE 数据源）+ 桥接回执联动（ddSync 状态回写）
  panel.wireEventBus()
  const offDelivered = ctx.platformBus.on(PlatformEvents.DingtalkDelivered, (payload) => {
    const { messageId, ok, error } = (payload ?? {}) as { messageId?: string; ok?: boolean; error?: string }
    if (!messageId) return
    const message = panel.messages().get(messageId)
    if (!message || (message.ddSync !== 'pending' && message.ddSync !== 'sent')) return
    panel.messages().update(messageId, { ddSync: ok ? 'sent' : 'failed' })
    if (!ok && error) {
      ctx.audit.fire({ severity: 'warning', title: '钉钉桥接投递失败', message: `消息 ${messageId} 投递失败：${error}`, resourceType: 'panel_message', resourceId: messageId })
    }
  })

  ctx.effect(() => () => {
    offExecutor()
    offDelivered()
  })

  // -- 静态托管（/panel → 对外 /rq/panel/） ----------------------------------------

  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
  if (existsSync(publicDir)) http.serveStatic('/panel', publicDir, '/index.html')

  // -- 种子（基线骨架 + DEMO_SEED=1 演示内容） ---------------------------------------

  void seedPanel(ctx)

  // -- panel_* 工具族（共享 tools 键，dsh 下即原生 ToolRuntime） ------------------------

  const renderJson = (args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]

  ctx.tools.register({
    name: 'panel_agents_list',
    description: '列出部门面板的 Agent 阵容（名称/职责/绑定资产），用于选择协作对象',
    permission: 'panel.read',
    parameters: { type: 'object', properties: { dept: { type: 'string', description: '部门标识（rd/mfg/sales/strategy/fin），缺省列出全部部门' } } },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args) {
      const dept = (args as { dept?: string }).dept
      const configs = dept ? [panel.dept(dept)] : panel.deptConfigs().all()
      return configs.map((config) => ({ dept: config.id, label: config.label, agents: config.agents }))
    },
  })

  ctx.tools.register({
    name: 'panel_msg_send',
    description: '向部门协作频道发消息（可选 --sync-dingtalk 语义：sync_dingtalk=true 时经钉钉桥接同步到群）',
    permission: 'panel.write',
    parameters: {
      type: 'object',
      properties: {
        dept: { type: 'string', description: '部门标识' },
        channel_id: { type: 'string', description: '频道 id，缺省取部门首个频道' },
        text: { type: 'string', description: '消息文本（支持 @Agent名 唤起）' },
        sync_dingtalk: { type: 'boolean', description: '是否同步到钉钉群（需已绑定群桥）' },
      },
      required: ['dept', 'text'],
    },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args, exec) {
      const input = args as { dept: string; channel_id?: string; text: string; sync_dingtalk?: boolean }
      const channelId = input.channel_id || panel.channels().find((item) => item.dept === input.dept).at(0)?.id
      if (!channelId) throw new Error(`部门 ${input.dept} 暂无频道`)
      const message = await panel.sendMessage({
        dept: input.dept, channelId, senderType: 'human',
        senderId: exec.principal?.userId, senderName: exec.principal?.name ?? '工具调用',
        text: input.text, ddSync: input.sync_dingtalk === true,
      })
      return { messageId: message.id, ddSync: message.ddSync }
    },
  })

  ctx.tools.register({
    name: 'panel_task_create',
    description: '在部门任务看板创建任务卡（泳道 todo/doing/review/done，缺省 todo）',
    permission: 'panel.task.write',
    parameters: {
      type: 'object',
      properties: {
        dept: { type: 'string', description: '部门标识' },
        title: { type: 'string', description: '任务标题' },
        detail: { type: 'string', description: '任务详情' },
        lane: { type: 'string', enum: ['todo', 'doing', 'review', 'done'], description: '目标泳道' },
        scene_code: { type: 'string', description: '关联场景图谱编号（如 QB01-A-2-5）' },
      },
      required: ['dept', 'title'],
    },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args, exec) {
      const input = args as { dept: string; title: string; detail?: string; lane?: TaskLane; scene_code?: string }
      const task = panel.createTask({
        dept: input.dept, title: input.title, ...(input.detail ? { detail: input.detail } : {}),
        ...(input.lane ? { lane: input.lane } : {}), ...(input.scene_code ? { sceneCode: input.scene_code } : {}),
        createdBy: exec.principal?.userId ?? exec.principal?.principalId ?? 'tool',
      })
      return { taskId: task.id, lane: task.lane }
    },
  })

  ctx.tools.register({
    name: 'panel_task_transition',
    description: '迁移部门任务到指定泳道（todo/doing/review/done）',
    permission: 'panel.task.write',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string', description: '任务 id' }, lane: { type: 'string', enum: ['todo', 'doing', 'review', 'done'], description: '目标泳道' } },
      required: ['task_id', 'lane'],
    },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args, exec) {
      const input = args as { task_id: string; lane: TaskLane }
      const task = panel.transitionTask(input.task_id, input.lane, exec.principal?.userId ?? 'tool')
      return { taskId: task.id, lane: task.lane }
    },
  })

  ctx.tools.register({
    name: 'panel_scene_diag',
    description: '对行业场景图谱中的场景发起数字化诊断（生成诊断任务并进入协作会话）',
    permission: 'panel.write',
    parameters: {
      type: 'object',
      properties: { dept: { type: 'string', description: '部门标识' }, scene_code: { type: 'string', description: '场景编号（如 QB01-A-2-5）' } },
      required: ['dept', 'scene_code'],
    },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args, exec) {
      const input = args as { dept: string; scene_code: string }
      const result = await panel.diagnose({
        dept: input.dept, sceneCode: input.scene_code,
        actorId: exec.principal?.userId ?? 'tool', actorName: exec.principal?.name ?? '工具调用',
      })
      return { messageId: result.message.id, taskId: result.task.id }
    },
  })

  ctx.tools.register({
    name: 'panel_widget_data',
    description: '读取部门看板 widget 数据（含来源徽标与降级标记）',
    permission: 'panel.read',
    parameters: {
      type: 'object',
      properties: { dept: { type: 'string', description: '部门标识' }, widget_id: { type: 'string', description: 'widget id，缺省返回全部' } },
      required: ['dept'],
    },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args) {
      const input = args as { dept: string; widget_id?: string }
      const dept = panel.dept(input.dept)
      const widgets = panel.board(dept)
      return input.widget_id ? widgets.filter((widget) => widget.id === input.widget_id) : widgets
    },
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    panel: PanelService
  }
}
