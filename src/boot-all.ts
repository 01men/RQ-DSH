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
import * as modelgw from '@dsh-ops/plugin-modelgw'
import * as mcp from '@dsh-ops/plugin-mcp'
import * as skillhub from '@dsh-ops/plugin-skillhub'
import * as agent from '@dsh-ops/plugin-agent'
import * as app from '@dsh-ops/plugin-app'
import * as connect from '@dsh-ops/plugin-connect'
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
  await ctx.plugin(mcp)
  await ctx.plugin(skillhub)
  await ctx.plugin(agent)
  await ctx.plugin(app)
  await ctx.plugin(modelgw)
  // 宿主角色：提供远程接入端点（接入码/enroll/客户端管理）与接入管理工具
  await ctx.plugin(connect, { role: 'host' })
  await ctx.plugin(consolePlugin)
}
