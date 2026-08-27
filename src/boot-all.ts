/**
 * 插件树组装：按依赖顺序挂载全部平台插件。
 * 这棵树等价于 cordis.yml 在完整 dsh 中加载的内容——一份插件代码，两种宿主。
 */
import type { Context } from '@deepseek-ai/cordis'
import * as platformCore from '@dsh-ops/platform-core'
import * as resourceCore from '@dsh-ops/plugin-resource-core'
import * as iam from '@dsh-ops/plugin-iam'
import * as authn from '@dsh-ops/plugin-authn'
import * as usage from '@dsh-ops/plugin-usage'
import * as billing from '@dsh-ops/plugin-billing'
import * as audit from '@dsh-ops/plugin-audit'
import * as market from '@dsh-ops/plugin-market'
import * as connector from '@dsh-ops/plugin-connector'
import * as modelgw from '@dsh-ops/plugin-modelgw'
import * as mcp from '@dsh-ops/plugin-mcp'
import * as nas from '@dsh-ops/plugin-nas'
import * as skillhub from '@dsh-ops/plugin-skillhub'
import * as agent from '@dsh-ops/plugin-agent'
import * as app from '@dsh-ops/plugin-app'
import * as connect from '@dsh-ops/plugin-connect'
import * as update from '@dsh-ops/plugin-update'
import * as consolePlugin from '@dsh-ops/plugin-console'

export interface BootOptions {
  dataDir: string
  port: number
}

export async function bootAll(ctx: Context, options: BootOptions): Promise<void> {
  await ctx.plugin(platformCore, { dataDir: options.dataDir, http: { port: options.port } })
  const restored = await ctx.opsStorage.restoreAll()
  if (restored.length > 0) {
    ctx.logger('boot').info(`已从磁盘恢复 ${restored.length} 个数据集合`)
  }
  await ctx.plugin(resourceCore)
  await ctx.plugin(iam)
  await ctx.plugin(authn)
  await ctx.plugin(usage)
  await ctx.plugin(billing)
  await ctx.plugin(audit)
  await ctx.plugin(market)
  // 连接器纳管（open-connector 数据面网关适配）：依赖 iam/usage/billing/audit，先于 mcp/modelgw
  await ctx.plugin(connector)
  await ctx.plugin(mcp)
  // NAS（FS 文件存储）资产：先于 skillhub 加载（skillhub 上架时经 nasRegistry 上传 skill.zip）
  await ctx.plugin(nas)
  await ctx.plugin(skillhub)
  await ctx.plugin(agent)
  await ctx.plugin(app)
  await ctx.plugin(modelgw)
  // 宿主角色：提供远程接入端点（接入码/enroll/客户端管理）与接入管理工具
  await ctx.plugin(connect, { role: 'host' })
  // 平台自更新：上游版本检查（自动+手动）与一键升级（source 形态）
  await ctx.plugin(update)
  await ctx.plugin(consolePlugin)
}
