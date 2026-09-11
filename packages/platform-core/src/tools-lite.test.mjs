/**
 * ToolRuntimeLite 注册契约自证（OPT-P2-04 配套测试）。
 * 运行：node --test packages/platform-core/src/tools-lite.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntimeLite, defineTool } from './tools-lite.ts'

const makeRuntime = () => new ToolRuntimeLite(new Context())

test('注册无 output.schema 的工具 → TypeError（P2-04 强校验）', () => {
  const runtime = makeRuntime()
  assert.throws(() => runtime.register({
    name: 'no_schema_tool', description: 'x', parameters: { type: 'object' },
    output: { render: () => [] }, execute: async () => {},
  }), /output\.schema/)
})

test('注册 schema 为 null/数组 → TypeError', () => {
  const runtime = makeRuntime()
  for (const schema of [null, [1, 2]]) {
    assert.throws(() => runtime.register({
      name: `bad_${String(Array.isArray(schema))}`, description: 'x', parameters: { type: 'object' },
      output: { schema, render: () => [] }, execute: async () => {},
    }), /output\.schema/)
  }
})

test('defineTool 正常声明（schema 对象根）→ 注册成功', () => {
  const runtime = makeRuntime()
  runtime.register(defineTool({
    name: 'good_tool', description: 'x', parameters: {},
    output: { type: 'object' }, execute: async () => ({ ok: 1 }),
  }))
  assert.equal(runtime.has('good_tool'), true)
})

test('defineTool 缺 output → register 侧 schema 强校验兜底抛错（不再有默认放行）', () => {
  const runtime = makeRuntime()
  const definition = defineTool({ name: 't', description: 'x', parameters: {}, execute: async () => {} })
  assert.equal(definition.output.schema, undefined)
  assert.throws(() => runtime.register(definition), /output\.schema/)
})
