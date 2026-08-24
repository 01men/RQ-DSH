/**
 * 平台版本定位：从运行中的插件文件向上解析仓库根（package.json name=dsh-enterprise-ops），
 * 得到唯一权威的版本号与安装形态。源码检出 / dsh 插件市场安装（pnpm git 安装，目录结构同构）
 * 两种形态通吃——此前版本号散落在 package.json、gen-manifests、/api/platform/info 三处互不同步，
 * 自更新能力落地后版本比对成为产品行为，必须收敛到单一事实源。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 平台包名（根 package.json 的 name，安装形态下同样成立）。 */
export const PLATFORM_PACKAGE = 'dsh-enterprise-ops'

export type InstallMode = 'source' | 'bundle'

export interface PlatformVersionInfo {
  /** 仓库/包根目录（含 package.json 与 src/）。 */
  rootDir: string
  /** 根 package.json 的 version（运行期只读，进程内缓存）。 */
  version: string
  /** source=git 源码检出（.git 存在，可一键升级）；bundle=dsh plugin add 安装。 */
  installMode: InstallMode
}

let cached: PlatformVersionInfo | undefined

/** 解析平台版本信息（进程内缓存；升级执行后需用 readRootVersion 重读磁盘）。 */
export function platformVersionInfo(): PlatformVersionInfo {
  if (cached) return cached
  let dir = dirname(fileURLToPath(import.meta.url))
  let rootDir = ''
  for (let depth = 0; depth < 8; depth++) {
    let pkg: { name?: string } | undefined
    try {
      pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }
    } catch { /* 该层无 package.json，继续向上 */ }
    if (pkg) {
      if (!rootDir) rootDir = dir // 兜底：最近一层含 package.json 的目录
      if (pkg.name === PLATFORM_PACKAGE) {
        rootDir = dir
        break
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (!rootDir) rootDir = dir
  let version = '0.0.0'
  try {
    version = String((JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0')
  } catch { /* 保底 0.0.0 */ }
  const gitPath = join(rootDir, '.git')
  let hasGit = false
  try {
    hasGit = existsSync(gitPath) && (statSync(gitPath).isDirectory() || statSync(gitPath).isFile())
  } catch { /* 视为无 .git */ }
  cached = { rootDir, version, installMode: hasGit ? 'source' : 'bundle' }
  return cached
}

/** 不走缓存读取根 package.json 版本（git pull 之后的新版本要用它，而非进程缓存）。 */
export function readRootVersion(rootDir: string): string {
  try {
    return String((JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
}

export function platformVersion(): string {
  return platformVersionInfo().version
}

export function platformRootDir(): string {
  return platformVersionInfo().rootDir
}

export function platformInstallMode(): InstallMode {
  return platformVersionInfo().installMode
}
