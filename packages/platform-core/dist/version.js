import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const PLATFORM_PACKAGE = "@01men/gate-01";
let cached;
function platformVersionInfo() {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  let rootDir = "";
  for (let depth = 0; depth < 8; depth++) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
    }
    if (pkg) {
      if (!rootDir) rootDir = dir;
      if (pkg.name === PLATFORM_PACKAGE) {
        rootDir = dir;
        break;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!rootDir) rootDir = dir;
  let version = "0.0.0";
  try {
    version = String(JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")).version ?? "0.0.0");
  } catch {
  }
  const gitPath = join(rootDir, ".git");
  let hasGit = false;
  try {
    hasGit = existsSync(gitPath) && (statSync(gitPath).isDirectory() || statSync(gitPath).isFile());
  } catch {
  }
  cached = { rootDir, version, installMode: hasGit ? "source" : "bundle" };
  return cached;
}
function readRootVersion(rootDir) {
  try {
    return String(JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}
function platformVersion() {
  return platformVersionInfo().version;
}
function platformRootDir() {
  return platformVersionInfo().rootDir;
}
function platformInstallMode() {
  return platformVersionInfo().installMode;
}
export {
  PLATFORM_PACKAGE,
  platformInstallMode,
  platformRootDir,
  platformVersion,
  platformVersionInfo,
  readRootVersion
};
