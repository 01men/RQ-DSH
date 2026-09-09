/**
 * 系统性模拟测试用 stub「线上宿主」（形态 A：独立宿主，无 /rq 前缀）。
 * 模拟用户现场的 192.168.0.7:7300：
 *   - GET /api/health → 健康 JSON（真身）
 *   - GET /rq/api/health → 200 text/html（SPA 兜底——Bug1 对抗样本：只看 200 会误判前缀）
 *   - POST /api/auth/login → 会话载荷（记录收到的 Authorization 透传）
 *   - /api/panel/* → 最小面板数据（远端形态 C 完整体验的数据面）
 *   - 其余 /rq/* → HTML 兜底
 * 全部请求落 console 供断言（是否打到 /rq 前缀 = Bug1 修复的直接证据）。
 */
import { createServer } from 'node:http'

const hits = []
const server = createServer(async (req, res) => {
  const url = (req.url ?? '').split('?')[0]
  const json = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(payload)) }
  const html = () => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html><body>stub console spa</body></html>') }
  const body = await new Promise((resolve) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', () => resolve('')) })
  hits.push({ method: req.method, url: req.url ?? '', authz: String(req.headers.authorization ?? '') })

  if (req.method === 'GET' && url === '/api/health') return json(200, { ok: true, data: { status: 'ok', version: '9.9.9-stubhost' } })
  if (url.startsWith('/rq/')) return html()
  if (req.method === 'POST' && url === '/api/auth/login') {
    const input = JSON.parse(body || '{}')
    if (input.username === 'admin' && input.password === 'stub-pass-123') {
      return json(200, { ok: true, data: { token: 'stub-formc-token-xyz', refreshToken: 'stub-refresh', user: { id: 'u9', username: 'admin', displayName: '远端管理员(Stub)', orgId: 'org1', roleIds: [], roles: ['管理员'], permissions: ['*'] } } })
    }
    return json(401, { ok: false, error: { code: 'LOGIN_FAILED', message: '用户名或密码错误（stub 预置 admin / stub-pass-123）' } })
  }
  if (url === '/api/panel/depts') {
    return json(200, { ok: true, data: { depts: [
      { id: 'rd', label: '研发(Stub远端)', icon: '🔬', allowed: true, agents: [] },
      { id: 'mfg', label: '制造(Stub远端)', icon: '🏭', allowed: true, agents: [] },
    ] } })
  }
  if (url === '/api/panel/industries') return json(200, { ok: true, data: { industries: [] } })
  if (/^\/api\/panel\/[a-z]+\/overview$/.test(url)) {
    return json(200, { ok: true, data: {
      dept: { id: url.split('/')[3], label: '部门(Stub远端)', icon: '🏭', agents: [] },
      channels: [{ id: 'c1', name: '📢 综合频道(Stub)' }], members: [], industry: null,
    } })
  }
  if (url === '/api/panel/models') return json(200, { ok: true, data: { models: [] } })
  if (url === '/api/dingtalk/status') return json(200, { ok: true, data: { connector: null, bound: null } })
  if (url === '/api/dingtalk/bridges') return json(200, { ok: true, data: { bridges: [] } })
  if (url.startsWith('/api/panel/')) return json(200, { ok: true, data: {} })
  return json(404, { ok: false, error: { code: 'NOT_FOUND', message: `stub miss ${req.method} ${url}` } })
})

await new Promise((resolve) => server.listen(7730, '127.0.0.1', resolve))
console.log('stub host listening http://127.0.0.1:7730 (form A, /rq/* → HTML 兜底)')
// 命中台账定期落盘（供断言读取）
setInterval(() => { console.log('HITS ' + JSON.stringify(hits.slice(-30))) }, 5000).unref?.()
