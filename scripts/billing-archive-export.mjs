#!/usr/bin/env node
/**
 * billing 存量资金流水 CSV 封存导出（M0-2，2026-09-09）。
 *
 * plugin-billing 已下线封存：本脚本把 SQLite（data/txnstore.db）中的 wallet_journal /
 * ledger_entries 全量导出为只读 CSV 档案，供 90 天封存期（见 docs/billing-archive-register.md）
 * 内备查。只读操作：仅 SELECT，不写不删，可重复执行（每次生成带时间戳的新档案文件）。
 *
 * 用法：
 *   node scripts/billing-archive-export.mjs [--db <txnstore.db路径>] [--out <输出目录>]
 * 缺省：--db <repo>/data/txnstore.db --out <repo>/data/archive
 * 输出：billing-journal-<UTC日期>.csv 与 billing-ledger-<UTC日期>.csv（UTF-8 BOM，Excel 友好）。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirnameOf(import.meta.url), '..')
function dirnameOf(url) {
  return fileURLToPath(new URL('.', url))
}

function argOf(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const dbPath = resolve(argOf('--db', join(root, 'data', 'txnstore.db')))
const outDir = resolve(argOf('--out', join(root, 'data', 'archive')))
if (!existsSync(dbPath)) {
  console.error(`未找到数据库：${dbPath}（该环境无存量资金流水，无需封存导出）`)
  process.exit(0)
}
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

const db = new DatabaseSync(dbPath, { readOnly: true })
const stamp = new Date().toISOString().slice(0, 10)

const csvCell = (value) => {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function dumpTable(table, columns) {
  const rows = db.prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY rowid`).all()
  const header = columns.join(',')
  const body = rows.map((row) => columns.map((col) => csvCell(row[col])).join(',')).join('\r\n')
  const csv = '\ufeff' + (rows.length > 0 ? `${header}\r\n${body}\r\n` : `${header}\r\n`)
  const file = join(outDir, `${table}-${stamp}.csv`)
  writeFileSync(file, csv, 'utf8')
  console.log(`✓ ${table}: ${rows.length} 行 → ${file}`)
  return rows.length
}

console.log(`封存导出（只读）：${dbPath} → ${outDir}`)
const journalRows = dumpTable('wallet_journal', ['id', 'idempotency_key', 'at', 'tenant_id', 'owner_type', 'owner_id', 'direction', 'amount_cents', 'reason', 'ref_event', 'balance_after_cents'])
const ledgerRows = dumpTable('ledger_entries', ['id', 'period', 'at', 'journal_type', 'ref', 'account', 'direction', 'amount_cents', 'memo', 'rate_version'])
const walletRows = dumpTable('wallets', ['owner_type', 'owner_id', 'tenant_id', 'balance_cents', 'updated_at'])
console.log(`合计：journal=${journalRows} ledger=${ledgerRows} wallets=${walletRows}（余额快照供对账复核）`)
