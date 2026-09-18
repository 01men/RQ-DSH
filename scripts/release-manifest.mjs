/**
 * 发布清单签名工具（M2 技术债 T5 收口——平台自更新供应链校验的发布侧配套）。
 *
 * 生成 release-manifest.json（随仓库根发布，plugin-update 升级时按目标 commit 拉取验签）：
 *   node scripts/release-manifest.mjs --generate-key --key-file release-key.pem   # 首次：生成发布密钥对
 *   node scripts/release-manifest.mjs --key-file release-key.pem                  # 发布时：生成签名清单
 *   node scripts/release-manifest.mjs --check --out release-manifest.json --pubkey <base64>  # 管理员侧校验
 *
 * 私钥只在发布方（--key-file 或 env RELEASE_SIGNING_KEY），绝不入库/入平台；
 * 公钥由管理员登记进平台更新设置（POST /api/update/settings.releasePublicKey）。
 * 签名对象 = 目标 commit 全长 SHA（版本钉扎已解析出该值，验「commit 被发布密钥签过」即供应链校验）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateEd25519KeyPair, signEd25519, verifyEd25519 } from '../packages/platform-core/src/index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function argOf(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const fail = (message) => { console.error(`✘ ${message}`); process.exit(1) }

const keyFile = argOf('--key-file')
const out = argOf('--out') ?? 'release-manifest.json'

// --check 只需公钥（管理员侧复核产物；私钥不必在场）
if (process.argv.includes('--check')) {
  const publicKey = process.env.RELEASE_SIGNING_PUBKEY ?? argOf('--pubkey')
  if (!publicKey) fail('--check 需要 --pubkey <base64> 或 env RELEASE_SIGNING_PUBKEY（登记进平台的那个公钥）')
  const path = resolve(root, out)
  if (!existsSync(path)) fail(`清单不存在：${out}`)
  const existing = JSON.parse(readFileSync(path, 'utf8'))
  const commit = (argOf('--commit') ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).trim()
  const ok = existing.commit === commit && verifyEd25519(String(publicKey), String(existing.commit), existing.signature)
  if (!ok) fail('清单校验未通过（commit 不一致或签名无效）')
  console.log(`✔ 清单校验通过：version=${existing.version} commit=${String(existing.commit).slice(0, 12)}…`)
  process.exit(0)
}

if (process.argv.includes('--generate-key')) {
  if (!keyFile) fail('--generate-key 需要 --key-file 指定私钥保存路径')
  if (existsSync(keyFile)) fail(`私钥文件已存在，拒绝覆盖：${keyFile}`)
  const keys = generateEd25519KeyPair()
  writeFileSync(keyFile, keys.privateKeyPem, { mode: 0o600 })
  console.log(`✔ 发布密钥对已生成：私钥 ${keyFile}（0600，绝不入库/上传）`)
  console.log('  公钥（登记到平台：POST /api/update/settings {"releasePublicKey": "..."}）：')
  console.log(`  ${keys.publicKeyBase64}`)
  process.exit(0)
}

const privateKeyPem = keyFile
  ? (existsSync(keyFile) ? readFileSync(keyFile, 'utf8') : fail(`私钥文件不存在：${keyFile}`))
  : (process.env.RELEASE_SIGNING_KEY ?? fail('缺少私钥：--key-file <path> 或 env RELEASE_SIGNING_KEY（首次用 --generate-key 生成）'))

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = argOf('--version') ?? pkg.version
const commit = (argOf('--commit') ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).trim()
if (!/^[0-9a-f]{40}$/.test(commit)) fail(`commit 非全长 SHA：${commit}`)

const manifest = {
  algorithm: 'ed25519',
  version,
  commit,
  signedAt: new Date().toISOString(),
  signature: signEd25519(privateKeyPem, commit),
}

writeFileSync(resolve(root, out), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`✔ 发布清单已生成：${out}`)
console.log(`  version=${version} commit=${commit.slice(0, 12)}…`)
console.log('  提交该文件到仓库根随版本发布；管理员侧登记公钥并在升级设置开启 requireSignedManifests。')
