import { Context } from '@deepseek-ai/cordis'
import * as platformCore from '../packages/platform-core/src/index.ts'
import * as iam from '../packages/plugin-iam/src/index.ts'
import * as mcp from '../packages/plugin-mcp/src/index.ts'
import { rmSync, writeSync } from 'node:fs'

const NL = String.fromCharCode(10)
const trace = (...a) => writeSync(1, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + NL)

const dir = '../.tmp-probe-' + Date.now()
const ctx = new Context()
await ctx.plugin(platformCore, { dataDir: dir, startHttp: false })
await ctx.plugin(iam)
await ctx.plugin(mcp)
await new Promise((r) => setTimeout(r, 300))
try {
  trace('probe start: plugins booted')
  const svc = ctx.mcpRegistry.createService({ name: '探针服务', endpoint: 'https://mcp.example.com/mcp', transport: 'http', mode: 'external', exec: 'real', tools: [{ name: 'probe_tool', description: 't' }] })
  trace('svc created:', Boolean(svc?.id))
  const mark = { approverId: 'u1', approverName: '管理员', at: new Date().toISOString() }
  const updated = ctx.mcpRegistry.services().update(svc.id, { finalReview: mark })
  trace('finalReview stored:', JSON.stringify(updated.finalReview ?? null))
  const fresh = ctx.mcpRegistry.services().get(svc.id)
  trace('finalReview re-read:', JSON.stringify(fresh.finalReview ?? null))
  try {
    const result = await ctx.mcpRegistry.invoke({ type: 'user', id: 'u1', name: '管理员' }, svc.id, 'probe_tool', {})
    trace('invoke result:', result.status, String(result.ok))
  } catch (e) {
    trace('invoke threw:', String(e?.message).slice(0, 90))
  }
  const log = ctx.mcpRegistry.callLog({ serviceId: svc.id, limit: 5 })
  trace('calls:', log.items.length, 'watermark[0]:', JSON.stringify(log.items[0]?.watermark ?? null))
} catch (e) {
  trace('ERROR:', String(e && e.stack ? e.stack.split(NL).slice(0, 5).join(' | ') : String(e)))
} finally {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  process.exit(0)
}
