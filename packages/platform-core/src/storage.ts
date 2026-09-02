/**
 * 存储抽象：JSON 集合 + 内存索引 + 防抖原子落盘。
 * 业务插件只面对 Collection API，不感知文件系统；替换为数据库实现时只需重写本服务。
 */
import { copyFile, mkdir, readdir, readFile, rename, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'

export interface RecordBase {
  id: string
  createdAt: string
  updatedAt: string
}

export type ChangeKind = 'insert' | 'update' | 'remove' | 'replace'

export interface CollectionChange<T> {
  kind: ChangeKind
  record: T
}

export interface Collection<T extends RecordBase> {
  readonly name: string
  all(): T[]
  get(id: string): T | undefined
  find(pred: (record: T) => boolean): T[]
  findOne(pred: (record: T) => boolean): T | undefined
  insert(data: Omit<T, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }): T
  update(id: string, patch: Partial<T>): T
  remove(id: string): boolean
  replaceAll(records: T[]): void
  count(): number
  onChange(cb: (change: CollectionChange<T>) => void): () => void
  /**
   * 声明业务唯一约束（模拟数据库部分唯一索引）。
   * 之后 insert/update 违反约束将直接抛错——「先查后插」被引擎级兜底取代，
   * 并发与竞态下不再可能产生重复数据（红线来自 auth-identity 模块设计）。
   */
  uniqueOn(label: string, keyOf: (record: T) => string): void
}

export interface CollectionOptions {
  /**
   * 持久化模式：
   *   - debounced（默认）：250ms 防抖合并落盘；
   *   - durable：每次变更立即落盘并 fsync（认证吊销等不容许崩溃丢失的集合）。
   */
  durability?: 'debounced' | 'durable'
}

export interface StorageConfig {
  /** 数据目录，默认 `<cwd>/data`。 */
  dataDir?: string
}

class CollectionImpl<T extends RecordBase> implements Collection<T> {
  private records = new Map<string, T>()
  private listeners = new Set<(change: CollectionChange<T>) => void>()
  private uniques: Array<{ label: string; keyOf: (record: T) => string }> = []

  readonly name: string
  private readonly persist: (name: string) => void

  constructor(name: string, persist: (name: string) => void) {
    this.name = name
    this.persist = persist
  }

  uniqueOn(label: string, keyOf: (record: T) => string): void {
    if (this.uniques.some((unique) => unique.label === label)) return
    this.uniques.push({ label, keyOf })
  }

  /** 校验唯一约束：返回既有冲突记录（不含自身）。 */
  private conflictOf(record: T, selfId?: string): { label: string; existing: T } | undefined {
    for (const unique of this.uniques) {
      const key = unique.keyOf(record)
      if (key === '' || key === undefined) continue
      for (const other of this.records.values()) {
        if (selfId !== undefined && other.id === selfId) continue
        if (unique.keyOf(other) === key) return { label: unique.label, existing: other }
      }
    }
    return undefined
  }

  all(): T[] {
    return [...this.records.values()]
  }

  get(id: string): T | undefined {
    return this.records.get(id)
  }

  find(pred: (record: T) => boolean): T[] {
    return this.all().filter(pred)
  }

  findOne(pred: (record: T) => boolean): T | undefined {
    for (const record of this.records.values()) {
      if (pred(record)) return record
    }
    return undefined
  }

