/**
 * iam 插件对模型暴露的工具（dsh-ops-iam Skill 的底座）。
 * 注册到 ctx.tools：在完整 dsh 中模型可直接调用；独立宿主中经 /api/tools/execute 触达。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../platform-core/src/index.ts'

export const name = 'iam-tools'
export const inject = ['tools', 'iam']

export function apply(ctx: Context) {
  const t = ctx.tools

  t.register(defineTool({
    name: 'iam_org_tree',
    description: '获取组织架构树（含各级子组织与人数统计）。',
    parameters: {},
    output: { type: 'object', additionalProperties: true },
    async execute() {
      const tree = ctx.iam.orgTree()
      const decorate = (nodes: any[]): any[] => nodes.map((node) => ({
        id: node.id, name: node.name, status: node.status,
        userCount: ctx.iam.users().find((user) => user.orgId === node.id).length,
        children: decorate(node.children),
      }))
      return { tree: decorate(tree) }
    },
  }))

  t.register(defineTool({
    name: 'iam_org_create',
    description: '创建组织（需 iam.org.write 权限）。parentId 为空表示顶级组织。',
    parameters: {
      name: { type: 'string', required: true, description: '组织名称' },
      parentId: { type: 'string', description: '父组织 ID' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const org = ctx.iam.createOrg({ name: args.name, parentId: args.parentId ?? null })
      return { id: org.id, name: org.name }
    },
  }))

  t.register(defineTool({
    name: 'iam_org_update',
    description: '修改组织：重命名和/或调整上级组织（需 iam.org.write 权限）。name 与 parentId 至少提供一个；parentId 传空字符串表示提升为顶级组织。',
    permission: 'iam.org.write',
    parameters: {
      orgId: { type: 'string', required: true, description: '组织 ID' },
      name: { type: 'string', description: '新组织名称' },
      parentId: { type: 'string', description: '新父组织 ID（传空字符串表示提升为顶级组织）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      if (args.name === undefined && args.parentId === undefined) throw new Error('name 与 parentId 至少提供一个')
      if (args.name !== undefined) ctx.iam.renameOrg(args.orgId, args.name)
      if (args.parentId !== undefined) ctx.iam.moveOrg(args.orgId, args.parentId || null)
      const org = ctx.iam.orgs().get(args.orgId)
      return { id: org.id, name: org.name, parentId: org.parentId }
    },
  }))

  t.register(defineTool({
    name: 'iam_user_list',
    description: '查询账号列表，可按组织/状态/关键字过滤。',
    parameters: {
      orgId: { type: 'string', description: '限定组织（含子树）' },
      status: { type: 'string', enum: ['pending', 'active', 'frozen', 'deactivated'], description: '状态过滤' },
      q: { type: 'string', description: '姓名/用户名关键字' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const users = ctx.iam.users().find((user) => {
        if (args.status && user.status !== args.status) return false
        if (args.q && !`${user.displayName}${user.username}`.includes(args.q)) return false
        if (args.orgId) {
          const scope = new Set(ctx.iam.orgSubtreeIds(args.orgId))
          if (!scope.has(user.orgId)) return false
        }
        return true
      })
      return {
        total: users.length,
        users: users.map((user) => ({
          id: user.id, username: user.username, displayName: user.displayName,
          org: ctx.iam.orgs().get(user.orgId)?.name, title: user.title, status: user.status,
        })),
      }
    },
  }))

  t.register(defineTool({
    name: 'iam_user_create',
    description: '创建账号。未提供 password 时生成随机初始口令，仅在返回值 initialPassword 中出现一次，请安全传达给本人。',
    permission: 'iam.user.write',
    parameters: {
      username: { type: 'string', required: true, description: '登录名（字母数字）' },
      displayName: { type: 'string', required: true, description: '姓名' },
      orgId: { type: 'string', required: true, description: '所属组织 ID' },
      title: { type: 'string', description: '职位' },
      roleIds: { type: 'array', items: { type: 'string' }, description: '角色 ID 列表' },
      password: { type: 'string', description: '初始口令（缺省则随机生成，仅返回一次）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const { user, initialPassword } = ctx.iam.createUser({ ...args, roleIds: args.roleIds })
      return { id: user.id, username: user.username, status: user.status, ...(initialPassword ? { initialPassword } : {}) }
    },
  }))

  t.register(defineTool({
    name: 'iam_user_reset_password',
    description: '重置账号为随机初始口令（仅返回一次；请第一时间传达给本人）。',
    permission: 'iam.user.write',
    parameters: {
      userId: { type: 'string', required: true, description: '账号 ID' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const { user, initialPassword } = ctx.iam.resetPassword(args.userId)
      return { id: user.id, username: user.username, initialPassword }
    },
  }))

  t.register(defineTool({
    name: 'iam_user_freeze',
    description: '冻结账号（L4 高危：必须填写 reason，将联动吊销名下全部令牌）。',
    permission: 'iam.user.freeze',
    parameters: {
      userId: { type: 'string', required: true, description: '账号 ID' },
      reason: { type: 'string', required: true, description: '冻结原因（审计留痕）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const user = ctx.iam.freezeUser(args.userId, args.reason)
      return { id: user.id, status: user.status, note: '已发布 iam.user.frozen 事件，认证中心将吊销其令牌' }
    },
  }))

  t.register(defineTool({
    name: 'iam_role_list',
    description: '列出全部角色与权限点。',
    parameters: {},
    output: { type: 'object', additionalProperties: true },
    async execute() {
      return {
        roles: ctx.iam.roles().all().map((role) => ({ id: role.id, code: role.code, name: role.name, builtin: role.builtin, permissions: role.permissions })),
      }
    },
  }))

  t.register(defineTool({
    name: 'iam_sync_run',
    description: '触发三方通讯录全量同步（支持多主体：同一平台可接入多家企业，传 configId 指定主体实例，缺省按 provider 取第一条）。',
    permission: 'iam.connector.write',
    parameters: {
      provider: { type: 'string', enum: ['dingtalk'], description: '连接器（与 configId 至少提供一个；缺省按 provider 取第一条配置）' },
      configId: { type: 'string', description: '接入配置实例 ID（多主体时指定，优先于 provider）' },
      actor: { type: 'string', description: '操作人（审计用）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const target = args.configId ?? args.provider
      if (!target) throw new Error('provider 与 configId 至少提供一个')
      return await ctx.iam.syncConnector(target, args.actor ?? 'agent')
    },
  }))

  t.register(defineTool({
    name: 'iam_conflict_list',
    description: '查看三方同步冲突队列（pending 未处理）。',
    parameters: {
      status: { type: 'string', enum: ['pending', 'resolved'], description: '默认 pending' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const conflicts = ctx.iam.conflicts().find((item) => item.status === (args.status ?? 'pending'))
      return { total: conflicts.length, conflicts }
    },
  }))
}
