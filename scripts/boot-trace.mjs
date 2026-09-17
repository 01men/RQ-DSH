/**
 * 逐插件引导打点（诊断用，不入库）：复刻 boot-all 序列，定位挂起插件。
 * 用法：node scripts/boot-trace.mjs 7417 ./data-trace
 */
import { Context } from '@deepseek-ai/cordis'
import * as platformCore from '../packages/platform-core/src/index.ts'
import * as resourceCore from '../packages/plugin-resource-core/src/index.ts'
import * as iam from '../packages/plugin-iam/src/index.ts'
import * as authn from '../packages/plugin-authn/src/index.ts'
import * as usage from '../packages/plugin-usage/src/index.ts'
import * as audit from '../packages/plugin-audit/src/index.ts'
import * as market from '../packages/plugin-market/src/index.ts'
import * as connector from '../packages/plugin-connector/src/index.ts'
import * as modelgw from '../packages/plugin-modelgw/src/index.ts'
import * as mcp from '../packages/plugin-mcp/src/index.ts'
import * as nas from '../packages/plugin-nas/src/index.ts'
import * as skillhub from '../packages/plugin-skillhub/src/index.ts'
import * as agent from '../packages/plugin-agent/src/index.ts'
import * as app from '../packages/plugin-app/src/index.ts'
import * as connect from '../packages/plugin-connect/src/index.ts'
import * as update from '../packages/plugin-update/src/index.ts'
import * as portal from '../packages/plugin-portal/src/index.ts'
import * as consolePlugin from '../packages/plugin-console/src/index.ts'
import * as panelCore from '../packages/plugin-panel-core/src/index.ts'
import * as flowCore from '../packages/plugin-flow-core/src/index.ts'
import * as dingtalkBridge from '../packages/plugin-dingtalk-bridge/src/index.ts'

const port = Number(process.argv[2] ?? 7417)
const dataDir = process.argv[3] ?? './data-trace'
const ctx = new Context()
const step = async (name, fn) => {
  const t0 = Date.now()
  process.stdout.write(`[trace] ${name} … `)
  await fn()
  process.stdout.write(`ok (${Date.now() - t0}ms)\n`)
}
await step('platform-core', () => ctx.plugin(platformCore, { dataDir, http: { port } }))
await step('restoreAll', () => ctx.opsStorage.restoreAll())
await step('resource-core', () => ctx.plugin(resourceCore))
await step('iam', () => ctx.plugin(iam))
await step('authn', () => ctx.plugin(authn))
await step('usage', () => ctx.plugin(usage))
await step('audit', () => ctx.plugin(audit))
await step('market', () => ctx.plugin(market))
await step('connector', () => ctx.plugin(connector))
await step('modelgw', () => ctx.plugin(modelgw))
await step('mcp', () => ctx.plugin(mcp))
await step('nas', () => ctx.plugin(nas))
await step('skillhub', () => ctx.plugin(skillhub))
await step('agent', () => ctx.plugin(agent))
await step('app', () => ctx.plugin(app))
await step('connect(host)', () => ctx.plugin(connect, { role: 'host' }))
await step('update', () => ctx.plugin(update))
await step('portal', () => ctx.plugin(portal))
// 包装 console.apply：捕获静默异常 / 静默跳过（0ms 之谜）
const consoleApplyOrig = consolePlugin.apply
const consoleWrapped = {
  name: consolePlugin.name,
  inject: consolePlugin.inject,
  apply: (ctx2, config) => {
    process.stdout.write('[trace] console.apply ENTER\n')
    try {
      const result = consoleApplyOrig(ctx2, config)
      process.stdout.write('[trace] console.apply EXIT ok\n')
      return result
    } catch (error) {
      process.stdout.write(`[trace] console.apply THREW: ${error?.stack ?? error}\n`)
      throw error
    }
  },
}
await step('console', () => ctx.plugin(consoleWrapped))
await step('panel-core', () => ctx.plugin(panelCore))
await step('flow-core', () => ctx.plugin(flowCore))
await step('dingtalk-bridge', () => ctx.plugin(dingtalkBridge))
console.log('[trace] ALL DONE')
process.stdout.write(`[trace] health probe: `)
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`)
  process.stdout.write(`${res.status} ${await res.text()}\n`)
} catch (error) { process.stdout.write(`ERR ${error.message}\n`) }
console.log(`[trace] DEMO_SEED=${process.env.DEMO_SEED ?? '(unset)'}`)
await new Promise(() => {}) // 保持进程存活供外部探活
