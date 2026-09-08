#!/usr/bin/env node
/**
 * build-id.mjs —— rq-card 浏览器半 bundle 的内容指纹（fresh-install 装机门禁）。
 *
 * 【为什么需要】dsh client-modules 对声明的 client 包伺服 /plugins/<id>/client.js，
 * 产物缺失时宿主激活期响亮抛错（spike §4.4）；更隐蔽的事故形态是「改了 src/client/**
 * 忘了跑 build.mjs」——装机包里带着过期 bundle，dsh 上跑的是旧注入面。build-id 把
 * 「源 → 产物」的对应关系变成可断言的事实：build.mjs 构建时把指纹写进 lib/client.js
 * 头部 banner，selftest「fresh-install 装机模拟」段用本模块重算指纹比对——不一致即红。
 *
 * 【指纹输入】src/client/**（排除 *.test.mjs）+ src/wire.ts + build.mjs + package.json，
 * 按排序后的相对路径与内容顺序喂 sha256，取前 16 位十六进制。任何影响浏览器半行为或
 * 构建形状的改动都会改变指纹；测试文件不参与（改测试不应强制重建）。
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** lib/client.js 头部 banner 的指纹标记名（读写两侧共用）。 */
export const BUILD_ID_HEADER = 'rq-card-build-id'

const PKG_ROOT = fileURLToPath(new URL('.', import.meta.url))

/** 递归列出目录下全部文件的相对路径（/ 分隔、字典序，保证喂序确定）。 */
function listFiles(dir, prefix = '') {
  let out = []
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) out = out.concat(listFiles(join(dir, entry.name), `${prefix}${entry.name}/`))
      else out.push(`${prefix}${entry.name}`)
    }
  } catch { /* 目录不存在返回空列表 */ }
  return out.sort()
}

/**
 * 计算 rq-card 浏览器半的当前源指纹。
 * @param pkgRoot 包根目录（默认本包）；selftest 传入仓库内路径复用同一算法。
 */
export function computeClientBuildId(pkgRoot = PKG_ROOT) {
  const hash = createHash('sha256')
  const clientDir = join(pkgRoot, 'src', 'client')
  for (const rel of listFiles(clientDir)) {
    if (rel.endsWith('.test.mjs')) continue
    hash.update(rel)
    hash.update(readFileSync(join(clientDir, rel)))
  }
  hash.update(readFileSync(join(pkgRoot, 'src', 'wire.ts')))
  hash.update(readFileSync(join(pkgRoot, 'build.mjs')))
  hash.update(readFileSync(join(pkgRoot, 'package.json')))
  return hash.digest('hex').slice(0, 16)
}

/**
 * 读取 lib/client.js banner 中已构建的指纹；文件缺失或 banner 无标记返回 undefined。
 * @param pkgRoot 包根目录（默认本包）。
 */
export function readBuiltId(pkgRoot = PKG_ROOT) {
  let text = ''
  try { text = readFileSync(join(pkgRoot, 'lib', 'client.js'), 'utf8') } catch { return undefined }
  const match = new RegExp(`/\\*\\s*${BUILD_ID_HEADER}:\\s*([0-9a-f]+)\\s*\\*/`).exec(text.slice(0, 600))
  return match?.[1]
}
