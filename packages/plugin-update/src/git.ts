/**
 * 本地 git 事实读取与安全执行（platform-update 专用，不做通用 git 封装）。
 * 只读 .git 文件而非 spawn `git` —— 启动期的 HEAD 定位必须零子进程、零依赖，
 * 且在 git 不在 PATH 的环境（部分容器/最小安装）下依然可用。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface LocalGitInfo {
  sha: string
  branch: string
  /** detached HEAD 或无法识别分支名时为 false。 */
  onBranch: boolean
}

/** 读取工作树当前 HEAD（sha + 分支）。读不到（bundle 安装/浅克隆异常）返回 null。 */
export function readGitHead(rootDir: string): LocalGitInfo | null {
  const dotGit = join(rootDir, '.git')
  let gitDir = dotGit
  try {
    const stat = statSync(dotGit)
    if (stat.isFile()) {
      // worktree/submodule：.git 是指回主 gitdir 的指针文件
      const target = readFileSync(dotGit, 'utf8').trim().match(/^gitdir:\s*(\S+)/)?.[1]
      if (!target) return null
      gitDir = isAbsolute(target) ? target : join(rootDir, target)
    } else if (!stat.isDirectory()) {
      return null
    }
  } catch {
    return null
  }
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    const refMatch = head.match(/^ref:\s*refs\/heads\/(.+)$/)
    if (!refMatch) {
      return /^[0-9a-f]{40}$/.test(head) ? { sha: head, branch: '', onBranch: false } : null
    }
    const branch = refMatch[1]!
    const refPath = join(gitDir, 'refs', 'heads', ...branch.split('/'))
    if (existsSync(refPath)) {
      const sha = readFileSync(refPath, 'utf8').trim()
      if (/^[0-9a-f]{40}$/.test(sha)) return { sha, branch, onBranch: true }
    }
    // 分支引用未展开时兜底 packed-refs
    if (existsSync(join(gitDir, 'packed-refs'))) {
      const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8')
      const line = packed.split('\n').find((row) => row.endsWith(` refs/heads/${branch}`))
      const sha = line?.split(' ')[0]
      if (sha && /^[0-9a-f]{40}$/.test(sha)) return { sha, branch, onBranch: true }
    }
    return null
  } catch {
    return null
  }
}

/** 在指定目录执行 git 命令（超时保护；stdout+stderr 截断返回）。 */
export async function runGit(rootDir: string, args: string[], timeoutMs = 120_000): Promise<string> {
  const { stdout, stderr } = await execFileAsync('git', args, { cwd: rootDir, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })
  return `${stdout}${stderr ? `\n${stderr}` : ''}`.trim()
}

/** 在指定目录执行 npm 命令。Windows 下 npm 是 .cmd 脚本，必须经 shell 调用。 */
export async function runNpm(rootDir: string, args: string[], timeoutMs = 600_000): Promise<string> {
  const { stdout, stderr } = await execFileAsync('npm', args, {
    cwd: rootDir,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    ...(process.platform === 'win32' ? { shell: true } : {}),
  })
  return `${stdout}${stderr ? `\n${stderr}` : ''}`.trim()
}
