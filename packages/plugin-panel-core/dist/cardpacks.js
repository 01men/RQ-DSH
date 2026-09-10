import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Service } from "@deepseek-ai/cordis";
const CARDPACK_HOME_LIMIT = 6;
const CARD_PLATFORMS = ["strategy", "marketing", "manufacturing", "rd", "quality"];
const CARD_BADGES = ["skill", "app", "mcp", "nas", "kb", "data", "model", "agent"];
function validateCardpack(input, source = "cardpack") {
  const errors = [];
  const pack = input;
  if (pack === null || typeof pack !== "object") return [`${source}: \u4E0D\u662F JSON \u5BF9\u8C61`];
  if (!CARD_PLATFORMS.includes(pack.platform)) {
    errors.push(`${source}: platform \u975E\u6CD5\uFF08\u5E94\u4E3A ${CARD_PLATFORMS.join("/")}\uFF0C\u6536\u5230 ${String(pack.platform)}\uFF09`);
  }
  if (!Array.isArray(pack.roles) || pack.roles.length === 0) errors.push(`${source}: roles \u5FC5\u586B\u4E14\u975E\u7A7A\uFF08'*' \u8868\u793A\u5168\u5458\uFF09`);
  if (!Array.isArray(pack.cards) || pack.cards.length === 0) {
    errors.push(`${source}: cards \u5FC5\u586B\u4E14\u975E\u7A7A`);
    return errors;
  }
  const seen = /* @__PURE__ */ new Set();
  pack.cards.forEach((card, index) => {
    const at = `${source}: cards[${index}]`;
    if (!card?.id || typeof card.id !== "string") errors.push(`${at}.id \u5FC5\u586B`);
    else if (seen.has(card.id)) errors.push(`${at}.id \u91CD\u590D\uFF1A${card.id}`);
    else seen.add(card.id);
    if (!card?.title || typeof card.title !== "string") errors.push(`${at}.title \u5FC5\u586B`);
    if (!card?.description || typeof card.description !== "string" || card.description.length > 60) {
      errors.push(`${at}.description \u5FC5\u586B\u4E14 \u226460 \u5B57\uFF08\u4E00\u53E5\u8BDD\u8BF4\u660E\uFF09`);
    }
    if (!CARD_BADGES.includes(card?.badge)) errors.push(`${at}.badge \u975E\u6CD5\uFF08\u5E94\u4E3A ${CARD_BADGES.join("/")}\uFF09`);
    if (!card?.href || typeof card.href !== "string") errors.push(`${at}.href \u5FC5\u586B`);
    if (card?.ref !== void 0 && !/^[a-z][a-z0-9]*:[A-Za-z0-9._\p{L}-]+$/u.test(String(card.ref))) {
      errors.push(`${at}.ref \u683C\u5F0F\u975E\u6CD5\uFF08\u5E94\u4E3A type:idOrSlug\uFF0C\u6536\u5230 ${String(card.ref)}\uFF09`);
    }
  });
  return errors;
}
function packVisibleForRoles(pack, roles) {
  return pack.roles.includes("*") || pack.roles.some((role) => roles.includes(role));
}
function filterCards(input) {
  const refAlive = input.refAlive ?? (() => true);
  const limit = input.limit ?? CARDPACK_HOME_LIMIT;
  const droppedDeadRefs = [];
  const byId = /* @__PURE__ */ new Map();
  for (const pack of input.packs.filter((pack2) => packVisibleForRoles(pack2, input.roles))) {
    for (const card of pack.cards) {
      if (card.ref !== void 0 && !refAlive(card.ref)) {
        droppedDeadRefs.push(card.ref);
        continue;
      }
      if (!byId.has(card.id)) byId.set(card.id, { ...card, order: card.order ?? 9999 });
    }
  }
  const cards = [...byId.values()].sort((a, b) => a.order - b.order).slice(0, limit);
  return { cards, droppedDeadRefs };
}
function defaultCardpackDir() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "cardpacks");
}
class CardpackService extends Service {
  static provide = "cardpacks";
  packs = [];
  loadErrors = [];
  refAliveResolver;
  constructor(ctx, config = {}) {
    super(ctx, "cardpacks");
    void this.loadFromDir(config.dir ?? process.env.CARDPACK_DIR ?? defaultCardpackDir());
  }
  /** 装载目录内全部 *.json：单文件非法跳过并记录（不阻断启动），lint:manifests 负责红线。 */
  async loadFromDir(dir) {
    const errors = [];
    const packs = [];
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      this.loadErrors = [`${dir} \u4E0D\u53EF\u8BFB\uFF08\u65E0\u5361\u7247\u5305\uFF09`];
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(dir, entry.name), "utf8"));
        const packErrors = validateCardpack(parsed, entry.name);
        if (packErrors.length > 0) {
          errors.push(...packErrors);
          continue;
        }
        packs.push(parsed);
      } catch (error) {
        errors.push(`${entry.name}: JSON \u89E3\u6790\u5931\u8D25\uFF08${error instanceof Error ? error.message : String(error)}\uFF09`);
      }
    }
    this.packs = packs;
    this.loadErrors = errors;
    if (errors.length > 0) this.ctx.logger("cardpacks").warn(`\u5361\u7247\u5305\u88C5\u8F7D\u5B58\u5728\u88AB\u8DF3\u8FC7\u7684\u6587\u4EF6\uFF1A${errors.join("\uFF1B")}`);
  }
  all() {
    return this.packs;
  }
  forPlatform(platform) {
    return this.packs.filter((pack) => pack.platform === platform);
  }
  /** 注入资产 ref 存活性解析器（console 装配时用 iam/resourceCore/skillhub/mcp 构建）。 */
  setRefAliveResolver(resolver) {
    this.refAliveResolver = resolver;
  }
  refAlive(ref) {
    return this.refAliveResolver ? this.refAliveResolver(ref) : true;
  }
  /** 装载期被跳过文件的问题清单（坏 JSON / schema 违规），观测用。 */
  loadProblems() {
    return this.loadErrors;
  }
}
export {
  CARDPACK_HOME_LIMIT,
  CARD_BADGES,
  CARD_PLATFORMS,
  CardpackService,
  defaultCardpackDir,
  filterCards,
  packVisibleForRoles,
  validateCardpack
};
