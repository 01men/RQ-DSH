/**
 * agent 插件对模型暴露的工具。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../platform-core/src/index.ts'

export const name = 'agent-tools'
export const inject = ['tools', 'agentRegistry', 'resourceCore']

export function apply(ctx: Context) {
  const t = ctx.tools

  t.register(defineTool({
    name: 'agent_list',
    description: '列出 Agent 本体（支持状态/组织/关键字过滤，含健康与调用量）。',
    parameters: {
      status: { type: 'string', enum: ['draft', 'trial', 'online', 'offline', 'archived'], description: '状态' },
      q: { type: 'string', description: '名称/标识关键字' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const agents = ctx.resourceCore.list('agent', args)
      return {
        total: agents.length,
        agents: agents.map((agent) => {
          const metrics = ctx.agentRegistry.metrics(agent.id)
          return {
            id: agent.id, name: agent.name, slug: agent.slug, status: agent.status,
            model: agent.attrs['model'], owner: agent.attrs['ownerName'],
            calls: metrics.calls, successRate: metrics.successRate, tokens: metrics.tokens,
          }
        }),
      }
    },
  }))

  t.register(defineTool({
    name: 'agent_get',
    description: '查看 Agent 详情（属性、生命周期历史、绑定用户、监测指标、可用操作）。',
    parameters: {
      agentId: { type: 'string', required: true, description: 'Agent ID' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const agent = ctx.resourceCore.get('agent', args.agentId)
      if (!agent) throw new Error(`Agent 不存在：${args.agentId}`)
      return {
        ...agent,
        metrics: ctx.agentRegistry.metrics(agent.id),
        boundUsers: ctx.agentRegistry.boundUsers(agent.id).map((item) => item.userName),
        availableTransitions: ctx.resourceCore.availableTransitions('agent', agent.id),
      }
    },
  }))

  t.register(defineTool({
    name: 'agent_offline',
    description: '下线 Agent（L4 高危：生成审批单，审批通过后自动执行；联动吊销机器凭证并通知绑定用户）。必须给出 reason。',
    permission: 'agent.offline',
    parameters: {
      agentId: { type: 'string', required: true, description: 'Agent ID' },
      reason: { type: 'string', required: true, description: '下线原因' },
      requesterId: { type: 'string', required: true, description: '发起人用户 ID' },
      requesterName: { type: 'string', required: true, description: '发起人姓名' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const approval = ctx.agentRegistry.requestOffline(args.agentId, { id: args.requesterId, name: args.requesterName }, args.reason)
      const impact = ctx.resourceCore.impact('agent', args.agentId)
      return {
        approvalId: approval.id, status: approval.status, impact,
        note: '审批通过后将：下线 Agent → 吊销机器凭证 → 通知绑定用户 → 保留审计数据',
      }
    },
  }))

  t.register(defineTool({
    name: 'agent_metrics',
    description: '查看 Agent 运行监测：会话量、调用量、成功率、Token 消耗与成本、平均响应时长（近 14 天序列）。',
    parameters: {
      agentId: { type: 'string', required: true, description: 'Agent ID' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return ctx.agentRegistry.metrics(args.agentId)
    },
  }))

  t.register(defineTool({
    name: 'agent_metrics_report',
    description: '上报 Agent 运营指标（日活 DAU/对话会话数/对话用户去重统计，可指定 date 补录历史）。Agent 接入后的强制义务：每日定时向平台提报，与 AI 应用 metrics-report 同级；调用/成功率/Token 由平台网关自动归集，无须重复上报。',
    permission: 'agent.write',
    parameters: {
      agentId: { type: 'string', required: true, description: 'Agent ID' },
      dau: { type: 'integer', description: '日活跃用户数（同日多次上报取最大值）' },
      sessions: { type: 'integer', description: '对话会话数（同日多次上报累加）' },
      uniqueUsers: { type: 'integer', description: '对话去重用户数（无法提供 ID 明细时只报数量；ID 明细走 REST userIds 字段）' },
      date: { type: 'string', description: '指标日期 YYYY-MM-DD（默认今天；补录历史时指定）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const agentId = String(args.agentId)
      ctx.agentRegistry.reportUsage(agentId, {
        ...(args.dau !== undefined ? { dau: Number(args.dau) } : {}),
        ...(args.sessions !== undefined ? { sessions: Number(args.sessions) } : {}),
        ...(args.uniqueUsers !== undefined ? { uniqueUsers: Number(args.uniqueUsers) } : {}),
        ...(args.date !== undefined && args.date !== '' ? { date: String(args.date) } : {}),
      })
      return { reported: true, metrics: ctx.agentRegistry.metrics(agentId) }
    },
  }))

  t.register(defineTool({
    name: 'agent_bind_user',
    description: '为 Agent 绑定用户（记录"哪些用户可使用该 Agent"，使用即授权留痕）。',
    permission: 'agent.write',
    parameters: {
      agentId: { type: 'string', required: true, description: 'Agent ID' },
      userId: { type: 'string', required: true, description: '用户 ID' },
      actor: { type: 'string', description: '操作人' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const binding = ctx.agentRegistry.bindUser(args.agentId, args.userId, args.actor ?? 'agent-tool')
      return { agentId: binding.agentId, userId: binding.userId, boundAt: binding.boundAt }
    },
  }))
}
