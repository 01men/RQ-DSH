#!/usr/bin/env node
/**
 * merge-scene-list.mjs —— WorkBuddy《场景全量清单.json》（工信部 2025 版 14 行业 818 场景）
 * → packages/platform-core/scenegraphs/*.json 增量合并。
 *
 * 合并语义（诚实数据铁律）：
 *   - 已入库场景一律保留原样（此前逐条校对的结构化四清单不回写覆盖）；
 *   - 只新增「数据完整」的场景：pain + tool/model/data/talent 四项在源清单中全部非空——
 *     validateScenegraph 的「四清单缺一不可」契约不允许空要素场景入库，缺项场景不造数补齐；
 *   - 环节链（links）保留既有登记；新场景引入未知环节键时追加（名称取源清单 linkNames/CSV，取不到用键名）。
 *
 * 用法：node scripts/merge-scene-list.mjs <场景全量清单.json> [场景全量清单.csv]
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = process.argv[2] ?? ''
const CSV = process.argv[3] ?? ''
if (!SOURCE) {
  console.error('用法：node scripts/merge-scene-list.mjs <场景全量清单.json> [场景全量清单.csv]')
  process.exit(1)
}
const DIR = new URL('../packages/platform-core/scenegraphs/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const ACTIVITY_KEY = { 1: 'rd', 2: 'mfg', 3: 'svc', 4: 'mgmt', 5: 'scm' }
const ACTIVITY_ORDER = ['rd', 'mfg', 'scm', 'svc', 'mkt', 'mgmt', 'fin']
const SCENE_TAGS = new Set(['提质', '降本', '增效', '增收', '安全', '环保', '节能', '新模式'])

const splitList = (text) => String(text ?? '')
  .split(/[、，,;；\n]+/)
  .map((item) => item.trim())
  .filter(Boolean)

const source = JSON.parse(readFileSync(SOURCE, 'utf8'))

// 环节名映射：JSON linkNames（滤掉截断噪声）+ CSV 环节码/环节名称列（可信度更高，后到覆盖）
const linkNamesByInd = {}
const putLinkName = (code, key, name) => {
  if (!code || !key || !name) return
  linkNamesByInd[code] ??= {}
  linkNamesByInd[code][key] = name
}
for (const [code, names] of Object.entries(source.linkNames ?? {})) {
  for (const [key, name] of Object.entries(names)) {
    if (typeof name === 'string' && name.length <= 12 && !/[（(《".]/.test(name)) putLinkName(code, key, name)
  }
}
if (CSV) {
  const lines = readFileSync(CSV, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
  for (const line of lines.slice(1)) {
    const cols = line.split(',')
    putLinkName(cols[0]?.trim(), cols[2]?.trim(), cols[3]?.trim())
  }
}

let addedTotal = 0
const report = []
for (const file of readdirSync(DIR)) {
  if (!file.endsWith('.json')) continue
  const path = join(DIR, file)
  const pack = JSON.parse(readFileSync(path, 'utf8'))
  const code = pack.code
  const existing = new Set()
  for (const list of Object.values(pack.activities)) for (const scene of list) existing.add(scene.code)

  const added = []
  const newLinks = []
  for (const row of source.scenes) {
    if (row.industry !== code || existing.has(row.code)) continue
    const detail = row.detail ?? {}
    const pain = String(detail.pain ?? '').trim()
    const tools = splitList(detail.tool)
    const models = splitList(detail.model)
    const data = splitList(detail.data)
    const talent = splitList(detail.talent)
    // 四清单缺一不可 + 痛点必填（validateScenegraph 契约）；缺项场景不造数，跳过
    if (!pain || !tools.length || !models.length || !data.length || !talent.length) continue
    const activity = ACTIVITY_KEY[row.activity]
    if (!activity) continue
    added.push({
      code: row.code,
      name: row.name,
      type: row.type === '细分场景' ? '细分场景' : '主场景',
      s: Math.max(1, Math.min(5, Math.round(Number(row.rating) || 1))),
      tags: (row.tags ?? []).map((t) => String(t).trim()).filter((t) => SCENE_TAGS.has(t)),
      pain,
      tools,
      models,
      data,
      talent,
    })
    if (row.link && !(pack.links ?? []).some((l) => l.key === row.link) && !newLinks.some((l) => l.key === row.link)) {
      newLinks.push({ key: row.link, name: linkNamesByInd[code]?.[row.link] ?? row.link })
    }
  }
  if (!added.length) { report.push(`${code}: +0`); continue }
  for (const scene of added) {
    const row = source.scenes.find((r) => r.code === scene.code)
    const activity = ACTIVITY_KEY[row.activity]
    pack.activities[activity] = pack.activities[activity] ?? []
    pack.activities[activity].push(scene)
  }
  // 场景按编号自然排序；activities 键序按 ACTIVITY_ORDER 归一
  for (const list of Object.values(pack.activities)) {
    list.sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }))
  }
  const reordered = {}
  for (const key of [...ACTIVITY_ORDER, ...Object.keys(pack.activities).filter((k) => !ACTIVITY_ORDER.includes(k))]) {
    if (pack.activities[key]) reordered[key] = pack.activities[key]
  }
  pack.activities = reordered
  if (newLinks.length && pack.links) {
    const known = new Set(pack.links.map((l) => l.key))
    for (const link of newLinks) if (!known.has(link.key)) pack.links.push(link)
    pack.chains = pack.links.map((l) => `${l.key} ${l.name}`).join(' · ')
  }
  writeFileSync(path, JSON.stringify(pack, null, 1) + '\n', 'utf8')
  addedTotal += added.length
  report.push(`${code}: +${added.length}（${added.map((s) => s.code).join('、')}）`)
}
console.log(`合并完成：新增 ${addedTotal} 个场景`)
for (const line of report) console.log(`  ${line}`)
