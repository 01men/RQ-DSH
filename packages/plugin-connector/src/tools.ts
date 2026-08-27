/**
 * connector 插件对模型/CLI/工具桥暴露的工具（defineTool → ctx.tools 三端自动同契约）。
 * 权限点与 REST 对齐；connector_execute 的调用方身份由 console injectToolIdentity 注入，
 * 防止 Agent 自填身份绕过授权链（对齐 mcp_invoke 先例）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../platform-core/src/index.ts'

export const name = 'connector-tools'
export const inject = ['tools', 'connectorHub']

export function apply(ctx: Context) {
  const t = ctx.tools

  t.register(defineTool({
    name: 'connector_catalog_search',
    description: '搜索连接器目录：providers 与 actions（含 riskLevel/requiredScopes/inputSchema）。',
    permission: 'connector.catalog.read',
    parameters: {
      keyword: { type: 'string', description: '按 provider/action 关键词过滤' },
      service: { type: 'string', description: '限定 provider（service id）' },
      kind: { type: 'string', enum: ['providers', 'actions'], description: '缺省两者都返回' },
      limit: { type: 'number', description: '返回条数上限，默认 50' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const catalog = await ctx.connectorHub.catalog()
      if (!catalog) return { error: '目录尚未同步：请先执行 connector gateway health + 目录同步' }
      const keyword = (args.keyword ?? '').toLowerCase()
      const limit = Math.min(Number(args.limit ?? 50), 200)
      const matchAction = (action: { id: string; service: string; description?: string }): boolean =>
        (!args.service || action.service === args.service)
        && (!keyword || `${action.id} ${action.service} ${action.description ?? ''}`.toLowerCase().includes(keyword))
      const providers = args.kind === 'actions' ? [] : catalog.providers
        .filter((provider) => String(provider['service'] ?? '').length > 0
          && (!args.service || String(provider['service']) === args.service)
          && (!keyword || JSON.stringify(provider).toLowerCase().includes(keyword)))
        .slice(0, limit)
      const actions = args.kind === 'providers' ? [] : catalog.actions.filter(matchAction).slice(0, limit)
      return { totalProviders: providers.length, totalActions: actions.length, skippedServices: catalog.skippedServices, providers, actions }
    },
  }))

  t.register(defineTool({
    name: 'connector_connection_list',
    description: '列出连接器连接引用（org 内；含脱敏 profile——平台永不回显凭证原文）。',
    permission: 'connector.connection.read',
    parameters: {
      orgId: { type: 'string', description: '组织 ID（跨 org 用户仅能看自身授权范围，由服务端过滤）' },
      provider: { type: 'string', description: '按 provider 过滤' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const refs = ctx.connectorHub.connections().find((item) =>
        (!args.orgId || item.ownerOrgId === args.orgId) && (!args.provider || item.provider === args.provider))
      return {
        total: refs.length,
        connections: refs.map((item) => ({
          id: item.id, alias: item.alias, provider: item.provider, authType: item.authType,
          status: item.status, ownerOrgId: item.ownerOrgId, bridge: item.bridge,
          ocConnectionId: item.ocConnectionId,
          ...(item.maskedProfile ? { maskedProfile: item.maskedProfile } : {}),
          updatedAt: item.updatedAt,
        })),
      }
    },
  }))

  t.register(defineTool({
    name: 'connector_execute',
    description: '通过连接器网关调用 SaaS action：七步链（RBAC→权限组→审批→限流→计费预检→oct_ 令牌）。admin 级 action 会返回审批单。',
    permission: 'connector.invoke',
    parameters: {
      actionId: { type: 'string', required: true, description: 'action ID（如 hackernews.get_top_stories）' },
      input: { type: 'object', description: 'action 入参' },
      connection: { type: 'string', description: '指定命名连接别名（org:<orgId>:<name>）' },
      dryRun: { type: 'boolean', description: 'true 时只做授权链预演不真实调用' },
      callerType: { type: 'string', enum: ['user', 'agent', 'app'], description: '调用方类型（服务端注入，Agent 勿自填）' },
      callerId: { type: 'string', description: '调用方 ID（服务端注入）' },
      callerName: { type: 'string', description: '调用方名称（服务端注入）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return await ctx.connectorHub.invokeAction({
        type: args.callerType ?? 'user',
        id: args.callerId ?? 'tool-bridge',
        name: args.callerName ?? 'tool-bridge',
      }, {
        actionId: args.actionId,
        input: args.input ?? {},
        ...(args.connection ? { alias: args.connection } : {}),
        ...(args.dryRun ? { dryRun: true } : {}),
      })
    },
  }))

  t.register(defineTool({
    name: 'connector_perm_group_list',
    description: '列出连接器权限组（policies/subjects/rateLimitPerMin/precheckCents 与令牌台账状态）。',
    permission: 'connector.connection.read',
    parameters: {
      orgId: { type: 'string', description: '按组织过滤' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const groups = ctx.connectorHub.permGroups().find((group) => (!args.orgId || group.orgId === args.orgId))
      return {
        total: groups.length,
        groups: groups.map((group) => ({
          id: group.id, name: group.name, orgId: group.orgId, description: group.description,
          policies: Object.fromEntries(Object.entries(group.policies).map(([service, policy]) => [
            service,
            {
              allowedActions: policy.allowedActions, riskCap: policy.riskCap,
              connections: policy.connections ?? [],
              readOnly: Boolean(policy.constraints?.readOnly),
              denyParams: policy.constraints?.denyParams ?? [],
            },
          ])),
          subjects: group.subjects, rateLimitPerMin: group.rateLimitPerMin, precheckCents: group.precheckCents,
        })),
      }
    },
  }))

  t.register(defineTool({
    name: 'connector_run_list',
    description: '查看连接器网关 run 日志（runs 对账视图：runtimeTokenId 维度，只读）。',
    permission: 'connector.runs.read',
    parameters: {
      service: { type: 'string', description: '按 provider 过滤' },
      ok: { type: 'boolean', description: '按成败过滤' },
      limit: { type: 'number', description: '条数上限默认 100' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return await ctx.connectorHub.listRunsView({
        ...(args.service ? { service: args.service } : {}),
        ...(typeof args.ok === 'boolean' ? { ok: args.ok } : {}),
        limit: Number(args.limit ?? 100),
      })
    },
  }))
}
