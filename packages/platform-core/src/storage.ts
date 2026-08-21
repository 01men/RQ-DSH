/**
 * 存储抽象：JSON 集合 + 内存索引 + 防抖原子落盘。
 * 业务插件只面对 Collection API，不感知文件系统；替换为数据库实现时只需重写本服务。
 */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
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
  static readonly provide = 'storage'

  private collections = new Map<string, CollectionImpl<RecordBase>>()
  private dirty = new Set<string>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  /** 数据目录（密钥等平台级文件的存放处）。 */
  readonly dataDirPath: string

  constructor(ctx: Context, config: StorageConfig = {}) {
    super(ctx, 'storage')
    this.dataDirPath = config.dataDir ?? join(process.cwd(), "data")
    ctx.effect(() => () => {
      if (this.flushTimer) clearTimeout(this.flushTimer)
      void this.flushNow()
    })
  }

  async start(): Promise<void> {
    await mkdir(this.dataDirPath, { recursive: true })
  }

  collection<T extends RecordBase>(name: string): Collection<T> {
    const existing = this.collections.get(name)
    if (existing) return existing as unknown as Collection<T>
    const created = new CollectionImpl<T>(name, (n) => this.markDirty(n))
    this.collections.set(name, created as unknown as CollectionImpl<RecordBase>)
    return created
  }

  /** 启动期从磁盘恢复指定集合（幂等）。 */
  async restore<T extends RecordBase>(name: string): Promise<Collection<T>> {
    await mkdir(this.dataDirPath, { recursive: true })
    const collection = this.collection<T>(name)
    let records: T[] = []
    try {
      const raw = await readFile(join(this.dataDirPath, `${fileNameOf(name)}.json`), 'utf8')
      records = JSON.parse(raw) as T[]
    } catch {
      records = []
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

  /** 立即将脏集合落盘（原子写：tmp + rename）。 */
  async flushNow(): Promise<void> {
    const names = [...this.dirty]
    this.dirty.clear()
    for (const name of names) {
      const collection = this.collections.get(name)
      if (!collection) continue
      const file = join(this.dataDirPath, `${fileNameOf(name)}.json`)
      try {
        await mkdir(dirname(file), { recursive: true })
        const tmp = `${file}.tmp`
        await writeFile(tmp, JSON.stringify(collection.all(), null, 2), 'utf8')
        await rename(tmp, file)
      } catch (error) {
        console.error(`[storage] 集合 ${name} 落盘失败`, error)
      }
    }
  }
}


/** 集合名 → 文件名（Windows 保留字符转义）。 */
function fileNameOf(name: string): string {
  return name.replace(/[:*?"<>|]/g, '~')
}

function decodeFileName(name: string): string {
  return name.replace(/~/g, ':')
}
