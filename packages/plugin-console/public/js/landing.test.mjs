/**
 * 落地分诊纯函数自证（统一入口 · 角色路由，docs/entry-switching.md 配套测试）。
 *
 * 运行方式（landing.js 零依赖纯 ESM，Node 直接加载）：
 *
 *     node packages/plugin-console/public/js/landing.test.mjs
 *
 * 覆盖面：五内置角色 + member 的分诊决议、通配权限展开后的管理域识别、
 * 面板不可达回落、'*' 全量、裸落地判定、登录回跳地址白名单（open redirect 防护）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveLanding, isBareLanding, sanitizeNext, sanitizeCrossOriginNext, canPanel, isBusinessOnly } from './landing.js'

/** 与 iam BuiltinRoles / BUILTIN_ROLE_MIGRATION 对齐的权限面（经 userPermissions 通配展开后的形态）。 */
const PERMS = {
  admin: ['*'],
  orgAdmin: ['console.login', 'iam.user.read', 'iam.org.read', 'approval.read', 'panel.read', 'panel.write', 'panel.task.write', 'panel.config.write', 'scenegraph.read', 'scenegraph.activate'],
  resourceAdmin: ['console.login', 'mcp.service.read', 'skill.read', 'approval.read', 'nas.read'],
  developer: ['console.login', 'iam.user.read', 'mcp.service.read', 'skill.read', 'agent.read', 'app.read', 'panel.read', 'scenegraph.read'],
  auditor: ['console.login', 'iam.org.read', 'audit.read', 'approval.read', 'panel.read', 'scenegraph.read'],
  member: ['console.login', 'skill.read', 'agent.read', 'app.read', 'panel.read', 'panel.write', 'panel.task.write', 'scenegraph.read'],
  businessNoPanel: ['console.login', 'skill.read'],
}

const user = (permissions) => ({ displayName: 't', permissions })

test('分诊：纯业务身份（member）→ 部门面板', () => {
  assert.equal(resolveLanding(user(PERMS.member)), 'panel')
})

test('分诊：管理/治理身份（admin/org_admin/resource_admin/developer/auditor）→ 控制台', () => {
  for (const key of ['admin', 'orgAdmin', 'resourceAdmin', 'developer', 'auditor']) {
    assert.equal(resolveLanding(user(PERMS[key])), 'console', key)
  }
})

test('分诊：org_admin 的 iam.* 通配展开后必含管理域标记（不得误判为业务身份）', () => {
  // iam BuiltinRoles 中 org_admin permissions 含 'iam.*'；userPermissions 展开成具体点后仍须命中
  const expandedFromWildcard = ['console.login', 'iam.user.read', 'iam.org.read', 'approval.read']
  assert.ok(isBusinessOnly(user(expandedFromWildcard)) === false)
})

test('分诊：「*」全量恒为管理域；无面板权限的业务身份回落控制台', () => {
  assert.equal(isBusinessOnly(user(['*'])), false)
  assert.equal(resolveLanding(user(PERMS.businessNoPanel)), 'console')
})

test('分诊：面板可达判定（panel.read 或 '*'）', () => {
  assert.equal(canPanel(user(PERMS.member)), true)
  assert.equal(canPanel(user(['*'])), true)
  assert.equal(canPanel(user(PERMS.businessNoPanel)), false)
  assert.equal(canPanel(null), false)
})

test('裸落地判定：仅无 hash / #/ / #/dashboard 触发分诊，深链与页内导航不触发', () => {
  for (const bare of ['', '#/', '#/dashboard']) assert.equal(isBareLanding(bare), true, bare)
  for (const deep of ['#/iam', '#/approvals', '#/login', '#/board?tab=x']) assert.equal(isBareLanding(deep), false, deep)
})

test('登录回跳白名单：仅同源绝对路径放行（open redirect 防护）', () => {
  assert.equal(sanitizeNext('/rq/panel/'), '/rq/panel/')
  assert.equal(sanitizeNext('/panel/#sha'), '/panel/#sha')
  assert.equal(sanitizeNext('//evil.example.com/path'), '')
  assert.equal(sanitizeNext('http://evil.example.com'), '')
  assert.equal(sanitizeNext('https://evil.example.com'), '')
  assert.equal(sanitizeNext('javascript:alert(1)'), '')
  assert.equal(sanitizeNext(''), '')
  assert.equal(sanitizeNext(null), '')
  assert.equal(sanitizeNext(undefined), '')
})

test('跨源回跳白名单（G1）：仅回环/私网 http(s) 绝对地址放行（公网/伪协议/带凭据/同源路径均拒）', () => {
  assert.equal(sanitizeCrossOriginNext('http://127.0.0.1:7300/rq/panel/'), 'http://127.0.0.1:7300/rq/panel/')
  assert.equal(sanitizeCrossOriginNext('http://localhost:3080/'), 'http://localhost:3080/')
  assert.equal(sanitizeCrossOriginNext('http://192.168.0.7:7300/'), 'http://192.168.0.7:7300/')
  assert.equal(sanitizeCrossOriginNext('http://10.0.0.3:8080/panel/'), 'http://10.0.0.3:8080/panel/')
  assert.equal(sanitizeCrossOriginNext('https://172.16.1.9/'), 'https://172.16.1.9/')
  assert.equal(sanitizeCrossOriginNext('https://172.32.1.9/'), '')
  assert.equal(sanitizeCrossOriginNext('http://8.8.8.8/'), '')
  assert.equal(sanitizeCrossOriginNext('https://evil.example.com/'), '')
  assert.equal(sanitizeCrossOriginNext('http://user:pass@192.168.0.7/'), '')
  assert.equal(sanitizeCrossOriginNext('javascript:alert(1)'), '')
  assert.equal(sanitizeCrossOriginNext('ftp://192.168.0.1/'), '')
  assert.equal(sanitizeCrossOriginNext('/dashboard'), '')
  assert.equal(sanitizeCrossOriginNext(''), '')
  assert.equal(sanitizeCrossOriginNext(null), '')
})
