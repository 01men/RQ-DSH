/**
 * 四态状态源映射纯函数自证（WP-06 交付物 2 的配套测试）。
 *
 * 运行方式（Node ≥22.18 原生加载 TS，state.ts 零依赖故无需任何构建）：
 *
 *     node packages/plugin-rq-card/src/client/state.test.mjs
 *
 * 覆盖面：四态各一 + 异常阻断六码各自命中 + 优先级链（逐个摘除标志）+
 * degraded 附加信息 + fail-safe 语义（阻断优先于已完成/调用中）+
 * 结果级异常兜底码 invoke-error。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { deriveExecutionState } from './state.ts'

/** 全空输入（无结果、无 invoke、健康面 unknown）。 */
const IDLE = { hasResult: false, resultIsError: false, invokePhase: 'idle' }

test('四态之 idle：无结果、无 invoke、健康面 unknown', () => {
  assert.deepEqual(deriveExecutionState(IDLE), { state: 'idle' })
})

test('四态之 calling：invoke 发起中（C2 表第一行：mcp invoke() 发起中）', () => {
  assert.deepEqual(
    deriveExecutionState({ ...IDLE, invokePhase: 'calling' }),
    { state: 'calling' },
  )
  // 发起段优先于健康面：同一时刻两者都在场，呈现发起段（骨架 + 可取消）。
  assert.deepEqual(
    deriveExecutionState({ ...IDLE, invokePhase: 'calling', healthStatus: 'healthy' }),
    { state: 'calling' },
  )
})

test('四态之 executing：health healthy（C2 表：online/gray 且 health∈{healthy,degraded}）', () => {
  assert.deepEqual(
    deriveExecutionState({ ...IDLE, healthStatus: 'healthy' }),
    { state: 'executing' },
  )
})

test('执行中 + degraded：附「有点慢」信息（degraded:true）', () => {
  assert.deepEqual(
    deriveExecutionState({ ...IDLE, healthStatus: 'degraded' }),
    { state: 'executing', degraded: true },
  )
  // 非 executing 态不携带 degraded 标记。
  assert.equal(deriveExecutionState({ ...IDLE, healthStatus: 'degraded', hasResult: true, resultIsError: false }).degraded, undefined)
  assert.equal(deriveExecutionState({ ...IDLE, healthStatus: 'degraded', invokePhase: 'calling' }).degraded, undefined)
})

test('四态之 done：调用返回且非错误（C2 表：调用返回 + usage.recorded 落库）', () => {
  assert.deepEqual(
    deriveExecutionState({ hasResult: true, resultIsError: false, invokePhase: 'idle' }),
    { state: 'done' },
  )
})

test('四态之 blocked：六码各自命中（C2 表：down/breakerOpen/nas-authz deny/额度耗尽 + PDP/绑定）', () => {
  const cases = [
    [{ authzDenied: true }, 'nas-authz-deny'],
    [{ quotaExceeded: true }, 'quota-exhausted'],
    [{ pdpUnreachable: true }, 'pdp-unreachable'],
    [{ breakerOpen: true }, 'breaker-open'],
    [{ healthStatus: 'down' }, 'down'],
    [{ bindingInvalid: true }, 'binding-invalid'],
  ]
  for (const [flags, reason] of cases) {
    assert.deepEqual(
      deriveExecutionState({ ...IDLE, ...flags }),
      { state: 'blocked', reason },
    )
  }
})

test('异常阻断优先级：authzDenied > quotaExceeded > pdpUnreachable > breakerOpen > down > bindingInvalid', () => {
  const all = {
    ...IDLE,
    authzDenied: true,
    quotaExceeded: true,
    pdpUnreachable: true,
    breakerOpen: true,
    healthStatus: 'down',
    bindingInvalid: true,
  }
  // 全量在场 → 取最高优先级；随后逐个摘除，验证整条优先级链。
  const chain = [
    [{}, 'nas-authz-deny'],
    [{ authzDenied: false }, 'quota-exhausted'],
    [{ authzDenied: false, quotaExceeded: false }, 'pdp-unreachable'],
    [{ authzDenied: false, quotaExceeded: false, pdpUnreachable: false }, 'breaker-open'],
    [{ authzDenied: false, quotaExceeded: false, pdpUnreachable: false, breakerOpen: false }, 'down'],
    [{ authzDenied: false, quotaExceeded: false, pdpUnreachable: false, breakerOpen: false, healthStatus: 'unknown' }, 'binding-invalid'],
  ]
  for (const [unset, reason] of chain) {
    assert.deepEqual(deriveExecutionState({ ...all, ...unset }), { state: 'blocked', reason })
  }
})

test('fail-safe：阻断标志优先于已完成/调用中（不呈现历史结果）', () => {
  assert.deepEqual(
    deriveExecutionState({ hasResult: true, resultIsError: false, invokePhase: 'idle', authzDenied: true }),
    { state: 'blocked', reason: 'nas-authz-deny' },
  )
  assert.deepEqual(
    deriveExecutionState({ hasResult: true, resultIsError: false, invokePhase: 'calling', breakerOpen: true }),
    { state: 'blocked', reason: 'breaker-open' },
  )
})

test('结果级异常：isError 且无平台侧阻断标志 → blocked + 兜底码 invoke-error', () => {
  assert.deepEqual(
    deriveExecutionState({ hasResult: true, resultIsError: true, invokePhase: 'idle' }),
    { state: 'blocked', reason: 'invoke-error' },
  )
  // 平台侧标志在场时仍按平台优先级（不落到兜底码）。
  assert.deepEqual(
    deriveExecutionState({ hasResult: true, resultIsError: true, invokePhase: 'idle', quotaExceeded: true }),
    { state: 'blocked', reason: 'quota-exhausted' },
  )
})

test('输出形状收窄：非 blocked 态不带 reason；blocked 必带 reason', () => {
  for (const state of [
    deriveExecutionState(IDLE),
    deriveExecutionState({ ...IDLE, invokePhase: 'calling' }),
    deriveExecutionState({ ...IDLE, healthStatus: 'healthy' }),
    deriveExecutionState({ hasResult: true, resultIsError: false, invokePhase: 'idle' }),
  ]) {
    assert.equal(state.reason, undefined)
    assert.ok(state.state !== 'blocked')
  }
  assert.ok(deriveExecutionState({ ...IDLE, bindingInvalid: true }).reason)
})
