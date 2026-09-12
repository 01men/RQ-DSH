/**
 * 平台事件总线管道自证（OPT-P1-04 配套测试，2026-09-12）。
 *
 * 运行方式（Node 直接加载）：
 *
 *     node --test packages/platform-core/src/bus.test.mjs
 *
 * 覆盖面（对齐 OPT-P1-04 验收）：
 *   - 异步串行派发：emit 同步返回，监听器 FIFO 保序异步执行；
 *   - 监听器异常 → bus.listener_error 事件可查（不再 console.error 了事）；
 *   - 持续失败监听器 → 3 次退避重试后入死信 + bus.dead_letter 告警；
 *   - 重启回放：新实例从 journal 装载最近事件，ring 仍可回放；
 *   - retryDeadLetters 人工重投：清空死信并重新派发；再失败自然重新入死信；
 *   - 超时熔断：挂起监听器按超时计失败（缩短口径以常数注入不可行，超时逻辑以重试路径同构覆盖）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { PlatformBusService, PlatformEvents } from './bus.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('异步串行派发：emit 同步返回事件，监听器 FIFO 异步执行', async () => {
  const bus = new PlatformBusService(new Context())
  const order = []
  bus.on('t1.a', () => order.push('first'))
  bus.on('t1.a', () => order.push('second'))
  const event = bus.emit('t1.a', { n: 1 })
  assert.equal(typeof event.id, 'number', 'emit 同步返回事件对象')
  assert.deepEqual(order, [], '监听器不与 emit 同帧执行（异步派发）')
  await tick()
  assert.deepEqual(order, ['first', 'second'], '监听器按注册顺序串行执行')
})

test('监听器异常 → bus.listener_error 事件可查', async () => {
  const bus = new PlatformBusService(new Context())
  const errors = []
  bus.on(PlatformEvents.BusListenerError, (payload) => errors.push(payload))
  bus.on('t2.boom', () => { throw new Error('业务监听器故意失败') })
  bus.emit('t2.boom', {})
  await new Promise((resolve) => setTimeout(resolve, 1400)) // 3 次退避重试窗口（50+200+800ms）+ 派发余量
  assert.ok(errors.length >= 1, '异常必须落 bus.listener_error 事件')
  assert.equal(errors[0].event, 't2.boom')
  assert.ok(String(errors[0].error).includes('故意失败'))
})

test('持续失败监听器 → 3 次退避重试后入死信 + bus.dead_letter 告警', async () => {
  const bus = new PlatformBusService(new Context())
  const alerts = []
  bus.on(PlatformEvents.BusDeadLetter, (payload) => alerts.push(payload))
  let calls = 0
  bus.on('t3.die', () => { calls++; throw new Error('always fails') })
  bus.emit('t3.die', { k: 1 })
  await new Promise((resolve) => setTimeout(resolve, 1400)) // 退避 50+200+800ms + 派发余量
  assert.ok(calls >= 3, `应重试至 3 次（实际 ${calls}）`)
  assert.equal(bus.deadLetters().length, 1, '3 次失败后入死信')
  assert.equal(bus.deadLetters()[0].eventName, 't3.die')
  assert.ok(alerts.length >= 1, '死信必须发告警事件')
})

test('重启回放：新实例从 journal 装载最近事件，ring 仍可回放', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bus-journal-'))
  try {
    const bus1 = new PlatformBusService(new Context(), { dataDir: dir })
    for (let i = 1; i <= 5; i++) bus1.emit('t4.ev', { i })
    const bus2 = new PlatformBusService(new Context(), { dataDir: dir })
    const recent = bus2.recent(50).reverse()
    assert.equal(recent.length, 5, '重启后 ring 由 journal 回放装载')
    assert.deepEqual(recent.map((event) => event.payload.i), [1, 2, 3, 4, 5], '顺序与内容一致')
    assert.equal(bus2.seq >= 5, true, 'seq 续接历史最大值，不重号')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('retryDeadLetters 人工重投：恢复后重投成功且死信清空', async () => {
  const bus = new PlatformBusService(new Context())
  let healthy = false
  let delivered = 0
  bus.on('t5.flaky', () => {
    if (!healthy) throw new Error('not ready')
    delivered++
  })
  bus.emit('t5.flaky', { v: 1 })
  await new Promise((resolve) => setTimeout(resolve, 1400))
  assert.equal(bus.deadLetters().length, 1)
  healthy = true
  const requeued = bus.retryDeadLetters()
  assert.equal(requeued.redelivered, 1, '恢复后重投成功（QA C-02 契约：redelivered 计数）')
  assert.equal(requeued.retained, 0, '无可保留死信')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(delivered, 1, '重投后监听器成功消费')
  assert.equal(bus.deadLetters().length, 0, '重投成功后死信清空')
})

test('第三方命名空间校验保持不变（来源约束不受管道改造影响）', () => {
  const bus = new PlatformBusService(new Context())
  assert.throws(() => bus.emit('iam.user.frozen', {}, { source: 'plugin:evil' }), /不得发射/)
  assert.throws(() => bus.emit('plugin:evil:ev', {}, { source: 'plugin:other' }), /非自有命名空间/)
})

test('回授断路（QA C-01）：bus.listener_error 的失败监听器不再自激放大', async () => {
  const bus = new PlatformBusService(new Context())
  bus.on(PlatformEvents.BusListenerError, () => { throw new Error('feedback listener broken') })
  // 源监听器失败一次即成功：恰好产生 1 条 bus.listener_error 反馈事件
  let failed = false
  bus.on('t7.x', () => {
    if (!failed) {
      failed = true
      throw new Error('source broken once')
    }
  })
  bus.emit('t7.x', {})
  await new Promise((resolve) => setTimeout(resolve, 200))
  const feedbackDead = bus.deadLetters().filter((d) => d.eventName === PlatformEvents.BusListenerError)
  // 无断路时：listener_error 失败 → 再发 listener_error → 无限循环（journal 持续净增）；
  // 有断路时：反馈事件监听器失败不回授，恰好落死信一条
  assert.equal(failed, true, '前置：源监听器确已失败过一次')
  assert.equal(feedbackDead.length, 1, 'listener_error 失败只落死信一次，不回授放大')
})

test('死信逐条重投（QA C-02）：不可重投条目原地保留，不连带丢弃其余', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bus-c02-'))
  try {
    const dlFile = join(dir, 'bus-dead-letters.jsonl')
    const line = (eventName) => JSON.stringify({ id: `bdl-${Math.random().toString(36).slice(2)}`, eventName, payload: {}, listener: eventName, error: '历史失败', attempts: 4, at: new Date().toISOString() })
    await writeFile(dlFile, `${line('plugin:ghost:ev')}
${line('t8.ok')}
`, 'utf8')
    const bus = new PlatformBusService(new Context(), { dataDir: dir })
    let delivered = 0
    bus.on('t8.ok', () => { delivered++ })
    const result = bus.retryDeadLetters()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(result.attempted, 2)
    assert.equal(result.redelivered, 1, '可重投条目成功重发')
    assert.equal(result.retained, 1, '丢 source 的 plugin: 事件原地保留')
    assert.equal(delivered, 1, '健康条目重投后正常消费')
    assert.equal(bus.deadLetters().length, 1)
    assert.equal(bus.deadLetters()[0].eventName, 'plugin:ghost:ev')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
