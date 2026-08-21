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

console.log(`\n清单校验：${total - failed}/${total} 通过`)
process.exit(failed > 0 ? 1 : 0)
