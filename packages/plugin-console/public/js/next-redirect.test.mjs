/**
 * 登录回跳（next）统一消费面自证 —— 交接 F 清单 P 节（2026-09-11）配套测试。
 *
 * 运行方式（next-redirect.js 零裸 fetch 纯 ESM，location/history/sessionStorage 可注入，Node 直接加载）：
 *
 *     node packages/plugin-console/public/js/next-redirect.test.mjs
 *
 * 覆盖面：一次读取消费（URL 参数 + 双 sessionStorage 暂存 + URL 清参后置）、
 * 同源/跨源白名单（open redirect / 票据外泄防护）、出口规则（跨源自助票带 fragment 回跳、
 * 签票失败仍回跳、同源直跳、无目的地不出口）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { consumeNextSources, exitWithNext, NEXT_SAME_KEY, NEXT_CROSS_KEY } from './next-redirect.js'

/** 可注入的 location/history/sessionStorage 假体（Node 无 DOM 全局）。 */
function fakeEnv({ url = 'https://host.example/', storage = {} } = {}) {
  const u = new URL(url)
  const calls = { replaceState: [], assign: [] }
  return {
    calls,
    location: {
      search: u.search,
      pathname: u.pathname,
      hash: u.hash,
      assign: (target) => calls.assign.push(target),
    },
    history: { replaceState: (...args) => calls.replaceState.push(args) },
    sessionStorage: {
      getItem: (key) => (key in storage ? storage[key] : null),
      removeItem: (key) => { delete storage[key] },
    },
    storage,
  }
}

test('消费：?next= 同源绝对路径 → sameOrigin 命中，URL 清参后置（一次读取）', () => {
  const env = fakeEnv({ url: 'https://host.example/?next=%2Fpanel%2F#/login' })
  const { sameOrigin, crossOrigin } = consumeNextSources(env)
  assert.equal(sameOrigin, '/panel/')
  assert.equal(crossOrigin, '')
  assert.equal(env.calls.replaceState.length, 1)
  assert.equal(env.calls.replaceState[0][2], '/#/login') // 清参保留 hash
})

test('消费：?next= 回环/私网 http(s) → crossOrigin 命中（G1 跨源自举）', () => {
  const env = fakeEnv({ url: 'https://host.example/?next=http%3A%2F%2F192.168.1.5%3A3000%2Fpanel%2F' })
  const { sameOrigin, crossOrigin } = consumeNextSources(env)
  assert.equal(sameOrigin, '')
  assert.equal(crossOrigin, 'http://192.168.1.5:3000/panel/')
})

test('白名单：公网地址 / 伪协议 / 双斜线相对URL / 带凭据 一律拒绝', () => {
  for (const next of ['https://evil.example/panel', 'javascript:alert(1)', '//evil.example', 'http://u:p@192.168.1.5/']) {
    const env = fakeEnv({ url: `https://host.example/?next=${encodeURIComponent(next)}` })
    const { sameOrigin, crossOrigin } = consumeNextSources(env)
    assert.equal(sameOrigin, '', next)
    assert.equal(crossOrigin, '', next)
  }
})

test('消费：sessionStorage 暂存兜底（api.js 401 打断 / SSO 回调暂存），读后即清', () => {
  const env = fakeEnv({ url: 'https://host.example/', storage: { [NEXT_SAME_KEY]: '/audit', [NEXT_CROSS_KEY]: 'http://127.0.0.1:5173/' } })
  const { sameOrigin, crossOrigin } = consumeNextSources(env)
  assert.equal(sameOrigin, '/audit')
  assert.equal(crossOrigin, 'http://127.0.0.1:5173/')
  assert.equal(NEXT_SAME_KEY in env.storage, false)
  assert.equal(NEXT_CROSS_KEY in env.storage, false)
})

test('消费：URL 参数优先于暂存；无任何来源时空出口且不动 history', () => {
  const urlWins = fakeEnv({ url: 'https://host.example/?next=%2Ffresh', storage: { [NEXT_SAME_KEY]: '/stale' } })
  assert.equal(consumeNextSources(urlWins).sameOrigin, '/fresh')
  const empty = fakeEnv({})
  const none = consumeNextSources(empty)
  assert.equal(none.sameOrigin, '')
  assert.equal(none.crossOrigin, '')
  assert.equal(empty.calls.replaceState.length, 0)
})

test('出口：跨源 → 签自助票带 #entry_ticket= 回跳；签票失败仍回跳（诚实降级）', async () => {
  const ok = fakeEnv({})
  let exited = await exitWithNext({
    crossOrigin: 'http://192.168.1.5:3000/panel/',
    api: { post: async (path) => { assert.equal(path, '/api/auth/entry-tickets/self'); return { ticket: 'tk_1' } } },
    location: ok.location,
  })
  assert.equal(exited, true)
  assert.deepEqual(ok.calls.assign, ['http://192.168.1.5:3000/panel/#entry_ticket=tk_1'])

  const fail = fakeEnv({})
  exited = await exitWithNext({
    crossOrigin: 'http://192.168.1.5:3000/panel/',
    api: { post: async () => { throw new Error('签票失败') } },
    location: fail.location,
  })
  assert.equal(exited, true)
  assert.deepEqual(fail.calls.assign, ['http://192.168.1.5:3000/panel/'])
})

test('出口：同源直接跳转；无目的地不出口（调用方继续落地方案）', async () => {
  const same = fakeEnv({})
  assert.equal(await exitWithNext({ sameOrigin: '/dashboard', api: {}, location: same.location }), true)
  assert.deepEqual(same.calls.assign, ['/dashboard'])
  const none = fakeEnv({})
  assert.equal(await exitWithNext({ api: {}, location: none.location }), false)
  assert.deepEqual(none.calls.assign, [])
})
