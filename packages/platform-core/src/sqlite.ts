/**
 * 事务型存储：计量与资金类数据的专用底座（生态设计 v1.2 第 0 步，S1 消解）。
 *
 * 与 JSON 集合存储（storage.ts）的分工：
 *   - storage  ：业务配置/资源数据（防抖落盘足够）
 *   - txnStore ：计量流水 / 资金流水 / 分账分录 —— 只追加、需事务、需引擎级幂等
 *
 * 基于 node:sqlite（Node ≥ 22.5 内置，零依赖）。WAL 模式。
 * 资金类表只允许 INSERT（服务层不暴露 UPDATE/DELETE 于 journal 类表）。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'

export interface TxnStoreConfig {
  /** 数据目录（与 storage 同目录），默认 `<cwd>/data`。 */
  dataDir?: string
}

export type SqlValue = string | number | null

export class SqliteTxnService extends Service {
  static readonly provide = 'txnStore'

  readonly db: DatabaseSync
  readonly file: string

  constructor(ctx: Context, config: TxnStoreConfig = {}) {
    super(ctx, 'txnStore')
    const dataDir = config.dataDir ?? join(process.cwd(), 'data')
    this.file = join(dataDir, 'txnstore.db')
    mkdirSync(dataDir, { recursive: true })
    this.db = new DatabaseSync(this.file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = FULL')
    this.db.exec('PRAGMA foreign_keys = ON')
    ctx.effect(() => () => {
      try {
        this.db.close()
      } catch {
        /* 已关闭 */
      }
    })
  }

  /** 建表（幂等）。columns 为「列名 → 列定义（含类型与约束）」。 */
  ensureTable(name: string, columns: Record<string, string>, options: { primaryKey?: string[]; uniques?: string[][]; indexes?: string[][] } = {}): void {
    const pk = options.primaryKey ?? ['id']
    const cols = Object.entries(columns).map(([key, def]) => `${quoteIdent(key)} ${def}`)
    cols.push(`PRIMARY KEY (${pk.map(quoteIdent).join(', ')})`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${quoteIdent(name)} (${cols.join(', ')})`)
    for (const unique of options.uniques ?? []) {
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(`ux_${name}_${unique.join('_')}`)} ON ${quoteIdent(name)} (${unique.map(quoteIdent).join(', ')})`)
    }
    for (const index of options.indexes ?? []) {
      this.db.exec(`CREATE INDEX IF NOT EXISTS ${quoteIdent(`ix_${name}_${index.join('_')}`)} ON ${quoteIdent(name)} (${index.map(quoteIdent).join(', ')})`)
    }
  }

  /** 插入（主键/唯一索引冲突时静默忽略）。返回是否真正插入。 */
  insertOrIgnore(table: string, row: Record<string, SqlValue>): boolean {
    const keys = Object.keys(row)
    const result = this.db
      .prepare(`INSERT OR IGNORE INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
      .run(...keys.map((key) => row[key] ?? null))
    return Number(result.changes) > 0
  }

  /** 插入（冲突抛错）。 */
  insert(table: string, row: Record<string, SqlValue>): void {
    const keys = Object.keys(row)
    this.db
      .prepare(`INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
      .run(...keys.map((key) => row[key] ?? null))
  }

  /** 按主键更新（仅允许非只追加表使用；journal 类表禁止调用）。 */
  updateByKey(table: string, primaryKey: string[], keyValues: SqlValue[], patch: Record<string, SqlValue>): void {
    const setSql = Object.keys(patch).map((key) => `${quoteIdent(key)} = ?`).join(', ')
    const whereSql = primaryKey.map((key) => `${quoteIdent(key)} = ?`).join(' AND ')
    this.db
      .prepare(`UPDATE ${quoteIdent(table)} SET ${setSql} WHERE ${whereSql}`)
      .run(...Object.values(patch), ...keyValues)
  }

  /** 全表（或按等值条件）查询。 */
  all<T = Record<string, SqlValue>>(table: string, where: Record<string, SqlValue> = {}): T[] {
    const keys = Object.keys(where)
    if (keys.length === 0) return this.db.prepare(`SELECT * FROM ${quoteIdent(table)}`).all() as T[]
    const whereSql = keys.map((key) => `${quoteIdent(key)} = ?`).join(' AND ')
    return this.db.prepare(`SELECT * FROM ${quoteIdent(table)} WHERE ${whereSql}`).all(...keys.map((key) => where[key] ?? null)) as T[]
  }

  one<T = Record<string, SqlValue>>(table: string, where: Record<string, SqlValue>): T | undefined {
    const rows = this.all<T>(table, where)
    return rows[0]
  }

  count(table: string, where: Record<string, SqlValue> = {}): number {
    const keys = Object.keys(where)
    if (keys.length === 0) {
      return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number }).n)
    }
    const whereSql = keys.map((key) => `${quoteIdent(key)} = ?`).join(' AND ')
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)} WHERE ${whereSql}`).get(...keys.map((key) => where[key] ?? null)) as { n: number }
    return Number(row.n)
  }

  /** 原生 SQL（建索引/聚合查询等）。 */
  sql<T = Record<string, SqlValue>>(query: string, params: SqlValue[] = []): T[] {
    return this.db.prepare(query).all(...params) as T[]
  }

  /** 原生写语句（UPDATE/DELETE），返回受影响行数。 */
  run(query: string, params: SqlValue[] = []): number {
    return Number(this.db.prepare(query).run(...params).changes)
  }

  /**
   * 事务：fn 内的全部写入要么全部提交、要么全部回滚。
   * 同步执行（node:sqlite），BEGIN IMMEDIATE 立即取写锁，避免升级死锁。
   */
  txn<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* 连接异常时回滚失败仅记录 */
      }
      throw error
    }
  }
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`非法标识符：${name}`)
  return `"${name}"`
}
