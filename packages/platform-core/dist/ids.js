import { createHash, randomBytes } from "node:crypto";
let counter = Math.floor(Math.random() * 1e6);
function newId(prefix) {
  const t = Date.now().toString(36);
  const r = (counter++).toString(36);
  const rand = Math.floor(Math.random() * 1679616).toString(36);
  return `${prefix}_${t}${r.padStart(4, "0")}${rand.padStart(4, "0")}`;
}
function slugify(name) {
  return name.toLowerCase().replace(/[\s_]+/g, "-").replace(/[^\p{L}\p{N}-]+/gu, "").replace(/-+/g, "-").replace(/^-|-$/g, "") || newId("slug");
}
function mask(value, keep = 3) {
  if (!value) return "";
  if (value.length <= keep * 2) return "*".repeat(value.length);
  return value.slice(0, keep) + "*".repeat(Math.min(8, value.length - keep * 2)) + value.slice(-keep);
}
function generateSecret(prefix = "sk") {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}
function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}
export {
  generateSecret,
  mask,
  newId,
  sha256Hex,
  slugify
};
