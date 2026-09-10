import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Service } from "@deepseek-ai/cordis";
class SqliteTxnService extends Service {
  static provide = "txnStore";
  db;
  file;
  constructor(ctx, config = {}) {
    super(ctx, "txnStore");
    const dataDir = config.dataDir ?? join(process.cwd(), "data");
    this.file = join(dataDir, "txnstore.db");
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA foreign_keys = ON");
    ctx.effect(() => () => {
      try {
        this.db.close();
      } catch {
      }
    });
  }
  /** 建表（幂等）。columns 为「列名 → 列定义（含类型与约束）」。 */
  ensureTable(name, columns, options = {}) {
    const pk = options.primaryKey ?? ["id"];
    const cols = Object.entries(columns).map(([key, def]) => `${quoteIdent(key)} ${def}`);
    cols.push(`PRIMARY KEY (${pk.map(quoteIdent).join(", ")})`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${quoteIdent(name)} (${cols.join(", ")})`);
    for (const unique of options.uniques ?? []) {
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(`ux_${name}_${unique.join("_")}`)} ON ${quoteIdent(name)} (${unique.map(quoteIdent).join(", ")})`);
    }
    for (const index of options.indexes ?? []) {
      this.db.exec(`CREATE INDEX IF NOT EXISTS ${quoteIdent(`ix_${name}_${index.join("_")}`)} ON ${quoteIdent(name)} (${index.map(quoteIdent).join(", ")})`);
    }
  }
  /** 插入（主键/唯一索引冲突时静默忽略）。返回是否真正插入。 */
  insertOrIgnore(table, row) {
    const keys = Object.keys(row);
    const result = this.db.prepare(`INSERT OR IGNORE INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((key) => row[key] ?? null));
    return Number(result.changes) > 0;
  }
  /** 插入（冲突抛错）。 */
  insert(table, row) {
    const keys = Object.keys(row);
    this.db.prepare(`INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((key) => row[key] ?? null));
  }
  /** 按主键更新（仅允许非只追加表使用；journal 类表禁止调用）。 */
  updateByKey(table, primaryKey, keyValues, patch) {
    const setSql = Object.keys(patch).map((key) => `${quoteIdent(key)} = ?`).join(", ");
    const whereSql = primaryKey.map((key) => `${quoteIdent(key)} = ?`).join(" AND ");
    this.db.prepare(`UPDATE ${quoteIdent(table)} SET ${setSql} WHERE ${whereSql}`).run(...Object.values(patch), ...keyValues);
  }
  /** 全表（或按等值条件）查询。 */
  all(table, where = {}) {
    const keys = Object.keys(where);
    if (keys.length === 0) return this.db.prepare(`SELECT * FROM ${quoteIdent(table)}`).all();
    const whereSql = keys.map((key) => `${quoteIdent(key)} = ?`).join(" AND ");
    return this.db.prepare(`SELECT * FROM ${quoteIdent(table)} WHERE ${whereSql}`).all(...keys.map((key) => where[key] ?? null));
  }
  one(table, where) {
    const rows = this.all(table, where);
    return rows[0];
  }
  count(table, where = {}) {
    const keys = Object.keys(where);
    if (keys.length === 0) {
      return Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get().n);
    }
    const whereSql = keys.map((key) => `${quoteIdent(key)} = ?`).join(" AND ");
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)} WHERE ${whereSql}`).get(...keys.map((key) => where[key] ?? null));
    return Number(row.n);
  }
  /** 原生 SQL（建索引/聚合查询等）。 */
  sql(query, params = []) {
    return this.db.prepare(query).all(...params);
  }
  /** 原生写语句（UPDATE/DELETE），返回受影响行数。 */
  run(query, params = []) {
    return Number(this.db.prepare(query).run(...params).changes);
  }
  /**
   * 事务：fn 内的全部写入要么全部提交、要么全部回滚。
   * 同步执行（node:sqlite），BEGIN IMMEDIATE 立即取写锁，避免升级死锁。
   */
  txn(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
  }
}
function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`\u975E\u6CD5\u6807\u8BC6\u7B26\uFF1A${name}`);
  return `"${name}"`;
}
export {
  SqliteTxnService
};
