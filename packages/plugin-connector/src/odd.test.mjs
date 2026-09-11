/**
 * ODD 域内判定纯函数自证（OPT-P2-01 配套测试，2026-09-12）。
 * 运行：node --test packages/plugin-connector/src/odd.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inOdd, normalizeOdd } from './odd.ts'

const ACTION = { id: 'hackernews.get_top_stories', service: 'hackernews' }
const SYNCED = new Date('2026-09-12T02:00:00Z').toISOString()
const NOW = new Date('2026-09-12T03:00:00Z')

test('①未声明 odd → 全域放行（normalize 折叠为 undefined）', () => {
  assert.equal(normalizeOdd(undefined), undefined)
  assert.equal(normalizeOdd({}), undefined)
  const verdict = inOdd(normalizeOdd({}) ?? {}, ACTION, { now: NOW })
  assert.equal(verdict.in, true)
})

test('②provider 白名单命中 → in', () => {
  const verdict = inOdd({ allowedServices: ['hackernews'] }, ACTION, { now: NOW })
  assert.equal(verdict.in, true)
})

test('③provider 白名单未命中 → 离域并给出理由', () => {
  const verdict = inOdd({ allowedServices: ['github'] }, ACTION, { now: NOW })
  assert.equal(verdict.in, false)
  assert.ok(verdict.reasons[0].includes('白名单'))
})

test('④显式排除 action → 离域', () => {
  const verdict = inOdd({ excludedActions: ['hackernews.get_top_stories'] }, ACTION, { now: NOW })
  assert.equal(verdict.in, false)
  assert.ok(verdict.reasons[0].includes('排除'))
})

test('⑤排除清单未命中 → in', () => {
  const verdict = inOdd({ excludedActions: ['hackernews.submit_post'] }, ACTION, { now: NOW })
  assert.equal(verdict.in, true)
})

test('⑥目录新鲜：syncedAt 距今 60 分钟 < 阈值 120 → in', () => {
  const verdict = inOdd({ dataFreshnessMinutes: 120 }, ACTION, { now: NOW, catalogSyncedAt: SYNCED })
  assert.equal(verdict.in, true)
})

test('⑦目录陈旧：syncedAt 距今超阈值 → 离域', () => {
  const stale = new Date(NOW.getTime() - 181 * 60_000).toISOString()
  const verdict = inOdd({ dataFreshnessMinutes: 180 }, ACTION, { now: NOW, catalogSyncedAt: stale })
  assert.equal(verdict.in, false)
  assert.ok(verdict.reasons[0].includes('陈旧'))
})

test('⑧目录缺时间戳 + 声明新鲜度 → fail-closed 离域', () => {
  const verdict = inOdd({ dataFreshnessMinutes: 60 }, ACTION, { now: NOW })
  assert.equal(verdict.in, false)
  assert.ok(verdict.reasons[0].includes('fail-closed'))
})

test('⑨时间窗内 → in', () => {
  const verdict = inOdd({ activeHours: { start: 9, end: 18 } }, ACTION, { now: new Date('2026-09-12T10:30:00') })
  assert.equal(verdict.in, true)
})

test('⑩时间窗外（夜间）→ 离域', () => {
  const verdict = inOdd({ activeHours: { start: 9, end: 18 } }, ACTION, { now: new Date('2026-09-12T23:30:00') })
  assert.equal(verdict.in, false)
  assert.ok(verdict.reasons[0].includes('时间窗'))
})

test('⑪跨零点窗口（22→6）：凌晨 3 点 → in；中午 12 点 → 离域', () => {
  assert.equal(inOdd({ activeHours: { start: 22, end: 6 } }, ACTION, { now: new Date('2026-09-12T03:00:00') }).in, true)
  assert.equal(inOdd({ activeHours: { start: 22, end: 6 } }, ACTION, { now: new Date('2026-09-12T12:00:00') }).in, false)
})

test('⑫多约束叠加：白名单命中但排除命中 → 离域且理由累计', () => {
  const verdict = inOdd(
    { allowedServices: ['hackernews'], excludedActions: [ACTION.id], dataFreshnessMinutes: 120 },
    ACTION, { now: NOW, catalogSyncedAt: SYNCED },
  )
  assert.equal(verdict.in, false)
  assert.equal(verdict.reasons.length, 1)
})

test('⑬normalizeOdd：非法时间窗/空数组折叠剔除', () => {
  assert.equal(normalizeOdd({ activeHours: { start: 25, end: 2 } }), undefined)
  const normalized = normalizeOdd({ excludedActions: [], dataFreshnessMinutes: -1, allowedServices: '*' })
  assert.deepEqual(normalized, { allowedServices: '*' })
})
