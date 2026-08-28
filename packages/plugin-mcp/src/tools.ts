/**
 * mcp 插件对模型暴露的工具。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolPrincipal } from '../../platform-core/src/index.ts'

export const name = 'mcp-tools'
export const inject = ['tools', 'mcpRegistry', 'authn']

export function apply(ctx: Context) {
  const t = ctx.tools

  /** 调用方身份取自执行上下文（入口从令牌解析），缺失即 fail-closed；schema 不声明 caller* 参数。 */
  const callerFromPrincipal = (principal?: ToolPrincipal): { type: 'user' | 'agent' | 'app'; id: string; name: string } => {
    if (!principal) throw new Error('工具执行缺少身份上下文（fail-closed）')
    if (principal.kind === 'human') return { type: 'user', id: principal.userId ?? principal.principalId, name: principal.name }
    const record = ctx.authn.principals().get(principal.principalId)
    if (record?.refType === 'agent' && record.refId) return { type: 'agent', id: record.refId, name: principal.name }
    if (record?.refType === 'app' && record.refId) return { type: 'app', id: record.refId, name: principal.name }
    return { type: 'app', id: principal.principalId, name: principal.name }
  }

  t.register(defineTool({
    name: 'mcp_service_list',
    description: '列出 MCP 服务（含健康状态、版本、灰度比例）。',
    parameters: {
      status: { type: 'string', enum: ['draft', 'verifying', 'online', 'gray', 'unhealthy', 'offline'], description: '状态过滤' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const services = ctx.mcpRegistry.services().find((item) => (args.status ? item.status === args.status : true))
      return {
        total: services.length,
        services: services.map((item) => ({
          id: item.id, name: item.name, slug: item.slug, status: item.status,
          version: item.currentVersion, grayPercent: item.grayPercent,
          health: item.health.status, tools: item.tools.map((tool) => tool.name),
        })),
      }
    },
  }))

  t.register(defineTool({
    name: 'mcp_deploy',
    description: '部署/更新 MCP 服务（L3：支持灰度比例；dryRun 返回影响面预览）。',
    parameters: {
      serviceId: { type: 'string', required: true, description: '服务 ID' },
      grayPercent: { type: 'number', description: '灰度比例 0-100，缺省 100（全量）' },
      changelog: { type: 'string', description: '变更说明' },
      dryRun: { type: 'boolean', description: 'true 时仅返回影响面预览，不执行' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const service = ctx.mcpRegistry.services().get(args.serviceId)
      if (!service) throw new Error(`MCP 服务不存在：${args.serviceId}`)
      const impact = ctx.resourceCore.impact('mcp_service', args.serviceId)
      if (args.dryRun) {
        return { dryRun: true, service: service.name, dependents: impact, note: 'dry-run 未执行任何变更' }
      }
      const updated = await ctx.mcpRegistry.deployService(args.serviceId, {
        grayPercent: args.grayPercent,
        changelog: args.changelog,
        actor: 'agent-tool',
      })
      return { id: updated.id, status: updated.status, version: updated.currentVersion, grayPercent: updated.grayPercent }
    },
  }))

  t.register(defineTool({
    name: 'mcp_offline',
    description: '下线 MCP 服务（L4 高危：创建审批单，审批通过后自动执行）。必须给出 reason。',
    permission: 'mcp.service.offline',
    parameters: {
      serviceId: { type: 'string', required: true, description: '服务 ID' },
      reason: { type: 'string', required: true, description: '下线原因' },
      requesterId: { type: 'string', required: true, description: '发起人用户 ID' },
      requesterName: { type: 'string', required: true, description: '发起人姓名' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const impact = ctx.resourceCore.impact('mcp_service', args.serviceId)
      const approval = ctx.mcpRegistry.requestOfflineApproval(args.serviceId, { id: args.requesterId, name: args.requesterName }, args.reason, impact.map((item) => `${item.name}（${item.type}）`))
      return {
        approvalId: approval.id, status: approval.status,
        impact: impact,
        note: '已生成 L4 审批单，审批通过后自动执行下线并吊销相关令牌',
      }
    },
  }))

  t.register(defineTool({
    name: 'mcp_metrics',
    description: '查看 MCP 服务运营监控：调用量、成功率、P95 延迟、Token 消耗、按调用方/工具统计。',
    parameters: {
      serviceId: { type: 'string', required: true, description: '服务 ID' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const metrics = ctx.mcpRegistry.serviceMetrics(args.serviceId)
      const service = ctx.mcpRegistry.services().get(args.serviceId)
      return { service: service?.name, ...metrics, series: metrics.series.slice(-30) }
    },
  }))

  t.register(defineTool({
    name: 'mcp_invoke',
    description: '通过 MCP 网关调用工具（统一鉴权/限流/审计）。调用方身份由服务端从令牌解析。',
    permission: 'mcp.invoke',
    parameters: {
      serviceId: { type: 'string', required: true, description: '服务 ID' },
      tool: { type: 'string', required: true, description: '工具名' },
      args: { type: 'object', description: '工具参数' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args, exec) {
      return await ctx.mcpRegistry.invoke(callerFromPrincipal(exec.principal), args.serviceId, args.tool, args.args ?? {})
    },
  }))

  t.register(defineTool({
    name: 'mcp_health_check',
    description: '对 MCP 服务执行一次健康探测（熔断状态下可用于恢复确认）。',
    parameters: {
      serviceId: { type: 'string', required: true, description: '服务 ID' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return await ctx.mcpRegistry.healthCheck(args.serviceId)
    },
  }))
}
