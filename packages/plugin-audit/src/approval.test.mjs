/**
 * 审批负载卫生与规则源自证（OPT-P2-02 配套测试，2026-09-12）。
 * 运行：node --test packages/plugin-audit/src/approval.test.mjs
 *
 * 覆盖面：敏感键扫描/深度掩码/规则源口径/createApproval 掩码入库 + reject 类拒绝/
 * executor 失败 → 补偿编排并回写（registerCompensation 注册表 5 例）。
 * 补偿用例以实例级桩件驱动 AuditService（approvals/record/platformBus 以纯对象替身注入）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { AuditService, approvalKindRule } from './index.ts'
import { SENSITIVE_KEY_RE, scanSensitiveKeys, maskSensitivePayload } from '../../platform-core/src/index.ts'

test('敏感键扫描：嵌套对象/数组内命中并给出路径', () => {
  const paths = scanSensitiveKeys({ name: 'x', nested: { api_key: 'k', list: [{ password: 'p' }] }, note: 'token 帧=词' })
  assert.ok(paths.includes('nested.api_key'))
  assert.ok(paths.includes('nested.list[0].password'))
  assert.equal(paths.length, 2, '仅键名命中，值内容不算')
})

test('深度掩码：值替换为 ***，键名结构保留，inputHash 口径不受影响', () => {
  const { masked, maskedKeys } = maskSensitivePayload({ user: 'u', clientSecret: 's', arr: [{ token: 't' }] })
  assert.equal(masked.clientSecret, '***')
  assert.equal(masked.arr[0].token, '***')
  assert.equal(masked.user, 'u')
  assert.deepEqual(maskedKeys, ['clientSecret', 'arr[0].token'])
  assert.ok(SENSITIVE_KEY_RE.test('accessToken'))
})

test('规则源：admin 续调=reject，连接类=mask，未知 kind 缺省 mask', () => {
  assert.equal(approvalKindRule('connector.action.admin').sensitiveInputPolicy, 'reject')
  assert.equal(approvalKindRule('connector.offline').sensitiveInputPolicy, 'mask')
  assert.equal(approvalKindRule('unknown.kind').sensitiveInputPolicy, 'mask')
})

function makeStubAudit({ executorError } = {}) {
  const ctx = new Context()
  const events = []
  // 构造器会向总线订阅一批事件：注入桩总线（on 返回空注销函数）
  ctx.platformBus = {
    on: () => () => {},
    emit: (name, payload) => events.push({ name, payload }),
  }
  // 构造器还会向 usage 消费管道注册计量订阅
  ctx.usage = { consume: () => () => {} }
  const audit = new AuditService(ctx)
  const store = new Map()
  const calls = { compensations: [], executorRuns: 0 }
  audit.approvals = () => ({
    insert: (record) => (store.set(record.id, record), record),
    get: (id) => store.get(id),
    update: (id, patch) => Object.assign(store.get(id), patch),
    find: () => [...store.values()],
  })
  audit.record = () => {}
  audit.registerExecutor('kind.ok', async () => ({ runId: 'r1' }))
  audit.registerExecutor('kind.fail', async () => {
    calls.executorRuns++
    throw new Error('下游不可用')
  })
  audit.registerCompensation('kind.fail', async (payload, error) => {
    calls.compensations.push({ reason: error.message, ref: payload.ref })
    return { compensated: true }
  })
  void executorError
  return { audit, store, events, calls }
}

test('补偿注册表①：executor 失败 → 补偿被调用且结果回写审批单', async () => {
  const { audit, store, calls } = makeStubAudit()
  const approval = audit.createApproval({ kind: 'kind.fail', title: 't', payload: { ref: 'r-1' }, requesterId: 'u1', requesterName: 'u' })
  const decided = await audit.decideApproval(approval.id, 'approve', 'a1', '审批人')
  assert.equal(calls.executorRuns, 1)
  assert.equal(calls.compensations.length, 1)
  assert.equal(calls.compensations[0].ref, 'r-1')
  assert.ok(store.get(approval.id).execution.result.includes('已完成补偿'))
  assert.equal(decided.status, 'failed', '补偿不改变执行失败的既成事实')
})

test('补偿注册表②：executor 成功 → 不触发补偿', async () => {
  const { audit, calls } = makeStubAudit()
  const approval = audit.createApproval({ kind: 'kind.ok', title: 't', payload: {}, requesterId: 'u1', requesterName: 'u' })
  await audit.decideApproval(approval.id, 'approve', 'a1', '审批人')
  assert.equal(calls.compensations.length, 0)
})

test('补偿注册表③：未注册补偿的 kind 失败 → 仅记录失败（既有口径不变）', async () => {
  const { audit, store } = makeStubAudit()
  const approval = audit.createApproval({ kind: 'kind.fail', title: 't', payload: { ref: 'x' }, requesterId: 'u', requesterName: 'u' })
  audit.registerCompensation('kind.fail', async () => { throw new Error('never') })
  audit.compensations.delete('kind.fail')
  const decided = await audit.decideApproval(approval.id, 'approve', 'a1', '审批人')
  assert.equal(decided.status, 'failed')
  assert.ok(store.get(approval.id).execution.error.includes('下游不可用'))
})

test('补偿注册表④：补偿自身失败 → execution 显式标记需人工介入', async () => {
  const { audit, store } = makeStubAudit()
  const approval = audit.createApproval({ kind: 'kind.fail', title: 't', payload: {}, requesterId: 'u', requesterName: 'u' })
  audit.registerCompensation('kind.fail', async () => { throw new Error('补偿通道也挂了') })
  const decided = await audit.decideApproval(approval.id, 'approve', 'a1', '审批人')
  assert.equal(decided.status, 'failed')
  assert.ok(store.get(approval.id).execution.result.includes('需人工介入'))
  assert.ok(store.get(approval.id).execution.error.includes('补偿通道也挂了'))
})

test('补偿注册表⑤：createApproval 携敏感入参且规则为 reject → 直接拒绝开单', () => {
  const { audit } = makeStubAudit()
  assert.throws(() => audit.createApproval({
    kind: 'connector.action.admin', title: 't',
    payload: { actionId: 'a', input: { password: 'plain' } }, requesterId: 'u', requesterName: 'u',
  }), /敏感命名入参/)
})

test('补偿注册表⑥：mask 类 kind 携敏感入参 → 掩码入库且 maskedKeys 留痕', () => {
  const { audit, store } = makeStubAudit()
  const approval = audit.createApproval({
    kind: 'connector.offline', title: 't',
    payload: { connectionId: 'c', accessToken: 'should-not-persist' }, requesterId: 'u', requesterName: 'u',
  })
  const stored = store.get(approval.id)
  assert.equal(stored.payload.accessToken, '***')
  assert.deepEqual(stored.payload.maskedKeys, ['accessToken'])
})
