/**
 * nas 插件对模型暴露的工具（dsh ToolRuntime / REST 工具桥 / MCP /mcp 端点同一契约）。
 * 读类操作需 nas.read；写类操作需 nas.write（工具级权限点在网关统一校验）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../platform-core/src/index.ts'

export const name = 'nas-tools'
export const inject = ['tools', 'nasRegistry']

export function apply(ctx: Context) {
  const t = ctx.tools

  t.register(defineTool({
    name: 'nas_list',
    description: '列出纳管的 NAS（FS 文件存储）资产（含健康状态与生命周期）。',
    permission: 'nas.read',
    parameters: {
      status: { type: 'string', enum: ['draft', 'online', 'offline', 'archived'], description: '按状态过滤' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const items = ctx.nasRegistry.list(args.status ? { status: String(args.status) } : undefined)
      return {
        total: items.length,
        items: items.map((nas) => ({
          id: nas.id, name: nas.name, slug: nas.slug, status: nas.status,
          gateway: nas.attrs['gatewayUrl'], nasIp: nas.attrs['nasIp'], rootPath: nas.attrs['rootPath'],
          health: ctx.nasRegistry.healthOf(nas.id).status,
        })),
      }
    },
  }))

  t.register(defineTool({
    name: 'nas_get',
    description: '查看 NAS 资产详情（接入信息脱敏、健康、网关工具面）。',
    permission: 'nas.read',
    parameters: {
      nasId: { type: 'string', required: true, description: 'NAS 资产 ID' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const nas = ctx.nasRegistry.get(String(args.nasId))
      if (!nas) throw new Error(`NAS 资产不存在：${args.nasId}`)
      return {
        id: nas.id, name: nas.name, slug: nas.slug, status: nas.status,
        attrs: { ...nas.attrs, accessToken: mask(String(nas.attrs['accessToken'] ?? '')) },
        health: ctx.nasRegistry.healthOf(nas.id),
        gatewayTools: ctx.nasRegistry.toolsOf(nas.id).map((tool) => tool.name),
        availableTransitions: nas.status,
      }
    },
  }))

  t.register(defineTool({
    name: 'nas_health_check',
    description: '对 NAS 网关执行一次健康探测（MCP initialize 握手，返回延迟与状态）。',
    permission: 'nas.read',
    parameters: {
      nasId: { type: 'string', required: true, description: 'NAS 资产 ID' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return await ctx.nasRegistry.probe(String(args.nasId))
    },
  }))

  t.register(defineTool({
    name: 'nas_fs_list',
    description: '列出 NAS 共享目录或指定路径下的文件（fs_list / fs_list_shares）。path 省略时列出全部共享。',
    permission: 'nas.read',
    parameters: {
      nasId: { type: 'string', required: true, description: 'NAS 资产 ID' },
      path: { type: 'string', description: '绝对路径 /<共享名>/子路径；省略列出共享' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const nasId = String(args.nasId)
      const path = args.path === undefined || args.path === '' ? undefined : String(args.path)
      return path === undefined ? await ctx.nasRegistry.listShares(nasId) : await ctx.nasRegistry.listFiles(nasId, path)
    },
  }))

  t.register(defineTool({
    name: 'nas_fs_search',
    description: '在 NAS 指定路径下按关键字/通配符检索文件（fs_search）。',
    permission: 'nas.read',
    parameters: {
      nasId: { type: 'string', required: true, description: 'NAS 资产 ID' },
      pattern: { type: 'string', required: true, description: '检索关键字或通配符' },
      path: { type: 'string', description: '起始路径（默认根 /）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return await ctx.nasRegistry.search(String(args.nasId), String(args.pattern), args.path ? String(args.path) : '/')
    },
  }))

  t.register(defineTool({
    name: 'nas_fs_mkdir',
    description: '在 NAS 上创建目录（fs_create_folder），写操作审计留痕。',
    permission: 'nas.write',
    parameters: {
      nasId: { type: 'string', required: true, description: 'NAS 资产 ID' },
      path: { type: 'string', required: true, description: '目标目录绝对路径' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args, exec) {
      return await ctx.nasRegistry.mkdir(String(args.nasId), String(args.path), actorOf(args, exec))
    },
  }))

  t.register(defineTool({
    name: 'nas_fs_delete',
    description: '删除 NAS 上的文件或目录（fs_delete，可批量），写操作审计留痕。',
    permission: 'nas.write',
    parameters: {
      nasId: { type: 'string', required: true, description: 'NAS 资产 ID' },
      paths: { type: 'array', items: { type: 'string' }, required: true, description: '目标绝对路径数组' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args, exec) {
      const paths = Array.isArray(args.paths) ? args.paths.map(String) : [String(args.paths)]
      return await ctx.nasRegistry.delete(String(args.nasId), paths, actorOf(args, exec))
    },
  }))

  t.register(defineTool({
    name: 'nas_fs_upload',
    description: '上传文件到 NAS（平台侧本地路径 → staging → 网关 fs_upload）。跨机部署需共享 staging 卷。',
    permission: 'nas.write',
    parameters: {
      nasId: { type: 'string', required: true, description: 'NAS 资产 ID' },
      localFile: { type: 'string', required: true, description: '平台侧可访问的本地文件绝对路径' },
      destPath: { type: 'string', required: true, description: 'NAS 目标绝对路径 /<共享名>/…/文件名' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args, exec) {
      return await ctx.nasRegistry.uploadFile(String(args.nasId), {
        localFile: String(args.localFile),
        destPath: String(args.destPath),
        actor: actorOf(args, exec),
      })
    },
  }))
}

/** 写类工具的操作人：工具桥注入 caller 身份后可信，直连执行时缺省标注来源。 */
function actorOf(args: Record<string, unknown>, exec: { callId: string }): { id: string; name: string } {
  if (typeof args.actorId === 'string' && typeof args.actorName === 'string') return { id: args.actorId, name: args.actorName }
  return { id: `tool:${exec.callId.slice(0, 8)}`, name: '运维工具调用' }
}

function mask(token: string): string {
  if (!token) return ''
  return token.length > 8 ? `${token.slice(0, 6)}…` : '****'
}
