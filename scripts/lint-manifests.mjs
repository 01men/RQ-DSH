/**
 * 契约清单 lint：校验全部平台插件 manifest（plugin.yaml + manifest/*.yaml）可解析。
 * 使用与市场契约解析器相同的 YAML 子集解析器（platform-core yaml.ts）——
 * 平台自己的清单与第三方五面走同一套语法口径（吃自己的狗粮）。
 * 用法：npm run lint:manifests
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseYaml } from '../packages/platform-core/src/yaml.ts'
import { validateScenegraph } from '../packages/platform-core/src/scenegraph.ts'
import { runContractLint } from './contract-lint.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(root, 'packages')

let total = 0
let failed = 0
for (const pkg of await readdir(packagesDir, { withFileTypes: true })) {
  if (!pkg.isDirectory()) continue
  const manifestDir = join(packagesDir, pkg.name, 'manifest')
  let files = []
  try {
    files = (await readdir(manifestDir)).filter((file) => file.endsWith('.yaml')).map((file) => join('manifest', file))
  } catch {
    continue
  }
  const pluginYaml = join(packagesDir, pkg.name, 'plugin.yaml')
  try {
    await readFile(pluginYaml, 'utf8')
    files = ['plugin.yaml', ...files]
  } catch {
    // 无 plugin.yaml 的包跳过
  }
  for (const rel of files) {
    total++
    const file = join(packagesDir, pkg.name, rel)
    try {
      const text = await readFile(file, 'utf8')
      const parsed = parseYaml(text)
      if (parsed === null || typeof parsed !== 'object') throw new Error('解析结果为空')
      console.log(`  ✔ ${pkg.name}/${rel}`)
    } catch (error) {
      failed++
      console.error(`  ✘ ${pkg.name}/${rel}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

// -- 行业场景图谱（review-dsh-agent-panel-v2 Phase 2）：packages/*/scenegraphs/*.json 逐个过 validateScenegraph
// 与运行时装载（scenegraph.ts）同一套规则，故意配错即红
let sgTotal = 0
let sgFailed = 0
for (const pkg of await readdir(packagesDir, { withFileTypes: true })) {
  if (!pkg.isDirectory()) continue
  const sgDir = join(packagesDir, pkg.name, 'scenegraphs')
  let files = []
  try {
    files = (await readdir(sgDir)).filter((file) => file.endsWith('.json'))
  } catch {
    continue
  }
  for (const name of files) {
    sgTotal++
    const file = join(sgDir, name)
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      const errors = validateScenegraph(parsed, name)
      if (errors.length > 0) throw new Error(errors.join('；'))
      console.log(`  ✔ ${pkg.name}/scenegraphs/${name}`)
    } catch (error) {
      sgFailed++
      console.error(`  ✘ ${pkg.name}/scenegraphs/${name}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

console.log(`\n清单校验：${total - failed}/${total} 通过；场景图谱：${sgTotal - sgFailed}/${sgTotal} 通过`)

// -- 契约↔实现双向一致性（OPT-P0-01，2026-09-12）：代码注册面 ↔ 清单声明面双向比对 --
const contract = await runContractLint(root)
const exemptCount = contract.diffs.filter((d) => d.severity === 'exempt').length
console.log(`契约比对：路由 代码${contract.stats.codeRoutes}/清单${contract.stats.manifestRoutes} · 工具 代码${contract.stats.codeTools}/清单${contract.stats.manifestTools} · 差异 ${contract.diffs.filter((d) => d.severity === 'red').length} 红 ${contract.diffs.filter((d) => d.severity === 'warn').length} 警${exemptCount > 0 ? ` · ${exemptCount} 豁免（见 scripts/contract-lint.exemptions.json）` : ''}`)
for (const diff of contract.diffs) {
  const mark = diff.severity === 'red' ? '✘' : '⚠'
  ;(diff.severity === 'red' ? console.error : console.log)(`  ${mark} [${diff.kind}] ${diff.message}`)
}
if (!contract.ok) console.error('契约比对存在红项：实现与清单漂移，拒绝放行')

process.exit(failed + sgFailed > 0 || !contract.ok ? 1 : 0)
