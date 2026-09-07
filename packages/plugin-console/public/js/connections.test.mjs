/**
 * 宿主服务连接管理纯函数自证（docs/frontend-host-switching.md 配套测试）。
 *
 * 运行方式（connections.js 零依赖纯 ESM，Node 直接加载）：
 *
 *     node packages/plugin-console/public/js/connections.test.mjs
 *
 * 覆盖面：地址规范化（协议/尾斜杠/挂载前缀/query-hash 拒绝）、清单增改删、
 * 活动连接决议（默认本机/远程/悬空回落）、删除活动连接的回落标记。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  normalizeBase, loadConnections, saveConnections, upsertConnection, removeConnection,
  activeConnection, setActiveId, getActiveId, CONNECTIONS_KEY, ACTIVE_KEY, LOCAL_ID,
} from './connections.js'

/** localStorage 形状的内存 stub（Node 无 localStorage）。 */
function storageStub() {
  const store = new Map()
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    _store: store,
  }
}

test('normalizeBase：合法地址去尾斜杠、保留挂载前缀', () => {
  assert.deepEqual(normalizeBase('http://192.168.0.7:7300/'), { ok: true, base: 'http://192.168.0.7:7300' })
  assert.deepEqual(normalizeBase('  https://host.example:8801/rq/  '), { ok: true, base: 'https://host.example:8801/rq' })
  assert.equal(normalizeBase('http://localhost:7300').ok, true)
})

test('normalizeBase：缺协议/乱串/query/锚点/空值一律拒绝', () => {
  for (const bad of ['', '   ', '192.168.0.7:7300', 'ftp://x', 'http://h/a?x=1', 'http://h/a#frag', 'not a url']) {
    assert.equal(normalizeBase(bad).ok, false, `应拒绝：${bad}`)
  }
})

test('upsert：新增（名称留空回落主机名）、base 存前规范化', () => {
  const storage = storageStub()
  const first = upsertConnection(storage, { name: '', base: 'http://192.168.0.7:7300/' })
  assert.equal(first.ok, true)
  assert.equal(first.connection.name, '192.168.0.7:7300')
  assert.equal(first.connection.base, 'http://192.168.0.7:7300')
  assert.deepEqual(loadConnections(storage), [first.connection])
})

test('upsert：按 id 更新不新增；非法 base 返回错误且不落盘', () => {
  const storage = storageStub()
  const { connection } = upsertConnection(storage, { name: 'a', base: 'http://a:1' })
  const updated = upsertConnection(storage, { id: connection.id, name: 'b', base: 'http://b:2/rq' })
  assert.equal(updated.list.length, 1)
  assert.equal(updated.list[0].base, 'http://b:2/rq')
  const bad = upsertConnection(storage, { name: 'c', base: 'no-scheme' })
  assert.equal(bad.ok, false)
  assert.equal(loadConnections(storage).length, 1)
})

test('活动连接决议：默认本机（base=部署前缀）→ 切远程 → 悬空 id 回落本机', () => {
  const storage = storageStub()
  assert.equal(activeConnection(storage, '/rq').id, LOCAL_ID)
  assert.equal(activeConnection(storage, '/rq').base, '/rq')
  const { connection } = upsertConnection(storage, { name: '远端', base: 'http://192.168.0.7:7300' })
  setActiveId(storage, connection.id)
  assert.equal(getActiveId(storage), connection.id)
  const remote = activeConnection(storage, '/rq')
  assert.equal(remote.base, 'http://192.168.0.7:7300')
  // 悬空：活动 id 指向的连接被外部清掉 → 回落本机（不白屏）
  saveConnections(storage, [])
  assert.equal(activeConnection(storage, '/rq').id, LOCAL_ID)
})

test('setActiveId(LOCAL_ID) 清空偏好键；removeConnection 标记活动连接被删并回落', () => {
  const storage = storageStub()
  const { connection } = upsertConnection(storage, { name: 'x', base: 'http://x:1' })
  setActiveId(storage, connection.id)
  setActiveId(storage, LOCAL_ID)
  assert.equal(storage._store.has(ACTIVE_KEY), false)

  const other = upsertConnection(storage, { name: 'y', base: 'http://y:1' }).connection
  setActiveId(storage, connection.id)
  setActiveId(storage, other.id)
  const removed = removeConnection(storage, other.id)
  assert.equal(removed.removedActive, true)
  assert.equal(getActiveId(storage), '') // 已回落本机
})

test('removeConnection：删非活动连接不回落；损坏清单回落空数组', () => {
  const storage = storageStub()
  const a = upsertConnection(storage, { name: 'a', base: 'http://a:1' }).connection
  const b = upsertConnection(storage, { name: 'b', base: 'http://b:1' }).connection
  setActiveId(storage, a.id)
  const removed = removeConnection(storage, b.id)
  assert.equal(removed.removedActive, false)
  assert.equal(loadConnections(storage).length, 1)
  storage.setItem(CONNECTIONS_KEY, '{broken json')
  assert.deepEqual(loadConnections(storage), [])
  storage.setItem(CONNECTIONS_KEY, JSON.stringify(['not-an-object', 42]))
  assert.deepEqual(loadConnections(storage), [])
})