  insert(data: Omit<T, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }): T {
    const now = new Date().toISOString()
    const record = { createdAt: now, updatedAt: now, ...data, updatedAt: now } as T
    if (this.records.has(record.id)) throw new Error(`[storage] 集合 ${this.name} 中已存在 id=${record.id}`)
    const conflict = this.conflictOf(record)
    if (conflict) throw new Error(`[storage] 唯一约束冲突（${conflict.label}）：与既有记录 ${conflict.existing.id} 重复`)
    this.records.set(record.id, record)
    this.emit({ kind: 'insert', record })
    this.persist(this.name)
    return structuredClone(record)
  }

  update(id: string, patch: Partial<T>): T {
    const current = this.records.get(id)
    if (!current) throw new Error(`[storage] 集合 ${this.name} 中不存在 id=${id}`)
    const next = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() } as T
    const conflict = this.conflictOf(next, id)
    if (conflict) throw new Error(`[storage] 唯一约束冲突（${conflict.label}）：与既有记录 ${conflict.existing.id} 重复`)
    this.records.set(id, next)
    this.emit({ kind: 'update', record: next })
    this.persist(this.name)
    return structuredClone(next)
  }

  remove(id: string): boolean {
    const existed = this.records.delete(id)
    if (existed) {
      this.emit({ kind: 'remove', record: { id } as T })
      this.persist(this.name)
    }
    return existed
  }

  replaceAll(records: T[]): void {
    this.records.clear()
    for (const record of records) this.records.set(record.id, record)
    this.persist(this.name)
    this.emit({ kind: 'replace', record: {} as T })
  }

  /** 恢复磁盘数据（仅启动期调用）。 */
  loadFrom(records: T[]): void {
    this.records.clear()
    for (const record of records) this.records.set(record.id, record)
  }

  count(): number {
    return this.records.size
  }

  onChange(cb: (change: CollectionChange<T>) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(change: CollectionChange<T>): void {
    for (const cb of this.listeners) {
      try {
        cb(change)
      } catch (error) {
        console.error(`[storage] ${this.name} 变更监听器异常`, error)
      }
    }
  }
}

export class StorageService extends Service {
  static readonly provide = 'opsStorage'

  private collections = new Map<string, CollectionImpl<RecordBase>>()
  private durableNames = new Set<string>()
  private dirty = new Set<string>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  /** 落盘串行链（并发 flushNow 排队执行，避免同名 tmp 竞争）。 */
  private flushChain: Promise<void> = Promise.resolve()
  private tmpSeq = 0
  /** 恢复期发现的损坏文件（坏 JSON 已备份为 *.corrupt，启动日志有痕）。 */
  readonly corruptFiles: string[] = []
  /** 数据目录（密钥等平台级文件的存放处）。 */
  readonly dataDirPath: string

  constructor(ctx: Context, config: StorageConfig = {}) {
    super(ctx, 'opsStorage')
    this.dataDirPath = config.dataDir ?? join(process.cwd(), "data")
    ctx.effect(() => () => {
      if (this.flushTimer) clearTimeout(this.flushTimer)
      void this.flushNow()
    })
    this.installSignalFlush()
  }

