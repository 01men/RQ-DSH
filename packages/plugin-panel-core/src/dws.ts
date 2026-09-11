/**
 * dws 钉钉 CLI 桥（01门装态钉钉连接兜底）：钉钉官方命令行工具（dingtalk-workspace-cli，
 * 命令前缀 dws）作为 01门 装态的消息出向通道——宿主面钉钉连接器/桥（plugin-dingtalk-bridge）
 * 缺席时，面板「钉钉同步」经本桥落 dws chat 命令投递；CLI 未安装时提供一键安装与诚实状态。
 *
 * 动机（2026-09-11 用户需求）：面板钉钉连接直接使用 dws CLI；客户机器没装时默认帮装；
 * 面板支持 CLI 调用-消息交互。设计边界：
 *   - 本桥零凭证：钉钉侧授权态归 dws CLI 自身（用户已在 dsh/终端完成 dws login）；
 *   - plugin-dingtalk-bridge 在场（全量形态）→ 路由/事件全归桥，本模块不注册不订阅；
 *   - 发送失败如实回传（stdout/stderr 尾部），绝不造假成功；
 *   - 入向（钉钉→面板）：dws chat +chat-messages 拉取绑定群最新消息（按 messageId 幂等去重落库）。
 */
import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'

/** dws 绑定配置（opsStorage 单记录集合）。 */
export interface DwsBindingRecord {
  id: string
  /** 目标钉钉群（群名或 openConversationId，交由 dws CLI 解析）。 */
  group?: string
  boundAt?: string
  boundBy?: string
}

export interface DwsStatus {
  installed: boolean
  version?: string
  mode: 'dws-cli'
  bound: boolean
  group?: string
  installHint: string
  lastError?: string
}

const INSTALL_CMD = 'npm install -g dingtalk-workspace-cli'
const INSTALL_HINT = `未检测到 dws CLI（钉钉官方命令行）。一键安装（本面板按钮）或手动执行：${INSTALL_CMD}；安装后在终端执行 dws login 完成钉钉授权。`
const SPAWN_TIMEOUT_MS = 20_000
const INSTALL_TIMEOUT_MS = 240_000
const OUTPUT_CAP = 8_000

/** dws 绑定存储（单记录，id 固定 'dws'）。 */
export function dwsBinding(ctx: Context) {
  return ctx.opsStorage.collection<DwsBindingRecord>('panel:dingtalk')
}

function readBinding(ctx: Context): DwsBindingRecord | undefined {
  return dwsBinding(ctx).get('dws')
}

/** 引用安全的命令行拼接（Windows cmd 引号规则：内容不含引号时双引号包裹足够）。 */
const quote = (value: string): string => (/[^\w@%+=:,./-]/.test(value) ? `"${value.replace(/"/g, '')}"` : value)

function exec(command: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const line = [command, ...args.map(quote)].join(' ')
    const child = spawn(line, [], {
      shell: true,
      windowsHide: true,
      env: { ...process.env },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, stdout: stdout.slice(-OUTPUT_CAP), stderr: stderr.slice(-OUTPUT_CAP) })
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 进程已退出 */ }
      finish(false)
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      stderr += String(error)
      finish(false)
    })
    child.on('close', (code) => finish(code === 0))
  })
}

/** dws CLI 是否可用（版本探测，结果缓存 30s——探测是毫秒级但避免高频 spawn）。 */
export class DwsCli {
  private versionCache: { at: number; installed: boolean; version?: string } | undefined

  private readonly ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  async probe(force = false): Promise<{ installed: boolean; version?: string }> {
    const cached = this.versionCache
    if (!force && cached && Date.now() - cached.at < 30_000) return cached
    const result = await exec('dws', ['--version'], 10_000)
    const version = result.ok ? result.stdout.trim().split(/\r?\n/)[0]?.trim() : undefined
    const probed = { at: Date.now(), installed: result.ok && Boolean(version), version }
    this.versionCache = probed
    return probed
  }

  /** 状态面（面板 pill/绑定弹窗消费）。 */
  async status(): Promise<DwsStatus> {
    const { installed, version } = await this.probe()
    const binding = readBinding(this.ctx)
    return {
      installed,
      ...(version ? { version } : {}),
      mode: 'dws-cli',
      bound: Boolean(binding?.group),
      ...(binding?.group ? { group: binding.group } : {}),
      installHint: installed ? '' : INSTALL_HINT,
    }
  }

  /** 一键安装（npm 全局装官方 CLI）；已装则直接返回成功。耗时长，调用面须放行 panel.config.write。 */
  async install(): Promise<{ ok: boolean; message: string }> {
    const { installed, version } = await this.probe(true)
    if (installed) return { ok: true, message: `dws CLI 已安装（${version}），无需重复安装` }
    const result = await exec(INSTALL_CMD, [], INSTALL_TIMEOUT_MS)
    const tail = (result.stdout + result.stderr).trim().split(/\r?\n/).slice(-6).join('\n')
    const after = await this.probe(true)
    if (after.installed) {
      return { ok: true, message: `dws CLI 安装完成（${after.version}）。请在终端执行 dws login 完成钉钉授权后回来绑群` }
    }
    return {
      ok: false,
      message: `dws CLI 自动安装失败（npm 退出码非 0）。请手动执行：${INSTALL_CMD}\n${tail}`,
    }
  }

