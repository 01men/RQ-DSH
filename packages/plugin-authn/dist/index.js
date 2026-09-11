import { createHmac, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import {
  PlatformEvents,
  generateSecret,
  newId,
  sha256Hex
} from "../../platform-core/dist/index.js";
import { PermissionCatalog } from "../../plugin-iam/dist/index.js";
import * as authnTools from "./tools.js";
import { OidcService } from "./oidc.js";
import { EntryTicketService } from "./entry-ticket.js";
export * from "./oidc.js";
export * from "./entry-ticket.js";
const ACCESS_TTL_MS = 30 * 6e4;
const REFRESH_TTL_MS = 7 * 24 * 36e5;
const REFRESH_GRACE_MS = 3e4;
const REFRESH_GRACE_MAX_REDEMPTIONS = 10;
const SECRET_GRACE_MS = 24 * 36e5;
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 6e4;
const LOGIN_BASE_LOCK_MS = 15 * 6e4;
const LOGIN_MAX_LOCK_MS = 24 * 36e5;
class AuthnService extends Service {
  static provide = "authn";
  signingSecret;
  /** 已退役但仍在宽限期内的签名密钥（验签兼容旧令牌）。 */
  retiredSecrets = [];
  refreshIndex = /* @__PURE__ */ new Map();
  cleanupTimer;
  constructor(ctx) {
    super(ctx, "authn");
    this.ctx.opsStorage.collection("authn:tokens", { durability: "durable" });
    this.ctx.opsStorage.collection("authn:loginAttempts", { durability: "durable" });
    this.ctx.opsStorage.collection("authn:principals", { durability: "durable" });
    this.signingSecret = this.loadOrCreateSecret();
    this.loadRetiredSecrets();
    for (const token of this.tokens().all()) {
      if (token.kind === "refresh" && token.refreshHash) this.refreshIndex.set(token.refreshHash, token.id);
    }
    this.tokens().onChange((change) => {
      const hash = change.record.refreshHash;
      if (!hash) return;
      if (change.kind === "remove") this.refreshIndex.delete(hash);
      else this.refreshIndex.set(hash, change.record.id);
    });
    this.cleanupExpiredTokens();
    this.cleanupTimer = setInterval(() => this.cleanupExpiredTokens(), 36e5);
    ctx.effect(() => {
      if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    });
    ctx.platformBus.on(PlatformEvents.UserFrozen, (payload) => {
      const { userId, reason } = payload;
      const principal = this.humanPrincipal(userId);
      if (principal) this.revokePrincipalTokens(principal.id, `\u8D26\u53F7\u51BB\u7ED3\u8054\u52A8\uFF1A${reason}`);
    });
    ctx.platformBus.on(PlatformEvents.AgentOfflined, (payload) => {
      const { id } = payload;
      for (const principal of this.principals().find((item) => item.refType === "agent" && item.refId === id)) {
        this.disablePrincipal(principal.id, "Agent \u4E0B\u7EBF\u8054\u52A8");
      }
    });
    ctx.platformBus.on(PlatformEvents.AppOfflined, (payload) => {
      const { id } = payload;
      for (const principal of this.principals().find((item) => item.refType === "app" && item.refId === id)) {
        this.disablePrincipal(principal.id, "\u5E94\u7528\u4E0B\u7EBF\u8054\u52A8");
      }
    });
  }
  principals() {
    return this.ctx.opsStorage.collection("authn:principals");
  }
  /** OAuth state（防 CSRF，一次性消费，10 分钟有效）。 */
  oauthStates() {
    return this.ctx.opsStorage.collection("authn:oauthStates");
  }
  /** 三方登录未命中时的待绑定票据（5 分钟有效，一次性）。 */
  ssoTickets() {
    return this.ctx.opsStorage.collection("authn:ssoTickets");
  }
  // -- 会话令牌对（access + refresh 轮转链） --------------------------------
  /** 签发会话令牌对：access（30min）+ refresh（7d，仅存哈希，单次轮转）。 */
  issueSessionPair(principalId, options) {
    const sid = options.sid ?? newId("sid");
    const chainId = options.chainId ?? newId("chn");
    const access = this.issueToken(principalId, {
      kind: "access",
      ttlHours: ACCESS_TTL_MS / 36e5,
      issuedBy: options.issuedBy,
      sid,
      chainId
    });
    const refreshRaw = "dstr_" + randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    const refreshJti = randomUUID();
    this.tokens().insert({
      id: refreshJti,
      jti: refreshJti,
      principalId,
      kind: "refresh",
      scopes: [],
      actChain: [],
      issuedAt: (/* @__PURE__ */ new Date()).toISOString(),
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS).toISOString(),
      issuedBy: options.issuedBy,
      sid,
      chainId,
      refreshHash: sha256Hex(refreshRaw)
    });
    return { token: access.token, refreshToken: refreshRaw, access: access.record, sid };
  }
  /**
   * 刷新会话：校验 refresh 哈希 → 重放检测（已轮转的 refresh 再现 → 吊销整链）。
   * 宽限契约（H3/T-08）：轮转后 REFRESH_GRACE_MS 内旧 token 再现不判重放，签发同链兄弟对
   * （各标签此后各持独立令牌、后续轮转互不影响）；窗口外再现仍整链吊销。响应形状不变
   * （{token, refreshToken, sid}），消费方无需改动即获得多标签自愈。
   */
  refreshSession(refreshToken) {
    const hash = sha256Hex(refreshToken);
    const recordId = this.refreshIndex.get(hash);
    const record = recordId ? this.tokens().get(recordId) : void 0;
    if (!record || record.kind !== "refresh") throw new Error("refresh token \u65E0\u6548");
    if (record.revokedAt) throw new Error("refresh token \u5DF2\u540A\u9500\uFF1A" + (record.revokedReason ?? ""));
    if (new Date(record.expiresAt).getTime() < Date.now()) throw new Error("refresh token \u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
    if (record.rotatedAt) {
      const rotatedAtMs = new Date(record.rotatedAt).getTime();
      const withinGrace = Date.now() - rotatedAtMs <= REFRESH_GRACE_MS;
      const redemptions = record.graceRedemptions ?? 0;
      if (withinGrace) {
        if (redemptions < REFRESH_GRACE_MAX_REDEMPTIONS) {
          this.tokens().update(record.id, { graceRedemptions: redemptions + 1 });
          return this.issueSessionPair(record.principalId, {
            sid: record.sid,
            chainId: record.chainId,
            issuedBy: "refresh-grace"
          });
        }
        throw new Error(`refresh token \u5BBD\u9650\u5151\u6362\u5DF2\u8FBE\u4E0A\u9650\uFF08${REFRESH_GRACE_MAX_REDEMPTIONS} \u6B21\uFF09\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55`);
      }
      this.revokeChain(record.chainId ?? "", "refresh token \u91CD\u653E\u68C0\u6D4B\uFF08\u539F\u8F6E\u8F6C\u4E8E " + record.rotatedAt + "\uFF09");
      throw new Error("\u68C0\u6D4B\u5230 refresh token \u91CD\u653E\uFF1A\u8BE5\u4F1A\u8BDD\u6574\u94FE\u5DF2\u540A\u9500\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
    }
    this.tokens().update(record.id, { rotatedAt: (/* @__PURE__ */ new Date()).toISOString() });
    return this.issueSessionPair(record.principalId, {
      sid: record.sid,
      chainId: record.chainId,
      issuedBy: "refresh-rotation"
    });
  }
  /** 按链吊销全部令牌。 */
  revokeChain(chainId, reason) {
    let count = 0;
    for (const token of this.tokens().find((item) => item.chainId === chainId && !item.revokedAt)) {
      this.revokeToken(token.jti, reason);
      count++;
    }
    return count;
  }
  /** 按会话吊销（登出/封禁/改密即时生效）。 */
  revokeSession(sid, reason) {
    let count = 0;
    for (const token of this.tokens().find((item) => item.sid === sid && !item.revokedAt)) {
      this.revokeToken(token.jti, reason);
      count++;
    }
    return count;
  }
  // -- 三方登录（IdentityProviderAdapter 链路，融合 auth-identity docs/03/04）--
  /**
   * 发起三方授权：生成一次性 state，返回授权地址。
   * 钉钉等真实 IdP 要求 redirect_uri 为绝对 URL，origin 由调用方从请求头推导后传入；
   * 缺省时回落相对路径（仅本地/mock 链路可用）。
   * options.purpose='bind' 时用于「已登录账号扫码绑定三方身份」：state 锁定目标 userId，
   * 回调由 GET /api/auth/sso/callback 承接（与登录用途隔离，见 completeSso）。
   * options.configId 指定多主体连接器实例：按其适配器发起授权并记入 state，回调按实例解析。
   * options.promptConsent=true 时强制 IdP 弹授权确认页（刷新老用户授权快照，见 providers.ts）。
   */
  async beginSso(provider, scene, origin, options = {}) {
    const adapter = options.configId !== void 0 ? this.ctx.iam.getAuthProviderByConfig(options.configId) : this.ctx.iam.getAuthProvider(provider);
    if (options.configId !== void 0 && adapter.type !== provider) {
      throw new Error(`\u8FDE\u63A5\u5668\u5B9E\u4F8B\uFF08${options.configId}\uFF09\u5E73\u53F0\u7C7B\u578B ${adapter.type} \u4E0E\u8BF7\u6C42 provider ${provider} \u4E0D\u4E00\u81F4`);
    }
    const state = randomUUID().replace(/-/g, "");
    this.oauthStates().insert({
      id: state,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      provider,
      ...options.configId !== void 0 ? { configId: options.configId } : {},
      scene,
      purpose: options.purpose ?? "login",
      ...options.userId !== void 0 ? { userId: options.userId } : {}
    });
    const configured = (options.configId !== void 0 ? this.ctx.iam.connectorConfigById(options.configId)?.callbackUrl : this.ctx.iam.connectorConfig(provider)?.callbackUrl)?.trim();
    const redirectUri = configured || (origin ? `${origin.replace(/\/+$/, "")}/api/auth/sso/callback` : "/api/auth/sso/callback");
    return { authorizeUrl: await adapter.buildAuthorizeUrl(scene, state, redirectUri, { promptConsent: options.promptConsent ?? false }), state };
  }
  /**
   * 完成三方登录：state 一次性消费 → Adapter 链（exchangeCode/getUserInfo/normalizeProfile）
   * → 命中身份链接直接登录；未命中签发待绑定票据（绑定已有账号 / 注册新账号两分支）。
   */
  async completeSso(provider, code, state) {
    const stateRecord = this.oauthStates().get(state);
    if (!stateRecord) throw new Error("state \u65E0\u6548\uFF08\u672A\u53D1\u8D77\u6388\u6743\u6216\u5DF2\u6D88\u8D39\uFF09");
    if (stateRecord.consumedAt) throw new Error("state \u5DF2\u88AB\u4F7F\u7528\uFF08\u9632\u91CD\u653E\uFF09");
    if (stateRecord.purpose === "bind") throw new Error("state \u7528\u9014\u4E3A\u8D26\u53F7\u7ED1\u5B9A\uFF0C\u4E0D\u80FD\u7528\u4E8E\u767B\u5F55");
    if (Date.now() - new Date(stateRecord.createdAt).getTime() > 10 * 6e4) throw new Error("state \u5DF2\u8FC7\u671F");
    this.oauthStates().update(state, { consumedAt: (/* @__PURE__ */ new Date()).toISOString() });
    const ssoProvider = stateRecord.provider;
    const adapter = stateRecord.configId ? this.ctx.iam.getAuthProviderByConfig(stateRecord.configId) : this.ctx.iam.getAuthProvider(ssoProvider);
    const tokenSet = await adapter.exchangeCode(code);
    const raw = await adapter.getUserInfo(tokenSet);
    const profile = adapter.normalizeProfile(raw);
    const link = this.ctx.iam.findLinkByProfile(ssoProvider, profile.providerUserId, profile.corpId);
    if (link) {
      const user = this.ctx.iam.users().get(link.userId);
      if (!user) throw new Error("\u8EAB\u4EFD\u94FE\u63A5\u6307\u5411\u7684\u8D26\u53F7\u4E0D\u5B58\u5728");
      if (user.status !== "active") throw new Error("\u8D26\u53F7\u72B6\u6001\u5F02\u5E38\uFF0C\u65E0\u6CD5\u767B\u5F55");
      const principal = this.ensureHumanPrincipal(user.id, user.displayName);
      const session = this.issueSessionPair(principal.id, { issuedBy: "sso:" + ssoProvider });
      this.ctx.iam.markLogin(user.id);
      this.ctx.platformBus.emit(PlatformEvents.TokenIssued, { jti: session.access.jti, principalId: principal.id, kind: "access" });
      return { kind: "hit", session, userId: user.id };
    }
    const ticket = newId("tkt");
    this.ssoTickets().insert({
      id: ticket,
      provider: ssoProvider,
      profile: {
        providerUserId: profile.providerUserId,
        corpId: profile.corpId,
        name: profile.name,
        ...profile.email !== void 0 ? { email: profile.email } : {}
      },
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      expiresAt: new Date(Date.now() + 5 * 6e4).toISOString()
    });
    return { kind: "pending", pendingTicket: ticket, profileName: profile.name };
  }
  /** 读取 state 记录的用途（回调路由分发用；不消费）。 */
  peekOAuthState(state) {
    const record = this.oauthStates().get(state);
    if (!record) throw new Error("state \u65E0\u6548\uFF08\u672A\u53D1\u8D77\u6388\u6743\u6216\u5DF2\u6D88\u8D39\uFF09");
    return {
      provider: record.provider,
      purpose: record.purpose ?? "login",
      ...record.userId !== void 0 ? { userId: record.userId } : {},
      ...record.configId !== void 0 ? { configId: record.configId } : {}
    };
  }
  /**
   * 完成扫码绑定（purpose=bind）：state 一次性消费 → Adapter 链换 unionId
   * → 绑定到 state 锁定的平台账号。全程无需手工输入任何三方 ID。
   * 「一人一号」由 identityLinks 引擎级唯一约束兜底。
   */
  async completeSsoBind(code, state) {
    const stateRecord = this.oauthStates().get(state);
    if (!stateRecord) throw new Error("state \u65E0\u6548\uFF08\u672A\u53D1\u8D77\u6388\u6743\u6216\u5DF2\u6D88\u8D39\uFF09");
    if (stateRecord.consumedAt) throw new Error("state \u5DF2\u88AB\u4F7F\u7528\uFF08\u9632\u91CD\u653E\uFF09");
    if ((stateRecord.purpose ?? "login") !== "bind") throw new Error("state \u7528\u9014\u4E0D\u662F\u8D26\u53F7\u7ED1\u5B9A");
    if (!stateRecord.userId) throw new Error("\u7ED1\u5B9A\u76EE\u6807\u8D26\u53F7\u7F3A\u5931\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77\u7ED1\u5B9A");
    if (Date.now() - new Date(stateRecord.createdAt).getTime() > 10 * 6e4) throw new Error("state \u5DF2\u8FC7\u671F");
    this.oauthStates().update(state, { consumedAt: (/* @__PURE__ */ new Date()).toISOString() });
    const adapter = stateRecord.configId ? this.ctx.iam.getAuthProviderByConfig(stateRecord.configId) : this.ctx.iam.getAuthProvider(stateRecord.provider);
    const tokenSet = await adapter.exchangeCode(code);
    const raw = await adapter.getUserInfo(tokenSet);
    const profile = adapter.normalizeProfile(raw);
    const user = this.ctx.iam.users().get(stateRecord.userId);
    if (!user) throw new Error("\u7ED1\u5B9A\u76EE\u6807\u8D26\u53F7\u4E0D\u5B58\u5728");
    if (user.status === "deactivated") throw new Error("\u7ED1\u5B9A\u76EE\u6807\u8D26\u53F7\u5DF2\u6CE8\u9500");
    const existing = this.ctx.iam.findLinkByProfile(stateRecord.provider, profile.providerUserId, profile.corpId);
    if (existing && existing.userId !== user.id) {
      throw new Error("\u8BE5\u9489\u9489\u8EAB\u4EFD\u5DF2\u7ED1\u5B9A\u5176\u4ED6\u5E73\u53F0\u8D26\u53F7\uFF08\u4E00\u4EBA\u4E00\u53F7\uFF09");
    }
    if (user.bindings.some((item) => item.provider === stateRecord.provider) && !existing) {
      throw new Error("\u8BE5\u8D26\u53F7\u5DF2\u7ED1\u5B9A\u9489\u9489\u8EAB\u4EFD\uFF0C\u8BF7\u5148\u89E3\u7ED1\u518D\u91CD\u65B0\u7ED1\u5B9A");
    }
    if (!existing) {
      this.ctx.iam.linkIdentity(user.id, {
        provider: stateRecord.provider,
        providerUserId: profile.providerUserId,
        corpId: profile.corpId,
        displayName: profile.name
      }, "sso-bind-oauth");
    }
    return { userId: user.id, provider: stateRecord.provider, displayName: profile.name, providerUserId: profile.providerUserId };
  }
  /** 待绑定票据 → 绑定已有平台账号（校验密码）→ 建立身份链接并登录。 */
  ssoBindExisting(pendingTicket, username, password) {
    const ticket = this.peekTicket(pendingTicket);
    const throttleKey = `sso-bind:${username}`;
    this.assertNotLocked(throttleKey);
    let user;
    try {
      user = this.ctx.iam.verifyPassword(username, password);
    } catch (error) {
      this.recordLoginFailure(throttleKey);
      throw error;
    }
    this.recordLoginSuccess(throttleKey);
    this.ctx.iam.linkIdentity(user.id, {
      provider: ticket.provider,
      providerUserId: ticket.profile["providerUserId"] ?? "",
      corpId: ticket.profile["corpId"] ?? "",
      displayName: ticket.profile["name"] ?? ""
    }, "sso-bind:" + username);
    this.consumeTicket(pendingTicket);
    const principal = this.ensureHumanPrincipal(user.id, user.displayName);
    const session = this.issueSessionPair(principal.id, { issuedBy: "sso-bind:" + ticket.provider });
    this.ctx.iam.markLogin(user.id);
    return { session, userId: user.id };
  }
  /** 待绑定票据 → 注册新账号（默认落入首个组织）→ 建立身份链接并登录。 */
  ssoRegister(pendingTicket) {
    const ticket = this.consumeTicket(pendingTicket);
    void ticket;
    const defaultOrg = this.ctx.iam.orgs().all()[0];
    if (!defaultOrg) throw new Error("\u5E73\u53F0\u5C1A\u672A\u521D\u59CB\u5316\u7EC4\u7EC7\uFF0C\u65E0\u6CD5\u6CE8\u518C");
    const username = ticket.provider + "_" + (ticket.profile["providerUserId"] ?? "");
    const { user } = this.ctx.iam.createUser({
      username,
      displayName: ticket.profile["name"] ?? username,
      orgId: defaultOrg.id,
      email: ticket.profile["email"]
    });
    this.ctx.iam.activateUser(user.id);
    this.ctx.iam.linkIdentity(user.id, {
      provider: ticket.provider,
      providerUserId: ticket.profile["providerUserId"] ?? "",
      corpId: ticket.profile["corpId"] ?? "",
      displayName: ticket.profile["name"] ?? ""
    }, "sso-register");
    const principal = this.ensureHumanPrincipal(user.id, user.displayName);
    const session = this.issueSessionPair(principal.id, { issuedBy: "sso-register:" + ticket.provider });
    this.ctx.iam.markLogin(user.id);
    return { session, userId: user.id };
  }
  /** 读取票据（不消费）。 */
  peekTicket(pendingTicket) {
    const ticket = this.ssoTickets().get(pendingTicket);
    if (!ticket) throw new Error("\u5F85\u7ED1\u5B9A\u7968\u636E\u65E0\u6548");
    if (ticket.usedAt) throw new Error("\u7968\u636E\u5DF2\u88AB\u4F7F\u7528");
    if (new Date(ticket.expiresAt).getTime() < Date.now()) throw new Error("\u7968\u636E\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77\u6388\u6743");
    return { provider: ticket.provider, profile: ticket.profile };
  }
  consumeTicket(pendingTicket) {
    const ticket = this.ssoTickets().get(pendingTicket);
    if (!ticket) throw new Error("\u5F85\u7ED1\u5B9A\u7968\u636E\u65E0\u6548");
    if (ticket.usedAt) throw new Error("\u7968\u636E\u5DF2\u88AB\u4F7F\u7528");
    if (new Date(ticket.expiresAt).getTime() < Date.now()) throw new Error("\u7968\u636E\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77\u6388\u6743");
    this.ssoTickets().update(pendingTicket, { usedAt: (/* @__PURE__ */ new Date()).toISOString() });
    return { provider: ticket.provider, profile: ticket.profile };
  }
  tokens() {
    return this.ctx.opsStorage.collection("authn:tokens");
  }
  loadOrCreateSecret() {
    const file = join(this.ctx.opsStorage.dataDirPath, "authn-signing-secret");
    try {
      if (existsSync(file)) return readFileSync(file, "utf8").trim();
      mkdirSync(this.ctx.opsStorage.dataDirPath, { recursive: true });
      const secret = generateSecret("sign");
      writeFileSync(file, secret, { encoding: "utf8", mode: 384 });
      return secret;
    } catch (error) {
      console.error("[authn] \u7B7E\u540D\u5BC6\u94A5\u8BFB\u53D6/\u843D\u76D8\u5931\u8D25\uFF0C\u964D\u7EA7\u4E3A\u8FDB\u7A0B\u5185\u5BC6\u94A5\uFF08\u91CD\u542F\u540E\u6240\u6709\u4EE4\u724C\u5931\u6548\uFF09", error);
      return generateSecret("sign");
    }
  }
  loadRetiredSecrets() {
    try {
      const file = join(this.ctx.opsStorage.dataDirPath, "authn-signing-secret-history.json");
      if (!existsSync(file)) return;
      const stored = JSON.parse(readFileSync(file, "utf8"));
      const cutoff = Date.now() - SECRET_GRACE_MS;
      this.retiredSecrets = stored.filter((item) => item.retiredAt > cutoff);
    } catch {
    }
  }
  saveRetiredSecrets() {
    try {
      const file = join(this.ctx.opsStorage.dataDirPath, "authn-signing-secret-history.json");
      writeFileSync(file, JSON.stringify(this.retiredSecrets, null, 2), "utf8");
    } catch (error) {
      console.error("[authn] \u9000\u5F79\u5BC6\u94A5\u5386\u53F2\u843D\u76D8\u5931\u8D25\uFF08\u4EC5\u5F71\u54CD\u8F6E\u6362\u5BBD\u9650\uFF09", error);
    }
  }
  /**
   * 轮换签名密钥（评审 S2 修复）：旧密钥进入宽限期（默认 24h）而非立即作废——
   * 宽限期内旧令牌仍可通过验签（在途请求不掉线），宽限期后自然失效；
   * 会话可随时用 refresh token 换取新密钥签发的访问令牌，全局无感轮换。
   */
  rotateSigningSecret() {
    this.retiredSecrets = [
      ...this.retiredSecrets.filter((item) => Date.now() - item.retiredAt < SECRET_GRACE_MS),
      { secret: this.signingSecret, retiredAt: Date.now() }
    ];
    this.signingSecret = generateSecret("sign");
    const file = join(this.ctx.opsStorage.dataDirPath, "authn-signing-secret");
    writeFileSync(file, this.signingSecret, "utf8");
    this.saveRetiredSecrets();
    return { graceMs: SECRET_GRACE_MS };
  }
  /** 校验签名：先当前密钥，再宽限期内的退役密钥（轮换在途兼容）。 */
  signatureMatches(body, signature) {
    const candidates = [this.signingSecret, ...this.retiredSecrets.filter((item) => Date.now() - item.retiredAt < SECRET_GRACE_MS).map((item) => item.secret)];
    return candidates.some((secret) => createHmac("sha256", secret).update(body).digest("base64url") === signature);
  }
  /** 清理过期/吊销令牌（评审 M2）：过期 7 天后物理删除（保留一个 refresh 周期用于重放取证），撤销状态不再无限累积。 */
  cleanupExpiredTokens() {
    const cutoff = Date.now() - 7 * 24 * 36e5;
    let removed = 0;
    for (const token of this.tokens().all()) {
      if (new Date(token.expiresAt).getTime() < cutoff) {
        if (this.tokens().remove(token.id)) removed++;
      }
    }
    return removed;
  }
  // -- Principal ----------------------------------------------------------
  humanPrincipal(userId) {
    return this.principals().findOne((item) => item.type === "human" && item.refId === userId);
  }
  ensureHumanPrincipal(userId, name2) {
    const existing = this.humanPrincipal(userId);
    if (existing) return existing;
    return this.principals().insert({
      id: newId("pri"),
      type: "human",
      refType: "user",
      refId: userId,
      name: name2,
      status: "active",
      scopes: []
    });
  }
  /** 创建机器身份凭证（Client Credentials）。secret 仅返回一次；授权 = 机器角色（roleIds，实时同步）+ 附加权限点（scopes，须命中权限目录）。 */
  createMachineCredential(input) {
    this.assertMachineScopes(input.scopes);
    this.assertMachineRoles(input.roleIds ?? []);
    if ((input.roleIds ?? []).length === 0 && input.scopes.length === 0) throw new Error("\u6388\u6743\u4E0D\u80FD\u4E3A\u7A7A\uFF1A\u81F3\u5C11\u9009\u62E9\u673A\u5668\u89D2\u8272\u6216\u9644\u52A0\u6743\u9650\u70B9");
    const clientId = `mc-${newId("id").slice(3)}`;
    const clientSecret = generateSecret("cs");
    const principal = this.principals().insert({
      id: newId("pri"),
      type: "machine",
      ...input.refType !== void 0 ? { refType: input.refType } : {},
      ...input.refId !== void 0 ? { refId: input.refId } : {},
      name: input.name,
      status: "active",
      clientId,
      clientSecretHash: sha256Hex(clientSecret),
      ...(input.roleIds ?? []).length > 0 ? { roleIds: input.roleIds } : {},
      scopes: input.scopes
    });
    return { principal, clientId, clientSecret };
  }
  disablePrincipal(id, reason) {
    const principal = this.principals().get(id);
    if (!principal) throw new Error(`\u8EAB\u4EFD\u4E0D\u5B58\u5728\uFF1A${id}`);
    this.revokePrincipalTokens(id, reason);
    return this.principals().update(id, { status: "disabled" });
  }
  /** 校验机器身份附加权限点：恰为 ['*'] 或全部命中权限目录（防拼错，如 usage.wrtie）；可空（授权可全部来自机器角色）。 */
  assertMachineScopes(scopes) {
    if (scopes.length === 0) return;
    if (scopes.includes("*")) {
      if (scopes.length !== 1) throw new Error("'*' \u4E0D\u53EF\u4E0E\u5176\u4ED6\u6743\u9650\u70B9\u6DF7\u7528");
      return;
    }
    const catalog = new Set(PermissionCatalog.map((item) => item.point));
    const invalid = scopes.filter((scope) => !catalog.has(scope));
    if (invalid.length > 0) throw new Error(`\u975E\u6CD5\u6743\u9650\u70B9\uFF1A${invalid.join("\u3001")}\uFF08\u987B\u4E3A\u6743\u9650\u76EE\u5F55\u4E2D\u7684\u70B9\uFF0C\u6216\u4EC5 '*'\uFF09`);
  }
  /** 校验机器角色引用：角色必须真实存在（共用 iam:roles 存储）。 */
  assertMachineRoles(roleIds) {
    for (const roleId of roleIds) {
      if (!this.ctx.iam.roles().get(roleId)) throw new Error(`\u673A\u5668\u89D2\u8272\u4E0D\u5B58\u5728\uFF1A${roleId}`);
    }
  }
  /** 机器主体生效权限 = 角色权限（通配符展开，实时同步）∪ 附加直接权限点。 */
  resolveMachineScopes(principal) {
    const fromRoles = this.ctx.iam.resolveRolePermissions(principal.roleIds ?? []);
    if (fromRoles.includes("*") || principal.scopes.includes("*")) return ["*"];
    const merged = /* @__PURE__ */ new Set([...fromRoles, ...principal.scopes]);
    return [...merged];
  }
  /** 调整机器身份授权（机器角色 / 附加权限点）；联动吊销全部存量令牌（收权即时生效，下次换牌按新范围签发）。 */
  updateMachineScopes(id, patch) {
    const principal = this.principals().get(id);
    if (!principal) throw new Error(`\u8EAB\u4EFD\u4E0D\u5B58\u5728\uFF1A${id}`);
    if (principal.type !== "machine") throw new Error("\u4EC5\u673A\u5668\u8EAB\u4EFD\u652F\u6301\u8C03\u6574\u6743\u9650\u8303\u56F4");
    const roleIds = patch.roleIds ?? principal.roleIds ?? [];
    const scopes = patch.scopes ?? principal.scopes;
    this.assertMachineScopes(scopes);
    this.assertMachineRoles(roleIds);
    if (roleIds.length === 0 && scopes.length === 0) throw new Error("\u6388\u6743\u4E0D\u80FD\u4E3A\u7A7A\uFF1A\u81F3\u5C11\u4FDD\u7559\u673A\u5668\u89D2\u8272\u6216\u9644\u52A0\u6743\u9650\u70B9");
    const updated = this.principals().update(id, {
      ...patch.roleIds !== void 0 ? { roleIds } : {},
      ...patch.scopes !== void 0 ? { scopes } : {}
    });
    this.revokePrincipalTokens(id, "\u6743\u9650\u8303\u56F4\u8C03\u6574\u8054\u52A8");
    return updated;
  }
  /** 轮换机器凭证密钥：clientId 不变，旧 secret 立即失效，存量令牌全部吊销；新 secret 仅此一次返回。 */
  rotateMachineCredential(id) {
    const principal = this.principals().get(id);
    if (!principal) throw new Error(`\u8EAB\u4EFD\u4E0D\u5B58\u5728\uFF1A${id}`);
    if (principal.type !== "machine" || !principal.clientId) throw new Error("\u4EC5\u673A\u5668\u51ED\u8BC1\uFF08clientId/clientSecret\uFF09\u652F\u6301\u8F6E\u6362");
    const clientSecret = generateSecret("cs");
    const updated = this.principals().update(id, { clientSecretHash: sha256Hex(clientSecret) });
    this.revokePrincipalTokens(id, "\u51ED\u8BC1\u8F6E\u6362\u8054\u52A8");
    return { principal: updated, clientSecret };
  }
  enablePrincipal(id) {
    return this.principals().update(id, { status: "active" });
  }
  // -- 登录 ---------------------------------------------------------------
  /** 登录尝试计数集合（durable：重启不清零）。 */
  loginAttempts() {
    const collection = this.ctx.opsStorage.collection("authn:loginAttempts");
    collection.uniqueOn("login_attempt_key", (item) => item.key);
    return collection;
  }
  /** 锁定校验：命中锁定窗口直接拒绝（评审 S3：暴力破解面收敛；OIDC 授权/换牌端点复用）。 */
  assertNotLocked(key) {
    const record = this.loginAttempts().findOne((item) => item.key === key);
    if (!record?.lockedUntil) return;
    const remainMs = new Date(record.lockedUntil).getTime() - Date.now();
    if (remainMs > 0) {
      const minutes = Math.ceil(remainMs / 6e4);
      throw new Error(`\u5931\u8D25\u6B21\u6570\u8FC7\u591A\u5DF2\u9501\u5B9A\uFF1A\u8BF7\u7EA6 ${minutes} \u5206\u949F\u540E\u91CD\u8BD5\uFF08\u6216\u8054\u7CFB\u7BA1\u7406\u5458\u91CD\u7F6E\uFF09`);
    }
  }
  recordLoginFailure(key) {
    const collection = this.loginAttempts();
    const now = Date.now();
    const existing = collection.findOne((item) => item.key === key);
    if (!existing) {
      collection.insert({ id: newId("lga"), key, fails: 1, windowStart: (/* @__PURE__ */ new Date()).toISOString(), lockCount: 0 });
      return;
    }
    const inWindow = now - new Date(existing.windowStart).getTime() < LOGIN_WINDOW_MS;
    const fails = inWindow ? existing.fails + 1 : 1;
    const patch = {
      fails,
      ...inWindow ? {} : { windowStart: (/* @__PURE__ */ new Date()).toISOString() }
    };
    if (fails >= LOGIN_MAX_FAILS) {
      const lockCount = existing.lockCount + 1;
      const lockMs = Math.min(LOGIN_BASE_LOCK_MS * 2 ** (lockCount - 1), LOGIN_MAX_LOCK_MS);
      patch.lockCount = lockCount;
      patch.lockedUntil = new Date(now + lockMs).toISOString();
      patch.fails = 0;
      this.ctx.platformBus.emit(PlatformEvents.AlertFired, {
        id: newId("alt"),
        severity: "warning",
        title: "\u767B\u5F55\u5931\u8D25\u9501\u5B9A\u89E6\u53D1",
        message: `\u4E3B\u4F53 ${key} \u5728 ${LOGIN_WINDOW_MS / 6e4} \u5206\u949F\u5185\u8FDE\u7EED\u5931\u8D25 ${LOGIN_MAX_FAILS} \u6B21\uFF0C\u9501\u5B9A ${Math.round(lockMs / 6e4)} \u5206\u949F\uFF08\u66B4\u529B\u7834\u89E3\u9632\u62A4\uFF09`,
        resourceType: "authn",
        resourceId: key
      });
    }
    collection.update(existing.id, patch);
  }
  recordLoginSuccess(key) {
    const collection = this.loginAttempts();
    const existing = collection.findOne((item) => item.key === key);
    if (existing) collection.remove(existing.id);
  }
  login(username, password) {
    const throttleKey = `login:${username}`;
    this.assertNotLocked(throttleKey);
    let user;
    try {
      user = this.ctx.iam.verifyPassword(username, password);
    } catch (error) {
      this.recordLoginFailure(throttleKey);
      throw error;
    }
    this.recordLoginSuccess(throttleKey);
    const principal = this.ensureHumanPrincipal(user.id, user.displayName);
    const session = this.issueSessionPair(principal.id, { issuedBy: `password:${username}` });
    this.ctx.iam.markLogin(user.id);
    this.ctx.platformBus.emit(PlatformEvents.TokenIssued, { jti: session.access.jti, principalId: principal.id, kind: "access" });
    return { token: session.token, refreshToken: session.refreshToken, sid: session.sid, record: session.access, principal, userId: user.id };
  }
  clientCredentialsLogin(clientId, clientSecret) {
    const throttleKey = `cc:${clientId}`;
    this.assertNotLocked(throttleKey);
    const principal = this.principals().findOne((item) => item.clientId === clientId);
    if (!principal || principal.clientSecretHash !== sha256Hex(clientSecret)) {
      this.recordLoginFailure(throttleKey);
      throw new Error("client_id \u6216 client_secret \u9519\u8BEF");
    }
    this.recordLoginSuccess(throttleKey);
    if (principal.status !== "active") throw new Error("\u673A\u5668\u8EAB\u4EFD\u5DF2\u7981\u7528");
    const { token, record } = this.issueToken(principal.id, {
      kind: "machine",
      ttlHours: 2,
      scopes: this.resolveMachineScopes(principal),
      issuedBy: "client_credentials"
    });
    this.ctx.platformBus.emit(PlatformEvents.TokenIssued, { jti: record.jti, principalId: principal.id, kind: "machine" });
    return { token, record, principal };
  }
  // -- 令牌 ---------------------------------------------------------------
  issueToken(principalId, options) {
    const principal = this.principals().get(principalId);
    if (!principal) throw new Error(`\u8EAB\u4EFD\u4E0D\u5B58\u5728\uFF1A${principalId}`);
    if (principal.status !== "active") throw new Error("\u8EAB\u4EFD\u5DF2\u7981\u7528\uFF0C\u65E0\u6CD5\u7B7E\u53D1\u4EE4\u724C");
    if (options.audience?.startsWith("plugin:")) {
      const namespace = `${options.audience}:`;
      const offender = (options.scopes ?? []).find((scope) => scope !== "*" && !scope.startsWith(namespace));
      if (offender !== void 0) {
        throw new Error(`\u63D2\u4EF6\u4EE4\u724C scope \u8D8A\u754C\uFF1A${offender} \u4E0D\u5728\u547D\u540D\u7A7A\u95F4 ${namespace} \u5185`);
      }
    }
    const jti = randomUUID();
    const issuedAt = /* @__PURE__ */ new Date();
    const expiresAt = new Date(issuedAt.getTime() + (options.ttlHours ?? 2) * 36e5);
    const payload = {
      iss: "dsh-ops-authn",
      sub: principal.id,
      typ: options.kind,
      jti,
      iat: Math.floor(issuedAt.getTime() / 1e3),
      exp: Math.floor(expiresAt.getTime() / 1e3),
      scope: options.scopes ?? [],
      act: options.actChain ?? [],
      ...options.audience !== void 0 ? { aud: options.audience } : {},
      ...options.sid !== void 0 ? { sid: options.sid } : {}
    };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", this.signingSecret).update(body).digest("base64url");
    const token = `dst1.${body}.${sig}`;
    const record = this.tokens().insert({
      id: jti,
      jti,
      principalId,
      kind: options.kind,
      scopes: options.scopes ?? [],
      ...options.audience !== void 0 ? { audience: options.audience } : {},
      actChain: options.actChain ?? [],
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      issuedBy: options.issuedBy ?? "api",
      ...options.sid !== void 0 ? { sid: options.sid } : {},
      ...options.chainId !== void 0 ? { chainId: options.chainId } : {}
    });
    return { token, record };
  }
  /** on-behalf-of：以当前主体身份为另一主体签发透传令牌（act 链叠加）。 */
  issueOnBehalfOf(parent, targetPrincipalId) {
    const target = this.principals().get(targetPrincipalId);
    if (!target) throw new Error(`\u76EE\u6807\u8EAB\u4EFD\u4E0D\u5B58\u5728\uFF1A${targetPrincipalId}`);
    const actChain = [
      ...parent.actChain,
      { principalId: parent.principal.id, name: parent.principal.name, type: parent.principal.type }
    ];
    return this.issueToken(targetPrincipalId, {
      kind: "machine",
      ttlHours: 1,
      scopes: intersectScopes(parent.scopes, target.scopes),
      actChain,
      issuedBy: `obo:${parent.principal.id}`
    });
  }
  /**
   * 校验令牌。options.audience 指定时执行受众校验：令牌 aud 不匹配即拒绝
   * （v1.2 第 1 步：一个泄漏的插件令牌拿不到平台其它服务）。
   */
  verify(tokenString, options = {}) {
    const parts = tokenString.split(".");
    if (parts.length !== 3 || parts[0] !== "dst1") throw new Error("\u4EE4\u724C\u683C\u5F0F\u4E0D\u5408\u6CD5");
    if (!this.signatureMatches(parts[1], parts[2])) throw new Error("\u4EE4\u724C\u7B7E\u540D\u6821\u9A8C\u5931\u8D25");
    let payload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      throw new Error("\u4EE4\u724C\u8F7D\u8377\u89E3\u6790\u5931\u8D25");
    }
    if (payload.iss !== "dsh-ops-authn") throw new Error("\u4EE4\u724C\u7B7E\u53D1\u65B9\uFF08iss\uFF09\u4E0D\u5339\u914D");
    if (payload.exp * 1e3 < Date.now()) throw new Error("\u4EE4\u724C\u5DF2\u8FC7\u671F");
    if (options.audience !== void 0) {
      if (payload.aud === void 0) throw new Error("\u4EE4\u724C\u672A\u7ED1\u5B9A\u53D7\u4F17\uFF08aud\uFF09\uFF0C\u76EE\u6807\u670D\u52A1\u8981\u6C42\u53D7\u4F17\u6821\u9A8C");
      if (payload.aud !== options.audience) throw new Error(`\u4EE4\u724C\u53D7\u4F17\u4E0D\u5339\u914D\uFF1A\u671F\u671B ${options.audience}\uFF0C\u5B9E\u9645 ${payload.aud}`);
    }
    const record = this.tokens().get(payload.jti);
    if (!record) throw new Error("\u4EE4\u724C\u4E0D\u5B58\u5728\u6216\u5DF2\u88AB\u6E05\u7406");
    if (record.revokedAt) throw new Error(`\u4EE4\u724C\u5DF2\u88AB\u540A\u9500\uFF1A${record.revokedReason ?? "\u7B56\u7565\u540A\u9500"}`);
    const principal = this.principals().get(record.principalId);
    if (!principal) throw new Error("\u4EE4\u724C\u4E3B\u4F53\u4E0D\u5B58\u5728");
    if (principal.status !== "active") throw new Error("\u4EE4\u724C\u4E3B\u4F53\u5DF2\u7981\u7528");
    const scopes = principal.type === "human" ? this.ctx.iam.userPermissions(principal.refId ?? "") : this.resolveMachineScopes(principal);
    this.tokens().update(record.id, { lastUsedAt: (/* @__PURE__ */ new Date()).toISOString() });
    return { principal, token: record, scopes, actChain: record.actChain };
  }
  hasPermission(verified, point) {
    return verified.scopes.includes("*") || verified.scopes.includes(point);
  }
  revokeToken(jti, reason) {
    const record = this.tokens().get(jti);
    if (!record) throw new Error(`\u4EE4\u724C\u4E0D\u5B58\u5728\uFF1A${jti}`);
    if (record.revokedAt) return record;
    const updated = this.tokens().update(record.id, {
      revokedAt: (/* @__PURE__ */ new Date()).toISOString(),
      revokedReason: reason
    });
    this.ctx.platformBus.emit(PlatformEvents.TokenRevoked, { jti, principalId: record.principalId, reason });
    return updated;
  }
  revokePrincipalTokens(principalId, reason) {
    let count = 0;
    for (const token of this.tokens().find((item) => item.principalId === principalId && !item.revokedAt)) {
      this.revokeToken(token.jti, reason);
      count++;
    }
    return count;
  }
  /** 令牌是否仍活跃（DEF-03：过期/已轮转的记录不计入「活跃令牌」，避免计数随运行时长失真）。 */
  isTokenActive(token, now = Date.now()) {
    if (token.revokedAt) return false;
    if (new Date(token.expiresAt).getTime() <= now) return false;
    if (token.kind === "refresh" && token.rotatedAt) return false;
    return true;
  }
  activeTokenCount(principalId) {
    return this.tokens().find((item) => item.principalId === principalId && this.isTokenActive(item)).length;
  }
}
function intersectScopes(a, b) {
  if (a.includes("*")) return [...b];
  if (b.includes("*")) return [...a];
  const setB = new Set(b);
  return a.filter((scope) => setB.has(scope));
}
const name = "authn";
const inject = ["opsStorage", "platformBus", "iam", "httpServer"];
function apply(ctx) {
  ctx.plugin(AuthnService);
  ctx.plugin(OidcService);
  ctx.plugin(EntryTicketService);
  ctx.plugin(authnTools);
}
export {
  AuthnService,
  apply,
  inject,
  name
};