  /**
   * 信号落盘钩子（form B 数据安全）：form A 的 main.ts 自带 SIGTERM/SIGINT → flushNow，
   * 但挂载进 dsh 宿主后（loader 装配）没有等价钩子——防抖窗口内的写会在进程被
   * SIGTERM（launchd kickstart / pkill）时丢失，且 SQLite（即时写）与 JSON 集合
   * （防抖写）不同步会造成「半套数据」启动态。基础层自装一次（跨形态生效）；
   * 双注册无害（form A main.ts 的处理器并存：flushChain 串行 + exit 幂等）。
   */
  private installSignalFlush(): void {
    const proc = process as unknown as NodeJS.Process & Record<string, unknown>
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const guard = `__rqStorageFlushInstalled_${signal}`
      if (proc[guard] === true) continue
      proc[guard] = true
      process.on(signal, () => {
        void this.flushNow().finally(() => process.exit(0))
      })
    }
  }

  async start(): Promise<void> {
    await mkdir(this.dataDirPath, { recursive: true })
  }

  collection<T extends RecordBase>(name: string, options: CollectionOptions = {}): Collection<T> {
    if (options.durability === 'durable') this.durableNames.add(name)
    const existing = this.collections.get(name)
    if (existing) return existing as unknown as Collection<T>
    const created = new CollectionImpl<T>(name, (n) => this.onPersist(n))
    this.collections.set(name, created as unknown as CollectionImpl<RecordBase>)
    return created
  }

  private onPersist(name: string): void {
    if (this.durableNames.has(name)) {
      // 关键集合：跳过防抖窗口立即落盘（评审 S 系列：吊销返回 200 后崩溃不得丢失）
      this.dirty.add(name)
      void this.flushNow()
      return
    }
    this.markDirty(name)
  }

  /** 启动期从磁盘恢复指定集合（幂等）。坏 JSON 备份为 *.corrupt 后从空集合开始（不再静默清空）。 */
  async restore<T extends RecordBase>(name: string): Promise<Collection<T>> {
    await mkdir(this.dataDirPath, { recursive: true })
    const collection = this.collection<T>(name)
    const file = join(this.dataDirPath, `${fileNameOf(name)}.json`)
    let records: T[] = []
    try {
      const raw = await readFile(file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) {
        // 平台级文件（如 oidc-keys.json 密钥对象）不是集合：静默跳过，不算损坏
        records = []
      } else {
        records = parsed as T[]
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        records = []
      } else {
        // 文件存在但损坏：保留现场（*.corrupt 备份），显式告警，绝不无痕当空集合
        const backup = `${file}.corrupt-${Date.now()}`
        try {
          await copyFile(file, backup)
        } catch { /* 备份失败不阻断启动，下方仍有错误日志 */
        }
        console.error(`[storage] 集合 ${name} 文件损坏（${error instanceof Error ? error.message : String(error)}），已备份至 ${backup}，从空集合恢复`)
        this.corruptFiles.push(backup)
        records = []
      }
    }
    ;(collection as unknown as CollectionImpl<T>).loadFrom(records)
    return collection
  }

  /** 扫描数据目录并恢复全部集合（业务插件加载前调用一次）。 */
  async restoreAll(): Promise<string[]> {
    await mkdir(this.dataDirPath, { recursive: true })
    const restored: string[] = []
    let files: string[] = []
    try {
      files = (await readdir(this.dataDirPath)).filter((file) => file.endsWith('.json'))
    } catch {
      return restored
    }
    for (const file of files) {
      const name = decodeFileName(file.slice(0, -5))
      try {
        await this.restore(name)
        restored.push(name)
      } catch (error) {
        console.error(`[storage] 恢复集合 ${name} 失败`, error)
      }
    }
    return restored
  }

  /** 已恢复/创建的集合名列表（供平台信息展示）。 */
  names(): string[] {
    return [...this.collections.keys()]
  }

  private markDirty(name: string): void {
    this.dirty.add(name)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flushNow()
    }, 250)
  }

  /** 立即将脏集合落盘（原子写：tmp + fsync + rename；全程串行防并发写同名 tmp）。 */
  flushNow(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.doFlush())
    return this.flushChain
  }

  private async doFlush(): Promise<void> {
    for (;;) {
      const names = [...this.dirty]
      this.dirty.clear()
      if (names.length === 0) return
      for (const name of names) {
        const collection = this.collections.get(name)
        if (!collection) continue
        const file = join(this.dataDirPath, `${fileNameOf(name)}.json`)
        const tmp = `${file}.${process.pid}-${Date.now()}-${++this.tmpSeq}.tmp`
        try {
          await mkdir(dirname(file), { recursive: true })
          const handle = await open(tmp, 'w')
          try {
            await handle.writeFile(JSON.stringify(collection.all(), null, 2), 'utf8')
            await handle.sync()
          } finally {
            await handle.close()
          }
          await rename(tmp, file)
        } catch (error) {
          console.error(`[storage] 集合 ${name} 落盘失败`, error)
        }
      }
      // 落盘期间又有变更（durable 即时触发）：循环直至清空
    }
  }

  /**
   * 全量强持久化：把所有已注册集合写入并 fsync（HTTP 响应前调用，
   * 确保「返回 200 后进程被杀」不丢变更——评审崩溃恢复实验的修复点）。
   */
  async flushDurable(): Promise<void> {
    for (const name of this.collections.keys()) this.dirty.add(name)
    await this.flushNow()
  }
}


/** 集合名 → 文件名（Windows 保留字符转义）。 */
function fileNameOf(name: string): string {
  return name.replace(/[:*?"<>|]/g, '~')
}

function decodeFileName(name: string): string {
  return name.replace(/~/g, ':')
}
