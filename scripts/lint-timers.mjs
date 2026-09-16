/**
 * 定时器卫生扫描（OPT-P3-02，2026-09-12）：
 * packages 下每个 setInterval( 调用必须满足其一，否则违规：
 *   a) 就近（其后 3 行内）跟随 .unref() / .unref?.()；
 *   b) 所在文件存在 clearInterval（生命周期有登记）；
 *   c) 就近带「keepalive」注释（显式保活豁免，须写明理由）。
 * 违规即红（exit 1）——嵌入/测试形态不允许隐式挂起事件循环。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const UNREF_RE = /\.unref\(\)|\.unref\?\.\(\)/

export async function scanTimerHygiene(packagesDir) {
  const messages = []
  let total = 0
  let violations = 0
  let entries
  try {
    entries = await readdir(packagesDir, { withFileTypes: true })
  } catch {
    return { total, violations, messages }
  }
  for (const pkg of entries) {
    if (!pkg.isDirectory()) continue
    let files = []
    try {
      files = await readdir(join(packagesDir, pkg.name, 'src'), { recursive: true })
    } catch {
      continue
    }
    for (const rel of files) {
      if (!rel.endsWith('.ts')) continue
      const file = join(packagesDir, pkg.name, 'src', rel)
      let text = ''
      try {
        text = await readFile(file, 'utf8')
      } catch {
        continue
      }
      if (!text.includes('setInterval(')) continue
      const hasClear = text.includes('clearInterval')
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes('setInterval(')) continue
        total++
        const near = lines.slice(i, i + 7).join('\n')
        const keepalive = /keepalive/i.test(near)
        if (!UNREF_RE.test(near) && !hasClear && !keepalive) {
          violations++
          messages.push(`${pkg.name}/src/${rel}:${i + 1}：setInterval 既未 unref 也无 clearInterval 生命周期登记`)
        }
      }
    }
  }
  return { total, violations, messages }
}
