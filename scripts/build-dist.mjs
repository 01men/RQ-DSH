#!/usr/bin/env node
/**
 * build-dist.mjs —— 4 随附包预构建链（plan-gate01 Phase 1.2 / G3 自解）。
 *
 * 【为什么必须预构建】dsh plugin add（github:/npm:/file:/link:）拷贝安装形态下，
 * Node ≥22.6 拒绝对 node_modules 内 TS 做 类型剥离（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING，
 * docs/plan-dsh-plugin-first.md §6.2 真机实测定版）——安装产物必须是纯 JS。
 * 产物提交入库，安装形态零 TS 装载、零生命周期脚本、零构建依赖。
 *
 * 【构建语义】esbuild transform 逐文件单文件转译（不做模块解析、不改写说明符）——
 * 保持 1:1 文件布局与跨包相对导入（panel-core → platform-core）天然成立：
 *   1. 拷贝随附包 src → 各包 dist/（临时树直写，排除 rq-card src/client/**——浏览器半归
 *      build.mjs → lib/client.js 交付）；
 *   2. .ts/.tsx 逐文件 transform 剥类型（仓库源码已验证纯可剥离：enum/namespace/参数属性/
 *      装饰器零命中，docs/plan-gate01.md §2.2）；
 *   3. 文本级路径规范化（一等构建步骤，非核查）：改写三种静态说明符形态
 *      （import … from / export … from / import '…'）中相对说明符的 .ts → .js；
 *      规范化只作用于 dist 副本，源码树保持 .ts 说明符（源码开发形态依赖）；
 *   4. 非 TS 运行期资产同布局拷贝（src/seed/demo-content.json——seed.ts 经 import.meta
 *      同级解析，esbuild 不拷贝 JSON）；
 *   5. 零残余 fail-closed 断言：产物残留任何相对 .ts 说明符即构建失败；
 *   6. 各包 dist/.build-id 写入指纹（scripts/dist-build-id.mjs，selftest 装机段重算比对）。
 *
 * 用法：npm run build:dist
 */

import { mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, extname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DIST_PACKAGES, computeDistBuildId, buildIdFileContent } from './dist-build-id.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LOADER_BY_EXT = { '.ts': 'ts', '.tsx': 'tsx', '.mts': 'ts', '.cts': 'ts' }
/** 排除目录（相对仓根，POSIX 斜杠）：浏览器半归 build.mjs 管。 */
const EXCLUDE_DIRS = ['packages/plugin-rq-card/src/client']

/** 递归收集 src 树下的文件（含非 TS 资产，排除项之外全拷贝）。 */
function collectFiles(base, out = []) {
  const dir = join(ROOT, base)
  for (const entry of readdirSync(dir)) {
    const rel = `${base}/${entry}`
    if (EXCLUDE_DIRS.some((excluded) => rel === excluded || rel.startsWith(`${excluded}/`))) continue
    if (statSync(join(ROOT, rel)).isDirectory()) collectFiles(rel, out)
    else out.push(rel)
  }
  return out
}

/** esbuild JS API：仓内 devDependencies 直取（构建链属开发仪式，非安装形态依赖）。 */
async function resolveEsbuild() {
  try { return await import('esbuild') } catch {
    console.error('[build-dist] 未找到 esbuild——请先 npm install（devDependencies 已声明 esbuild）。')
    process.exit(1)
  }
}

