/**
 * Ed25519 签名基建（M2 平台级筑基，自 plugin-market 抽升）：
 *   - 第三方插件市场五面清单验签（plugin-market.submit）
 *   - 平台自更新发布清单验签（plugin-update，供应链敞口 T5 收口）
 * 共用同一套密钥/签名语义：SPKI DER base64 公钥 + PKCS8 PEM 私钥，对指纹字节做 Ed25519。
 * 私钥只在持有方（开发者 / 发布流水线）本地，平台任何集合只存公钥。
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto'

/** Ed25519 验签：指纹必须由登记公钥签出。任一输入非法一律 false（不抛错，调用方按验签失败处理）。 */
export function verifyEd25519(publicKeyBase64: string, fingerprint: string, signatureBase64: string): boolean {
  try {
    const publicKey = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' })
    return edVerify(null, Buffer.from(fingerprint), publicKey, Buffer.from(signatureBase64, 'base64'))
  } catch {
    return false
  }
}

/** Ed25519 密钥对生成（脚手架/发布流水线自助用；私钥只在调用方持有）。 */
export function generateEd25519KeyPair(): { publicKeyBase64: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  }
}

/** Ed25519 签名（私钥 PEM → 对指纹字节签名，base64）。私钥非法时抛错（发布侧应响亮失败）。 */
export function signEd25519(privateKeyPem: string, fingerprint: string): string {
  const privateKey = createPrivateKey(privateKeyPem)
  return edSign(null, Buffer.from(fingerprint), privateKey).toString('base64')
}

/** 公钥登记格式校验：必须是可解析的 SPKI DER base64（settings 写入口防呆用）。 */
export function isValidEd25519PublicKeyBase64(value: string): boolean {
  try {
    createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' })
    return true
  } catch {
    return false
  }
}
