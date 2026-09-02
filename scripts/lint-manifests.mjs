/**
 * 契约清单 lint：校验全部平台插件 manifest（plugin.yaml + manifest/*.yaml）可解析。
 * 使用与市场契约解析器相同的 YAML 子集解析器（platform-core yaml.ts）——
 * 平台自己的清单与第三方五面走同一套语法口径（吃自己的狗粮）。
 * WP-05/B2：增卡片包校验（各包 cardpacks 目录下 *.json）——schema 必填/上限/徽标枚举/ref 格式，
 * 与运行时装载（cardpacks.ts validateCardpack）同一套规则，故意配错即红。
 * 用法：npm run lint:manifests
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseYaml } from '../packages/platform-core/src/yaml.ts'
import { validateCardpack } from '../packages/platform-core/src/cardpacks.ts'

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

// -- 卡片包（WP-05/B2）：packages/*/cardpacks/*.json 逐个过 validateCardpack ----------
let packTotal = 0
let packFailed = 0
for (const pkg of await readdir(packagesDir, { withFileTypes: true })) {
  if (!pkg.isDirectory()) continue
  const packDir = join(packagesDir, pkg.name, 'cardpacks')
  let files = []
  try {
    files = (await readdir(packDir)).filter((file) => file.endsWith('.json'))
  } catch {
    continue
  }
  for (const name of files) {
    packTotal++
    const file = join(packDir, name)
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      const errors = validateCardpack(parsed, name)
      if (errors.length > 0) throw new Error(errors.join('；'))
      console.log(`  ✔ ${pkg.name}/cardpacks/${name}`)
    } catch (error) {
      packFailed++
      console.error(`  ✘ ${pkg.name}/cardpacks/${name}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

console.log(`\n清单校验：${total - failed}/${total} 通过；卡片包：${packTotal - packFailed}/${packTotal} 通过`)
process.exit(failed + packFailed > 0 ? 1 : 0)
