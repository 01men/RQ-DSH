/**
 * audit 插件对模型暴露的工具。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@dsh-ops/platform-core'

export const name = 'audit-tools'
export const inject = ['tools', 'audit']

export function apply(ctx: Context) {
  const t = ctx.tools

  t.register(defineTool({
    name: 'audit_logs',
    description: '查询审计日志（认证/授权/调用/变更四类），支持按资源、操作人、时间回溯。',
    parameters: {
      type: { type: 'string', enum: ['auth', 'authz', 'invoke', 'change'], description: '日志类型' },
      resourceId: { type: 'string', description: '资源 ID 精确过滤' },
      since: { type: 'string', description: '起始时间 ISO 串' },
      limit: { type: 'number', description: '返回条数，默认 50' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return ctx.audit.query({ ...args, limit: args.limit ?? 50 })
    },
  }))

  t.register(defineTool({
    name: 'audit_alerts_list',
    description: '查看平台告警（含未读临界/警告），用于异常排查入口。',
    parameters: {
      unreadOnly: { type: 'boolean', description: '仅未读' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const alerts = ctx.audit.alerts().find((alert) => (args.unreadOnly ? !alert.read : true))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return { total: alerts.length, alerts: alerts.slice(0, 50) }
    },
  }))

  t.register(defineTool({
    name: 'approval_decide',
    description: '审批中心决策（approve/reject）。发起人与审批人不得为同一人。',
    permission: 'approval.decide',
    parameters: {
      approvalId: { type: 'string', required: true, description: '审批单 ID' },
      decision: { type: 'string', enum: ['approve', 'reject'], required: true },
      approverId: { type: 'string', required: true, description: '审批人用户 ID' },
      approverName: { type: 'string', required: true, description: '审批人姓名' },
      opinion: { type: 'string', description: '审批意见' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const record = await ctx.audit.decideApproval(args.approvalId, args.decision, args.approverId, args.approverName, args.opinion)
      return { id: record.id, status: record.status, execution: record.execution }
    },
  }))

  t.register(defineTool({
    name: 'audit_cost_report',
    description: '成本穿透分析：按应用/Agent/组织/日期聚合 Token 消耗与成本。',
    parameters: {
      groupBy: { type: 'string', enum: ['app', 'agent', 'org', 'date'], required: true, description: '聚合维度' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD' },
      to: { type: 'string', description: '截止日期 YYYY-MM-DD' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return { groupBy: args.groupBy, rows: ctx.audit.costReport(args.groupBy, args.from, args.to) }
    },
  }))
}
