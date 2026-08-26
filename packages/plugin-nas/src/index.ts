/**
 * @dsh-ops/plugin-nas —— NAS（FS 文件存储类）资产纳管。
 *
 * 访问模型：每台 NAS 经「MCP 文件网关」（参考 synology-filestation-mcp）访问——
 * 网关地址 + Bearer 令牌 + X-NAS-IP 设备路由头；全部文件操作（列表/检索/建删/
 * 上传/下载/改名/移动复制）经网关 tools/call 完成，平台不直连 DSM 私有 API。
 *
 * 基于 resource-core 底座（Pattern A）：属性表 + 生命周期状态机 + 依赖图复用，
 * 本插件补充：网关客户端、健康探活、工具发现、文件操作面与 Skill 包存储配置。
 * 全部写类文件操作审计留痕；读类操作仅在线资产可调；全部文件操作进 usage 计量
 * （nas:* 资源、calls/bytes 口径，默认零费率——观测先行，计费由价格簿调价决定）。
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, normalize, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { PlatformEvents, newId, type RecordBase } from '../../platform-core/src/index.ts'
import type { ResourceEntity } from '../../plugin-resource-core/src/index.ts'
import { NasMcpClient, type McpToolInfo } from './client.ts'
import { NAS_TYPE_SPEC } from './schema.ts'
import * as nasTools from './tools.ts'

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

export interface NasHealthRecord extends RecordBase {
  nasId: string
  status: 'healthy' | 'degraded' | 'down' | 'unknown'
  latencyMs: number
  lastProbeAt: string
  consecutiveFails: number
  serverName?: string
}

export interface NasToolCacheRecord extends RecordBase {
  nasId: string
  tools: McpToolInfo[]
  syncedAt: string
}

/** Skill 包存储后端配置（单例）：local = 平台内联存储；nas = 上架时上传到指定 NAS 资产。 */
export interface SkillStorageConfigRecord extends RecordBase {
  mode: 'local' | 'nas'
  nasId?: string
  basePath?: string
  updatedAt: string
  updatedBy: string
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class NasRegistryService extends Service {
  static readonly provide = 'nasRegistry'

  private clients = new Map<string, { client: NasMcpClient; signature: string }>()

  constructor(ctx: Context) {
    super(ctx, 'nasRegistry')
    ctx.resourceCore.registerType(NAS_TYPE_SPEC)
  }

  health(): CollectionLike<NasHealthRecord> {
    return this.ctx.opsStorage.collection<NasHealthRecord>('nas:health')
  }

  toolCache(): CollectionLike<NasToolCacheRecord> {
    return this.ctx.opsStorage.collection<NasToolCacheRecord>('nas:tools')
  }

  skillStorage(): CollectionLike<SkillStorageConfigRecord> {
    return this.ctx.opsStorage.collection<SkillStorageConfigRecord>('skill:storage')
  }

  // -- 注册与生命周期 -------------------------------------------------------

  register(input: { name: string; slug?: string; attrs?: Record<string, unknown>; ownerId: string; orgId: string }): ResourceEntity {
    const entity = this.ctx.resourceCore.create('nas', input)
    this.health().insert({ id: `hlt_${entity.id}`, nasId: entity.id, status: 'unknown', latencyMs: 0, lastProbeAt: '', consecutiveFails: 0 })
    this.ctx.platformBus.emit(PlatformEvents.NasRegistered, { id: entity.id, name: entity.name, slug: entity.slug, actor: input.ownerId, type: 'nas' })
    return entity
  }

  update(id: string, patch: { name?: string; attrs?: Record<string, unknown> }): ResourceEntity {
    const entity = this.ctx.resourceCore.update('nas', id, patch)
    // 接入属性变更后作废缓存的网关客户端（令牌轮换/换网关即时生效）
    this.clients.delete(id)
    return entity
  }

  get(id: string): ResourceEntity | undefined {
    return this.ctx.resourceCore.get('nas', id)
  }

  list(filter?: { status?: string; orgId?: string; q?: string }): ResourceEntity[] {
    return this.ctx.resourceCore.list('nas', filter)
  }

  /** 上线：先做网关 initialize 探活（不可达拒绝上线），再走状态机迁移与工具发现。 */
  async online(id: string, actor: string): Promise<ResourceEntity> {
    const nas = this.requireNas(id)
    const probe = await this.probe(id)
    if (probe.status === 'down') {
      throw new Error(`网关不可达，暂不能上线（${nas.attrs['gatewayUrl']}）`)
    }
    const result = this.ctx.resourceCore.transition('nas', id, 'online', actor)
    this.ctx.platformBus.emit(PlatformEvents.NasOnlined, { id, name: result.entity.name, slug: result.entity.slug, actor, type: 'nas' })
    void this.discoverTools(id).catch(() => undefined)
    return result.entity
  }

  offline(id: string, actor: string, reason: string): ResourceEntity {
    const result = this.ctx.resourceCore.transition('nas', id, 'offline', actor, reason)
    this.ctx.platformBus.emit(PlatformEvents.NasOfflined, { id, name: result.entity.name, slug: result.entity.slug, actor, reason, type: 'nas' })
    this.clients.delete(id)
    return result.entity
  }

  archive(id: string, actor: string): ResourceEntity {
    this.clients.delete(id)
    return this.ctx.resourceCore.transition('nas', id, 'archive', actor).entity
  }

  /** 删除后的关联清理：健康档案、工具发现缓存与网关客户端句柄。 */
  purge(id: string): void {
    this.clients.delete(id)
    for (const record of this.health().find((item) => item.nasId === id)) this.health().remove(record.id)
    for (const record of this.toolCache().find((item) => item.nasId === id)) this.toolCache().remove(record.id)
  }

  // -- 健康与工具发现 -------------------------------------------------------

  /** initialize 探活：延迟 > 800ms 记 degraded；连续失败 3 次记 down 并告警。 */
  async probe(id: string): Promise<NasHealthRecord> {
    const nas = this.requireNas(id)
    const existing = this.health().findOne((item) => item.nasId === id)
    const started = Date.now()
    let status: NasHealthRecord['status'] = 'healthy'
    let serverName: string | undefined
    try {
      const info = await this.clientFor(nas).probe()
      serverName = info.serverInfo?.name
      if (Date.now() - started > 800) status = 'degraded'
    } catch {
      status = 'down'
    }
    const fails = status === 'down' ? (existing?.consecutiveFails ?? 0) + 1 : 0
    const record: NasHealthRecord = {
      id: existing?.id ?? `hlt_${id}`,
      nasId: id,
      status,
      latencyMs: status === 'down' ? -1 : Date.now() - started,
      lastProbeAt: new Date().toISOString(),
      consecutiveFails: fails,
      ...(serverName !== undefined ? { serverName } : {}),
    }
    this.health().update(record.id, record)
    if (fails === 3) {
      this.ctx.audit.fire({
        severity: 'warning',
        title: `NAS「${nas.name}」网关连续探活失败`,
        message: `${nas.attrs['gatewayUrl']} 连续 3 次 initialize 探活失败，资产已标记 down，请检查网关服务与网络。`,
        resourceType: 'nas',
        resourceId: id,
      })
    }
    return record
  }

  healthOf(id: string): NasHealthRecord {
    return this.health().findOne((item) => item.nasId === id)
      ?? { id: `hlt_${id}`, nasId: id, status: 'unknown', latencyMs: 0, lastProbeAt: '', consecutiveFails: 0 }
  }

  /** 工具发现：网关 tools/list 结果落缓存（展示网关提供的 fs_* 能力面）。 */
  async discoverTools(id: string): Promise<McpToolInfo[]> {
    const nas = this.requireNas(id)
    const tools = await this.clientFor(nas).listTools()
    const existing = this.toolCache().findOne((item) => item.nasId === id)
    const record: NasToolCacheRecord = { id: existing?.id ?? `tls_${id}`, nasId: id, tools, syncedAt: new Date().toISOString() }
    if (existing) this.toolCache().update(existing.id, record)
    else this.toolCache().insert(record)
    return tools
  }

  toolsOf(id: string): McpToolInfo[] {
    return this.toolCache().findOne((item) => item.nasId === id)?.tools ?? []
  }

  // -- 文件操作面（全部经网关 tools/call） -----------------------------------

  async listShares(id: string, actor?: { id: string; name: string }): Promise<unknown> {
    return await this.fsCall(id, 'fs_list_shares', {}, { actor })
  }

  async listFiles(id: string, path = '/', actor?: { id: string; name: string }): Promise<unknown> {
    const { share, subPath } = this.splitPath(id, path)
    return await this.fsCall(id, 'fs_list', { share, path: subPath }, { actor })
  }

  async getInfo(id: string, path: string, actor?: { id: string; name: string }): Promise<unknown> {
    const { share, subPath } = this.splitPath(id, path)
    return await this.fsCall(id, 'fs_get_info', { share, path: subPath }, { actor })
  }

  async search(id: string, pattern: string, path = '/', actor?: { id: string; name: string }): Promise<unknown> {
    const { share, subPath } = this.splitPath(id, path)
    return await this.fsCall(id, 'fs_search', { share, path: subPath, pattern }, { actor })
  }

  async mkdir(id: string, path: string, actor: { id: string; name: string }): Promise<unknown> {
    const { share, subPath } = this.splitPath(id, path)
    const result = await this.fsCall(id, 'fs_create_folder', { share, path: subPath }, { actor })
    this.fsAudit(actor, 'nas.fs.mkdir', id, path)
    return result
  }

  async rename(id: string, path: string, newName: string, actor: { id: string; name: string }): Promise<unknown> {
    const { share, subPath } = this.splitPath(id, path)
    const result = await this.fsCall(id, 'fs_rename', { share, path: subPath, new_name: newName }, { actor })
    this.fsAudit(actor, 'nas.fs.rename', id, `${path} → ${newName}`)
    return result
  }

  async copyMove(id: string, paths: string[], destination: string, mode: 'copy' | 'move', actor: { id: string; name: string }): Promise<unknown> {
    const { share, subPath } = this.splitPath(id, destination)
    const result = await this.fsCall(id, 'fs_copy_move', { share, paths: paths.map((p) => this.splitPath(id, p).subPath), dest: subPath, mode }, { actor })
    this.fsAudit(actor, `nas.fs.${mode}`, id, `${paths.join(',')} → ${destination}`)
    return result
  }

  async delete(id: string, paths: string[], actor: { id: string; name: string }): Promise<unknown> {
    const result = await this.fsCall(id, 'fs_delete', { share: this.splitPath(id, paths[0] ?? '/').share, paths: paths.map((p) => this.splitPath(id, p).subPath) }, { actor })
    this.fsAudit(actor, 'nas.fs.delete', id, paths.join(','))
    return result
  }

  /**
   * 上传文件到 NAS：buffer/本地文件 → 平台 staging 目录（或资产配置的共享中转目录）
   * → 网关 fs_upload（fs_upload 在网关进程侧读本地路径，跨机部署需共享 staging 卷）。
   */
  async uploadFile(id: string, input: { buffer?: Buffer; localFile?: string; destPath: string; actor: { id: string; name: string } }): Promise<{ path: string; sizeBytes: number }> {
    const nas = this.requireNas(id)
    let stagingFile: string
    let sizeBytes: number
    if (input.buffer !== undefined) {
      stagingFile = join(this.stagingDir(nas), input.destPath.split('/').filter(Boolean).pop() ?? `upload-${Date.now()}`)
      await mkdir(this.stagingDir(nas), { recursive: true })
      await writeFile(stagingFile, input.buffer)
      sizeBytes = input.buffer.length
    } else if (input.localFile) {
      stagingFile = input.localFile
      sizeBytes = (await readFile(stagingFile)).length
    } else {
      throw new Error('uploadFile 需要 buffer 或 localFile 之一')
    }
    const { share, subPath } = this.splitPath(id, input.destPath)
    await this.fsCall(id, 'fs_upload', { share, path: subPath, local_file: stagingFile, overwrite: true }, { actor: input.actor, bytes: sizeBytes })
    this.fsAudit(input.actor, 'nas.fs.upload', id, `${input.destPath}（${sizeBytes}B，staging=${stagingFile}）`)
    return { path: input.destPath, sizeBytes }
  }

  /** 从 NAS 下载到平台 staging（网关 fs_download 在网关侧落盘，共享卷场景下平台可读）。 */
  async downloadFile(id: string, path: string, actor: { id: string; name: string }): Promise<{ localFile: string; result: unknown }> {
    const nas = this.requireNas(id)
    const dir = join(this.stagingDir(nas), 'downloads')
    await mkdir(dir, { recursive: true })
    const { share, subPath } = this.splitPath(id, path)
    const result = await this.fsCall(id, 'fs_download', { share, path: subPath, dest_dir: dir }, { actor })
    this.fsAudit(actor, 'nas.fs.download', id, path)
    return { localFile: join(dir, path.split('/').filter(Boolean).pop() ?? 'file'), result }
  }

  async taskStatus(id: string, taskId: string, actor?: { id: string; name: string }): Promise<unknown> {
    const { share } = this.splitPath(id, '/')
    return await this.fsCall(id, 'fs_task_status', { share, taskid: taskId }, { actor })
  }

  // -- Skill 包存储配置 -----------------------------------------------------

  getSkillStorage(): SkillStorageConfigRecord {
    return this.skillStorage().get('singleton')
      ?? { id: 'singleton', mode: 'local', updatedAt: '', updatedBy: '' }
  }

  setSkillStorage(patch: { mode?: 'local' | 'nas'; nasId?: string; basePath?: string }, actor: string): SkillStorageConfigRecord {
    const current = this.getSkillStorage()
    const next: SkillStorageConfigRecord = {
      ...current,
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      ...(patch.nasId !== undefined ? { nasId: patch.nasId } : {}),
      ...(patch.basePath !== undefined ? { basePath: patch.basePath } : {}),
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
    }
    if (next.mode === 'nas') {
      if (!next.nasId) throw new Error('NAS 存储模式必须指定 nasId（先在 NAS 存储页纳管资产）')
      const nas = this.get(next.nasId)
      if (!nas) throw new Error(`NAS 资产不存在：${next.nasId}`)
      if (!next.basePath || !next.basePath.startsWith('/')) throw new Error('basePath 必须是以 / 开头的绝对路径')
    }
    if (this.skillStorage().get('singleton')) return this.skillStorage().update('singleton', next)
    return this.skillStorage().insert(next)
  }

  // -- 内部 -----------------------------------------------------------------

  private requireNas(id: string): ResourceEntity {
    const nas = this.ctx.resourceCore.get('nas', id)
    if (!nas) throw new Error(`NAS 资产不存在：${id}`)
    return nas
  }

  private requireOnline(id: string): ResourceEntity {
    const nas = this.requireNas(id)
    if (nas.status !== 'online') throw new Error(`NAS「${nas.name}」当前状态 ${nas.status}，仅已上线资产可执行文件操作`)
    return nas
  }

  private clientFor(nas: ResourceEntity): NasMcpClient {
    const endpoint = String(nas.attrs['gatewayUrl'] ?? '')
    const token = String(nas.attrs['accessToken'] ?? '')
    const nasIp = String(nas.attrs['nasIp'] ?? '')
    if (!endpoint || !token || !nasIp) throw new Error(`NAS「${nas.name}」接入属性未配全（gatewayUrl/accessToken/nasIp）`)
    const signature = `${endpoint}|${token}|${nasIp}`
    const cached = this.clients.get(nas.id)
    if (cached && cached.signature === signature) return cached.client
    const client = new NasMcpClient(endpoint, {
      Authorization: `Bearer ${token}`,
      'X-NAS-IP': nasIp,
    })
    this.clients.set(nas.id, { client, signature })
    return client
  }

  private async fsCall(id: string, tool: string, args: Record<string, unknown>, meter?: { actor?: { id: string; name: string }; bytes?: number }): Promise<unknown> {
    const nas = this.requireOnline(id)
    const raw = await this.clientFor(nas).call(tool, args)
    this.meterFsUsage(nas, meter)
    return typeof raw === 'string' ? parseMaybeJson(raw) : raw
  }

  /** 计量管道（观测补齐）：全部文件操作进 usage 事件（nas:* 默认零费率，失败只告警不阻断）。 */
  private meterFsUsage(nas: ResourceEntity, meter?: { actor?: { id: string; name: string }; bytes?: number }): void {
    try {
      this.ctx.usage.record({
        org: nas.orgId,
        subject: meter?.actor ? (meter.actor.id.includes(':') ? meter.actor.id : `user:${meter.actor.id}`) : 'user:platform',
        principal: `org:${nas.orgId}`,
        resource: `nas:${nas.id}`,
        meters: [
          { key: 'calls', value: 1, unit: '次' },
          ...(meter?.bytes && meter.bytes > 0 ? [{ key: 'bytes', value: meter.bytes, unit: '字节' }] : []),
        ],
        idempotency_key: `nas:fs:${newId('nfs')}`,
      })
    } catch (error) {
      this.ctx.logger('nas').warn('usage 计量登记失败', error)
    }
  }

  /** 平台路径 → 网关契约的 { share, path }（"/share/a/b" → share="share" path="/a/b"），并收敛到授权根路径内。 */
  private splitPath(id: string, path: string): { share: string; subPath: string } {
    const nas = this.requireNas(id)
    const normalized = normalize(`/${path}`).replace(/\\/g, '/')
    const root = normalize(String(nas.attrs['rootPath'] ?? '/')).replace(/\\/g, '/')
    if (root !== '/' && !normalized.startsWith(root === '/' ? '/' : root.endsWith('/') ? root : `${root}/`) && normalized !== root) {
      throw new Error(`路径 ${normalized} 超出授权根路径 ${root}`)
    }
    const segments = normalized.split('/').filter(Boolean)
    if (segments.length === 0) throw new Error('路径必须形如 /<共享名>/…')
    if (segments.includes('..')) throw new Error('路径不允许包含 ..')
    const share = segments[0]!
    const subPath = `/${segments.slice(1).join('/')}`
    return { share, subPath: subPath === '/' ? '/' : subPath }
  }

  private stagingDir(nas: ResourceEntity): string {
    const configured = String(nas.attrs['stagingDir'] ?? '').trim()
    if (configured) return configured
    return join(this.ctx.opsStorage.dataDirPath, 'nas-staging')
  }

  private fsAudit(actor: { id: string; name: string }, action: string, nasId: string, detail: string): void {
    this.ctx.audit.record({
      type: 'change',
      actorType: 'human',
      actorId: actor.id,
      actorName: actor.name,
      action,
      resourceType: 'nas',
      resourceId: nasId,
      resourceName: this.get(nasId)?.name ?? nasId,
      result: 'ok',
      detail,
    })
  }
}

// opsStorage 集合类型的本地别名（避免与服务名冲突的轻量声明）
interface CollectionLike<T extends RecordBase> {
  get(id: string): T | undefined
  findOne(predicate: (item: T) => boolean): T | undefined
  insert(record: T): T
  update(id: string, patch: Partial<T>): T
}

function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text
  try {
    return JSON.parse(trimmed)
  } catch {
    return text
  }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    nasRegistry: NasRegistryService
  }
}

export const name = 'nas'
export const inject = ['opsStorage', 'platformBus', 'resourceCore', 'audit', 'usage']

export function apply(ctx: Context) {
  ctx.plugin(NasRegistryService)
  ctx.plugin(nasTools)
}
