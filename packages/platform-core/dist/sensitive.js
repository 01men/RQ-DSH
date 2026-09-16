const SENSITIVE_KEY_RE = /(password|passwd|secret|token|apikey|api[_-]?key|access[_-]?key|private[_-]?key|credential|client[_-]?secret)/i;
function scanSensitiveKeys(value, prefix = "") {
  const paths = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, item] of Object.entries(node)) {
        const childPath = path ? `${path}.${key}` : key;
        if (SENSITIVE_KEY_RE.test(key) && item !== null && typeof item !== "object") paths.push(childPath);
        else walk(item, childPath);
      }
    }
  };
  walk(value, prefix);
  return paths;
}
function maskSensitivePayload(value) {
  const maskedKeys = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) return node.map((item, index) => walk(item, `${path}[${index}]`));
    if (node && typeof node === "object") {
      const out = {};
      for (const [key, item] of Object.entries(node)) {
        out[key] = SENSITIVE_KEY_RE.test(key) && item !== null && typeof item !== "object" ? (maskedKeys.push(path ? `${path}.${key}` : key), "***") : walk(item, path ? `${path}.${key}` : key);
      }
      return out;
    }
    return node;
  };
  return { masked: walk(value, ""), maskedKeys };
}
export {
  SENSITIVE_KEY_RE,
  maskSensitivePayload,
  scanSensitiveKeys
};