  /** 绑定/换绑目标群（存群名或会话 ID，投递时由 dws 解析）。 */
  bind(group: string, boundBy: string): DwsBindingRecord {
    const trimmed = group.trim()
    if (!trimmed) throw new Error('群名/会话 ID 必填')
    const collection = dwsBinding(this.ctx)
    const existing = collection.get('dws')
    const record = existing
      ? collection.update('dws', { group: trimmed, boundAt: new Date().toISOString(), boundBy })
      : collection.insert({ id: 'dws', group: trimmed, boundAt: new Date().toISOString(), boundBy })
    return record
  }

  unbind(): void {
    const binding = readBinding(this.ctx)
    if (binding) dwsBinding(this.ctx).remove('dws')
  }

  /**
   * 出向投递：dws chat +send-to-group --group <群> --content <文本>（--format json 结构化判果）。
   * 失败抛错（调用方落 audit/事件留痕），绝不静默。
   */
  async sendToGroup(text: string, group?: string): Promise<{ group: string; version?: string }> {
    const { installed, version } = await this.probe()
    if (!installed) throw new Error(`dws CLI 未安装，无法投递。${INSTALL_HINT}`)
    const target = group?.trim() || readBinding(this.ctx)?.group
    if (!target) throw new Error('未绑定钉钉群：请先在面板「钉钉」绑定目标群')
    const result = await exec('dws', ['chat', '+send-to-group', '--group', target, '--content', text, '--format', 'json'], SPAWN_TIMEOUT_MS)
    if (!result.ok) {
      const tail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-4).join('；')
      throw new Error(`dws 投递失败：${tail || 'dws 命令退出码非 0（请检查 dws login 授权态与群名）'}`)
    }
    // dws --format json 输出 {ok:false} 形态时命令退出码可能仍为 0——按真实返回判果
    try {
      const parsed = JSON.parse(result.stdout) as { ok?: boolean; error?: { message?: string } | string }
      if (parsed && parsed.ok === false) {
        const reason = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message
        throw new Error(`dws 投递失败：${reason ?? 'CLI 返回 ok:false'}`)
      }
    } catch (error) {
      if (error instanceof SyntaxError) { /* 非 JSON 输出（旧版 CLI）→ 以退出码为准，视为成功 */ } else { throw error }
    }
    return { group: target, ...(version ? { version } : {}) }
  }

  /**
   * 入向拉取：dws chat +chat-messages 读绑定群最新消息（默认当前时间向前 --limit 条）。
   * 返回归一化消息（createTime 按 dws 输出的本地时区解析为 ISO）；失败抛错，绝不静默。
   */
  async pullLatestMessages(limit = 20, group?: string): Promise<Array<{ messageId: string; sender: string; text: string; createdAt: string }>> {
    const { installed } = await this.probe()
    if (!installed) throw new Error(`dws CLI 未安装，无法拉取。${INSTALL_HINT}`)
    const target = group?.trim() || readBinding(this.ctx)?.group
    if (!target) throw new Error('未绑定钉钉群：请先在面板「钉钉」绑定目标群')
    const capped = Math.min(Math.max(Math.floor(limit) || 20, 1), 50)
    const result = await exec('dws', ['chat', '+chat-messages', '--group', target, '--limit', String(capped), '--no-reactions', '--format', 'json'], SPAWN_TIMEOUT_MS)
    if (!result.ok) {
      const tail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-4).join('；')
      throw new Error(`dws 拉取失败：${tail || 'dws 命令退出码非 0（请检查 dws login 授权态与群名）'}`)
    }
    let parsed: {
      ok?: boolean
      error?: { message?: string } | string
      messages?: Array<{ messageId?: string; sender?: string; text?: string; createTime?: string }>
    }
    try {
      parsed = JSON.parse(result.stdout) as typeof parsed
    } catch {
      throw new Error('dws 拉取失败：CLI 返回了无法解析的输出（请检查 dws 版本 ≥1.0）')
    }
    if (parsed && parsed.ok === false) {
      const reason = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message
      throw new Error(`dws 拉取失败：${reason ?? 'CLI 返回 ok:false'}`)
    }
    return (parsed.messages ?? [])
      .filter((m) => m.messageId && (m.text ?? '').trim())
      .map((m) => ({
        messageId: String(m.messageId),
        sender: String(m.sender ?? '钉钉成员'),
        text: String(m.text ?? '').trim(),
        // dws createTime 为 "YYYY-MM-DD HH:mm:ss" 本地时区形态 → 按本地时区解析
        createdAt: new Date(String(m.createTime ?? '').replace(' ', 'T')).toISOString(),
      }))
  }
}
