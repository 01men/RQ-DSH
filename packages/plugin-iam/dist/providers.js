class ProviderAuthError extends Error {
  code;
  constructor(message, code = "PROVIDER_AUTH_FAILED") {
    super(message);
    this.code = code;
  }
}
const DINGTALK_DIRECTORY = {
  corpId: "ding-yuanbingke",
  users: [
    { unionId: "dd_u001", name: "\u9648\u8FDC\u821F", jobNumber: "DD0001", email: "chenyz@yuanbingke.com" },
    { unionId: "dd_u002", name: "\u6797\u5C0F\u6EE1", jobNumber: "DD0002", email: "linxm@yuanbingke.com" },
    { unionId: "dd_u003", name: "\u5468\u65E2\u767D", jobNumber: "DD0003", email: "zhoujb@yuanbingke.com" },
    { unionId: "dd_u004", name: "\u82CF\u781A\u79CB", jobNumber: "DD0004", email: "suyq@yuanbingke.com" },
    { unionId: "dd_u005", name: "\u4F55\u9752\u68A7", jobNumber: "DD0005", email: "heqw@yuanbingke.com" },
    { unionId: "dd_u006", name: "\u987E\u661F\u9611", jobNumber: "DD0006", email: "guxl@yuanbingke.com" },
    { unionId: "dd_u007", name: "\u53F6\u6816\u8FDF", jobNumber: "DD0007", email: "yqz@yuanbingke.com" }
  ]
};
const CODE_TTL_MS = 5 * 6e4;
class DingTalkAuthAdapter {
  type = "dingtalk";
  label = "\u9489\u9489";
  mock = true;
  consumedCodes = /* @__PURE__ */ new Map();
  async buildAuthorizeUrl(scene, state, redirectUri, _options) {
    if (scene === "in_app") return null;
    const params = new URLSearchParams({
      client_id: "demo-app-key",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid corpid",
      state
    });
    return `https://login.dingtalk.com/oauth2/auth?${params}`;
  }
  async exchangeCode(code) {
    const consumedAt = this.consumedCodes.get(code);
    const now = Date.now();
    if (consumedAt !== void 0 && now - consumedAt < CODE_TTL_MS) {
      throw new ProviderAuthError("\u6388\u6743\u7801\u5DF2\u88AB\u4F7F\u7528\uFF08code \u4EC5\u53EF\u6D88\u8D39\u4E00\u6B21\uFF09", "CODE_REPLAY");
    }
    const user = DINGTALK_DIRECTORY.users.find((item) => item.jobNumber === code || item.unionId === code);
    if (!user) throw new ProviderAuthError("\u6388\u6743\u7801\u65E0\u6548\u6216\u5DF2\u8FC7\u671F", "INVALID_CODE");
    this.consumedCodes.set(code, now);
    return {
      accessToken: `mock-user-token-${user.unionId}-${now}`,
      expiresIn: 7200,
      raw: { unionId: user.unionId, code }
    };
  }
  async getUserInfo(tokenSet) {
    const raw = tokenSet.raw;
    const user = DINGTALK_DIRECTORY.users.find((item) => item.unionId === raw.unionId);
    if (!user) throw new ProviderAuthError("\u7528\u6237\u6863\u6848\u4E0D\u5B58\u5728", "PROFILE_NOT_FOUND");
    return { ...user, corpId: DINGTALK_DIRECTORY.corpId };
  }
  normalizeProfile(raw) {
    const record = raw;
    return {
      providerUserId: record.unionId,
      corpId: record.corpId,
      name: record.name,
      ...record.email !== void 0 ? { email: record.email } : {}
    };
  }
}
class RealDingTalkAuthAdapter {
  type = "dingtalk";
  label = "\u9489\u9489";
  mock = false;
  consumedCodes = /* @__PURE__ */ new Map();
  credentials;
  constructor(credentials) {
    this.credentials = credentials;
  }
  get apiBase() {
    return this.credentials.apiBase ?? "https://api.dingtalk.com";
  }
  async buildAuthorizeUrl(scene, state, redirectUri, options) {
    if (scene === "in_app") return null;
    const params = new URLSearchParams({
      client_id: this.credentials.appKey,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid corpid",
      state
    });
    if (options?.promptConsent) params.set("prompt", "consent");
    return `https://login.dingtalk.com/oauth2/auth?${params}`;
  }
  async exchangeCode(code) {
    const consumedAt = this.consumedCodes.get(code);
    const now = Date.now();
    if (consumedAt !== void 0 && now - consumedAt < CODE_TTL_MS) {
      throw new ProviderAuthError("\u6388\u6743\u7801\u5DF2\u88AB\u4F7F\u7528\uFF08code \u4EC5\u53EF\u6D88\u8D39\u4E00\u6B21\uFF09", "CODE_REPLAY");
    }
    const response = await fetch(`${this.apiBase}/v1.0/oauth2/userAccessToken`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: this.credentials.appKey,
        clientSecret: this.credentials.appSecret,
        code,
        grantType: "authorization_code"
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.accessToken) {
      throw new ProviderAuthError(`\u9489\u9489 userAccessToken \u6362\u53D6\u5931\u8D25\uFF08HTTP ${response.status}\uFF09`, "INVALID_CODE");
    }
    this.consumedCodes.set(code, now);
    return {
      accessToken: payload.accessToken,
      ...payload.refreshToken !== void 0 ? { refreshToken: payload.refreshToken } : {},
      expiresIn: payload.expireIn ?? 7200,
      raw: { accessToken: payload.accessToken, corpId: payload.corpId ?? this.credentials.corpId }
    };
  }
  async getUserInfo(tokenSet) {
    const response = await fetch(`${this.apiBase}/v1.0/contact/users/me`, {
      headers: { "x-acs-dingtalk-access-token": tokenSet.accessToken }
    });
    const bodyText = await response.text().catch(() => "");
    let payload = {};
    try {
      payload = JSON.parse(bodyText);
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const tokenCorpId = tokenSet.raw.corpId ?? "\u672A\u77E5";
      const scopeDenied = bodyText.includes("AccessTokenPermissionDenied");
      throw new ProviderAuthError(
        `\u9489\u9489\u7528\u6237\u6863\u6848\u83B7\u53D6\u5931\u8D25\uFF08HTTP ${response.status}\uFF0Ctoken\u4F01\u4E1A=${tokenCorpId}\uFF09\uFF1A${bodyText.slice(0, 500)}`,
        scopeDenied ? "PROVIDER_SCOPE_DENIED" : "PROFILE_NOT_FOUND"
      );
    }
    const rawCorpId = tokenSet.raw.corpId;
    return { ...payload, corpId: rawCorpId || this.credentials.corpId };
  }
  normalizeProfile(raw) {
    const record = raw;
    const providerUserId = record.unionId ?? record.userId;
    if (!providerUserId) throw new ProviderAuthError("\u9489\u9489\u6863\u6848\u7F3A\u5C11 unionId/userId", "PROFILE_NOT_FOUND");
    return {
      providerUserId,
      corpId: record.corpId ?? this.credentials.corpId,
      name: record.name ?? record.nick ?? providerUserId,
      ...record.email !== void 0 && record.email !== "" ? { email: record.email } : {}
    };
  }
}
export {
  DINGTALK_DIRECTORY,
  DingTalkAuthAdapter,
  ProviderAuthError,
  RealDingTalkAuthAdapter
};
