/**
 * @01men/plugin-dingtalk-bridge —— REST 面 + 事件装配（review-dsh-agent-panel-v2 Phase 3）。
 *
 * 全部 REST 走 guarded（权限点：dingtalk.message.send / panel.read），自注册路由推入
 * httpServer.routeMatrix 共享登记处（RBAC 断言网覆盖义务与 panel-core 一致）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HttpExchange } from '../../platform-core/src/index.ts'
import { newId } from '../../platform-core/src/ids.ts'
import { DingtalkBridgeService } from './service.ts'

export const name = 'dingtalk-bridge'
// panel 为 panel-core 注册的服务（加载序保证先于本插件）；dingtalkBridge 自供服务不可自 inject
export const inject = ['httpServer', 'opsStorage', 'platformBus', 'iam', 'audit', 'panel']

interface CallerInfo {
  kind: 'human' | 'machine'
  principalId: string
  userId?: string
  name: string
  permissions: string[]
}

export function apply(ctx: Context) {
  const http = ctx.httpServer
  const bridge = new DingtalkBridgeService(ctx)

  const caller = (exchange: HttpExchange): CallerInfo => exchange.principal as CallerInfo

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
    // H5：声明经 http.register 自动汇入 routeMatrix 共享登记处（注册期缺声明即抛错）
    http.register(method, path, async (exchange) => {
      if (!requirePermission(exchange, permission)) return
      try {
        const result = await handler(exchange)
        if (!exchange.res.writableEnded) exchange.ok(result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        exchange.fail(400, 'BAD_REQUEST', message)
      }
    }, { access: 'guarded', permission })
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
      ...(info.actChain?.length ? { actChain: info.actChain } : {}),
    })
  }

  // -- 状态胶囊（顶栏）：连接器形态 / 个人扫码绑定 / 入向能力声明 ----------------------

  guarded('GET', '/api/dingtalk/status', 'panel.read', (exchange) => {
    const info = caller(exchange)
    const connector = bridge.connector()
    const link = info.userId
      ? ctx.iam.identityLinks().find((item) => item.userId === info.userId && item.provider === 'dingtalk').at(-1)
      : undefined
    return {
      connector: connector
        ? { configured: true, mode: connector.mode, corpId: connector.corpId, name: connector.name, enabled: connector.enabled }
        : { configured: false },
      bound: link ? { displayName: link.displayName, corpId: link.corpId, linkedAt: link.linkedAt } : null,
      // D2 裁决：身份绑定事实源 = iam 扫码绑定（identityLinks）；官方连接器 owner-binding 仅留 DSH owner 语义
      bindPath: '/api/auth/sso/bind/authorize（钉钉扫码 → iam identityLinks）',
      // R-SPIKE 未决：入向 Stream 在官方连接器暴露面核对前停用（同 clientId 全企业仅一条 Stream 连接）
      inbound: { enabled: false, reason: 'R-SPIKE：官方 dsh-dingtalk 连接器入向暴露面核对前停用（出向投递已可用）' },
      dws: { enabled: false, reason: 'DWS 数字员工为可选增强，后续迭代' },
      bridges: bridge.bridgeChannels().count(),
    }
  })

  // -- 群桥绑定 -----------------------------------------------------------------

  guarded('GET', '/api/dingtalk/bridges', 'panel.read', (exchange) => {
    const dept = exchange.query.get('dept') ?? ''
    return {
      bridges: bridge.bridgeChannels().find((item) => (dept ? item.dept === dept : true)),
    }
  })

  guarded('POST', '/api/dingtalk/channels/:id/bridge', 'dingtalk.message.send', (exchange) => {
    const input = body<{ chatId?: string; robotCode?: string; purpose?: string }>(exchange)
    if (!input.chatId?.trim() || !input.robotCode?.trim()) throw new Error('chatId（openConversationId）与 robotCode 必填')
    const purpose = input.purpose === 'alerts' ? 'alerts' as const : 'channel' as const
    const channel = ctx.panel.channels().get(String(exchange.params.id))
    if (purpose === 'channel' && !channel) throw new Error(`面板频道不存在：${exchange.params.id}`)
    const info = caller(exchange)
    const existing = bridge.bridgeChannels().findOne((item) => item.channelId === String(exchange.params.id))
    if (existing) {
      bridge.bridgeChannels().update(existing.id, {
        chatId: input.chatId.trim(), robotCode: input.robotCode.trim(), purpose, boundBy: info.userId ?? info.principalId, boundAt: new Date().toISOString(),
      })
    } else {
      bridge.bridgeChannels().insert({
        id: newId('ddbr'), channelId: String(exchange.params.id),
        dept: channel?.dept ?? (purpose === 'alerts' ? 'platform' : ''),
        chatId: input.chatId.trim(), robotCode: input.robotCode.trim(), purpose,
        boundBy: info.userId ?? info.principalId, boundAt: new Date().toISOString(),
      })
    }
    changeLog(exchange, 'dingtalk.bridge.bind', 'panel_channel', String(exchange.params.id), channel?.name ?? 'alerts', `purpose=${purpose}`)
    return { bridge: bridge.bridgeChannels().findOne((item) => item.channelId === String(exchange.params.id)) }
  })

  guarded('DELETE', '/api/dingtalk/channels/:id/bridge', 'dingtalk.message.send', (exchange) => {
    const existing = bridge.bridgeChannels().findOne((item) => item.channelId === String(exchange.params.id))
    if (!existing) throw new Error(`该频道未绑定群桥：${exchange.params.id}`)
    bridge.bridgeChannels().remove(existing.id)
    changeLog(exchange, 'dingtalk.bridge.unbind', 'panel_channel', String(exchange.params.id), '', existing.purpose)
    return { deleted: true }
  })

  // -- 审批推送（审批中心/卡片动作 → 钉钉卡片文本） ----------------------------------

  guarded('POST', '/api/dingtalk/approvals/:id/push', 'dingtalk.message.send', async (exchange) => {
    const approval = ctx.audit.approvals().get(String(exchange.params.id))
    if (!approval) throw new Error(`审批单不存在：${exchange.params.id}`)
    const dept = typeof approval.payload.dept === 'string' ? approval.payload.dept : ''
    const info = caller(exchange)
    const result = await bridge.deliver({
      messageId: `approval:${approval.id}`,
      ...(dept ? { dept } : {}),
      title: `🔔 审批推送：${approval.title}`,
      text: [
        `单号：${approval.id}`,
        `发起人：${approval.requesterName}`,
        `风险级：${approval.riskLevel ?? 'low'}${approval.riskLevel === 'high' ? '（需二次确认）' : ''}`,
        `内容：${JSON.stringify(approval.payload)}`,
      ].join('\n'),
    })
    if (!result.delivered && result.error) throw new Error(`推送未完成：${result.error}`)
    changeLog(exchange, 'dingtalk.approval.push', 'approval', approval.id, approval.title, result.delivered ? '已投递' : '未绑定群桥')
    return result
  })

  // -- 回决写回（入向适配器契约；staffId 反查 fail-closed） -----------------------------
  // 入向 Stream 停用期间，本端点仅对持有 dingtalk.message.send 的机器凭证（未来适配器）开放：
  // 身份必须能反查 identityLinks，审批权限必须在平台侧复核，high 风险必须显式 confirmed。

  guarded('POST', '/api/dingtalk/bridge/callback', 'dingtalk.message.send', async (exchange) => {
    const input = body<{ staffId?: string; approvalId?: string; decision?: string; opinion?: string; confirmed?: boolean }>(exchange)
    if (!input.staffId || !input.approvalId || !['approve', 'reject'].includes(input.decision ?? '')) {
      throw new Error('staffId/approvalId/decision(approve|reject) 必填')
    }
    const link = ctx.iam.findLinkByProfile('dingtalk', input.staffId)
    if (!link) throw new Error('staffId 未绑定任何平台账号（fail-closed：拒绝匿名回决）')
    const user = ctx.iam.users().get(link.userId)
    if (!user || user.status !== 'active') throw new Error('绑定账号不存在或已停用（fail-closed）')
    const permissions = user.roleIds.flatMap((roleId) => ctx.iam.roles().get(roleId)?.permissions ?? [])
    if (!permissions.includes('*') && !permissions.includes('approval.decide')) {
      throw new Error('绑定账号无审批决策权限（fail-closed）')
    }
    const approval = ctx.audit.approvals().get(input.approvalId)
    if (!approval) throw new Error(`审批单不存在：${input.approvalId}`)
    if (approval.riskLevel === 'high' && input.decision === 'approve' && input.confirmed !== true) {
      throw new Error('高风险审批的钉钉回决必须携带 confirmed=true（服务端强制二次确认）')
    }
    const record = await ctx.audit.decideApproval(approval.id, input.decision as 'approve' | 'reject', user.id, user.displayName, input.opinion ?? '（钉钉侧回决）', { confirmed: input.confirmed === true })
    changeLog(exchange, 'dingtalk.approval.callback', 'approval', approval.id, approval.title, `${input.decision} by ${user.displayName}`)
    return { approval: { id: record.id, status: record.status } }
  })

  // -- 事件装配 ----------------------------------------------------------------

  bridge.wireEventBus()
  ctx.effect(() => () => undefined)
}
