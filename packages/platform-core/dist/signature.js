import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
function verifyEd25519(publicKeyBase64, fingerprint, signatureBase64) {
  try {
    const publicKey = createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
    return edVerify(null, Buffer.from(fingerprint), publicKey, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}
function generateEd25519KeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString()
  };
}
function signEd25519(privateKeyPem, fingerprint) {
  const privateKey = createPrivateKey(privateKeyPem);
  return edSign(null, Buffer.from(fingerprint), privateKey).toString("base64");
}
function isValidEd25519PublicKeyBase64(value) {
  try {
    createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
    return true;
  } catch {
    return false;
  }
}
export {
  generateEd25519KeyPair,
  isValidEd25519PublicKeyBase64,
  signEd25519,
  verifyEd25519
};