/** 文本级路径规范化：相对说明符的 .ts 尾缀 → .js（三种静态说明符形态）。 */
function rewriteSpecifiers(code) {
  // import … from 'X' / export … from 'X'（含 export * from）
  let out = code.replace(/(from\s*)(['"])(\.\.?\/[^'"]+)\2/g, (whole, kw, quote, spec) => {
    return `${kw}${quote}${rewriteOne(spec)}${quote}`
  })
  // 裸 import 'X'（副作用导入）
  out = out.replace(/(^\s*import\s*)(['"])(\.\.?\/[^'"]+)\2/gm, (whole, kw, quote, spec) => {
    return `${kw}${quote}${rewriteOne(spec)}${quote}`
  })
  return out
}

const CROSS_PKG_SRC_RE = /^((?:\.\.\/)+)([A-Za-z0-9_-]+)\/src\/(.+)$/

function rewriteOne(spec) {
  // 跨包相对导入（随附包兄弟目录）：../../platform-core/src/bus.ts → ../../platform-core/dist/bus.js。
  // dist 平铺在 packages/<pkg>/dist/ 与 src/ 同层——包根资产（../scenegraphs、../public、../cardpacks）
  // 的 import.meta 相对解析语义与源码形态一致，跨包导入只需把 /src/ 段换成 /dist/ 段。
  const cross = CROSS_PKG_SRC_RE.exec(spec)
  if (cross) {
    const [, dots, pkg, rest] = cross
    if (!DIST_PACKAGES.includes(pkg)) {
      throw new Error(`跨包导入指向非随附包 "${pkg}"（${spec}）——dist 形态无此包，请定性后扩展 DIST_PACKAGES 或改导入`)
    }
    return `${dots}${pkg}/dist/${rewriteExt(rest)}`
  }
  return rewriteExt(spec)
}

function rewriteExt(name) {
  if (name.endsWith('.ts') || name.endsWith('.mts') || name.endsWith('.cts')) return `${name.slice(0, -3)}.js`
  return name
}

/** 零残余断言：产物中任何相对 .ts 说明符都是改写遗漏（fail-closed）。 */
function assertNoTsSpecifiers(rel, code) {
  const residue = [
    /from\s*(['"])\.\.?\/[^'"]*\.ts\1/g,
    /from\s*(['"])\.\.?\/[^'"]*\.mts\1/g,
    /^\s*import\s*(['"])\.\.?\/[^'"]*\.ts\1/gm,
    /import\(\s*(['"])\.\.?\/[^'"]*\.ts\1\s*\)/g,
  ].flatMap((re) => [...code.matchAll(re)].map((m) => m[0]))
  if (residue.length > 0) {
    console.error(`[build-dist] 零残余断言失败：${rel} 残留 ${residue.length} 处 .ts 说明符：`)
    for (const item of residue.slice(0, 5)) console.error(`    ${item}`)
    process.exit(1)
  }
}

/** dist 落盘名：源 .ts/.mts/.cts 扩展名 → .js（transform 只转内容，文件名在此步换）。 */
function distEntryName(name) {
  if (name.endsWith('.ts') || name.endsWith('.mts') || name.endsWith('.cts')) return `${name.slice(0, -3)}.js`
  return name
}

async function main() {
  const esbuild = await resolveEsbuild()
  let files = 0
  let json = 0
  for (const pkg of DIST_PACKAGES) {
    const srcBase = `packages/${pkg}/src`
    if (!existsSync(join(ROOT, srcBase))) continue
    const distBase = `packages/${pkg}/dist`
    rmSync(join(ROOT, distBase), { recursive: true, force: true })
    for (const rel of collectFiles(srcBase)) {
      const distRel = `${distBase}/${distEntryName(rel.slice(srcBase.length + 1))}`
      const target = join(ROOT, distRel)
      mkdirSync(dirname(target), { recursive: true })
      const ext = extname(rel)
      if (ext in LOADER_BY_EXT) {
        const source = readFileSync(join(ROOT, rel), 'utf8')
        const result = await esbuild.transform(source, {
          loader: LOADER_BY_EXT[ext],
          format: 'esm',
          target: 'node22',
          sourcemap: false,
          legalComments: 'none',
        })
        const rewritten = rewriteSpecifiers(result.code)
        assertNoTsSpecifiers(distRel, rewritten)
        writeFileSync(target, rewritten)
        files += 1
      } else {
        copyFileSync(join(ROOT, rel), target)
        json += 1
      }
    }
    writeFileSync(join(ROOT, distBase, '.build-id'), buildIdFileContent(computeDistBuildId(ROOT)), 'utf8')
    console.log(`[build-dist] ${pkg}: dist/ 就绪`)
  }
  console.log(`[build-dist] OK —— ${files} 个 TS 文件转译 + ${json} 个非 TS 资产拷贝，build-id 已写入各包 dist/.build-id`)
}

main().catch((error) => {
  console.error('[build-dist] 构建失败：', error?.message ?? error)
  process.exit(1)
})
