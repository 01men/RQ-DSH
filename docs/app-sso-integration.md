# 应用统一身份接入（App SSO）接入指南

> 面向对象：在企业内自研 AI 应用（Web / H5 / 小程序 / 桌面 / API 服务）中接入平台统一身份的开发者。
> 目标路径：**注册应用 → 拿凭据 → 按规范一行 SDK 式接入 → 业务权限自己管**。

平台作为企业内统一身份源（OIDC Provider）对外提供身份服务；应用完成接入后：

- 用户在应用中点击「登录」→ 跳转平台授权页 → 平台会话或登录面板 → 确认授权 → 携 `code` 回跳应用；
- 应用后端用 `code` + `client_secret`（或纯前端用 PKCE）换取 `id_token` / `access_token`；
- 应用用 `access_token` 调 `userinfo` 拿到用户身份（`sub` / 组织 / 角色 / 租户），**业务权限由应用自理**；
- 账号在平台被冻结 / 离职 → 应用侧下一次 `userinfo` / `refresh` 即时失效，无需等令牌过期。

## 一、接入五步

| 步骤 | 操作 | 位置 |
|---|---|---|
| 1. 注册应用 | 「AI 应用」→ 注册应用（形态、访问地址、编排 Agent） | 控制台 |
| 2. 签发凭据 | 应用详情 → 「SSO 配置」tab → 签发 SSO 客户端（`client_id` + `client_secret`，secret 仅展示一次） | 控制台 |
| 3. 上线门禁 | `web` / `h5` 形态应用未完成签发无法上线（`APP_SSO_ENFORCE` 可调）；审批通过执行期还会复核客户端状态 | 控制台 + 审批中心 |
| 4. 应用侧接入 | 按下方「SDK 一行接入」或端点直连完成授权码模式（强制 PKCE S256） | 应用代码 |
| 5. 业务权限自理 | `userinfo` 的 `sub` 是稳定关联键；应用内自主映射业务角色 | 应用代码 |

## 二、SDK 一行式接入（推荐）

### 后端 / BFF（confidential 客户端，默认形态）

Node.js（[openid-client](https://github.com/panva/openid-client) v6，与平台自测同款）：

```js
import * as oc from 'openid-client'

// ① 一行 discovery 驱动：issuer 换成平台地址即可
const config = await oc.discovery(
  new URL('https://sso.yourcompany.com'),        // OIDC_ISSUER（见下）
  process.env.SSO_CLIENT_ID,                     // 控制台签发的 client_id
  undefined,
  new oc.ClientSecretBasic(process.env.SSO_CLIENT_SECRET),
)

// ② 登录入口：拼授权地址并 302（state/PKCE 平台强制校验）
const verifier = oc.randomPKCECodeVerifier()
const challenge = await oc.calculatePKCECodeChallenge(verifier)
const redirectTo = oc.buildAuthorizationUrl(config, {
  redirect_uri: 'https://your-app.com/auth/cb',  // 必须与控制台登记的 redirect_uris 完全一致
  scope: 'openid profile email',
  state: oc.randomState(), nonce: oc.randomNonce(),
  code_challenge: challenge, code_challenge_method: 'S256',
})

// ③ 回调处：code 换令牌（id_token 已由 SDK 用 JWKS 验签）
const tokens = await oc.authorizationCodeGrant(config, callbackUrl, {
  code_verifier: verifier, state, nonce,
})
const user = await oc.fetchUserInfo(config, tokens.access_token, tokens.claims().sub)
// user = { sub, name, preferred_username, email?, org: {id,name,tenantId}, roles, tenant }
```

- 静默续期：`oc.refreshTokenGrant(config, tokens.refresh_token)`（轮转一次一换，旧值重放会吊销整链）。
- 登出联动：`oc.buildEndSessionUrl(config, { id_token_hint, post_logout_redirect_uri, state })`，平台会同时吊销该用户在本应用下的 refresh 链。
- 主动吊销：`oc.tokenRevocation(config, tokens.access_token)`（RFC 7009）。

### 纯前端 SPA（public 客户端，D-a 决策：支持 public 形态）

无后端、无法持有 secret 的 H5 / SPA：签发时选择 **public** 客户端类型——免 `client_secret`、**强制 PKCE**、**不签发 refresh token**（access token 过期后静默重走授权）。前端库可用 [oidc-client-ts](https://github.com/authts/oidc-client-ts)：

```js
const mgr = new UserManager({
  authority: 'https://sso.yourcompany.com',       // 平台 discovery 地址
  client_id: 'oc-xxxxxxxx',                        // public 客户端
  redirect_uri: 'http://localhost:5173/cb',        // localhost 调试地址白名单放行
  response_type: 'code', scope: 'openid profile',
  code_challenge_method: 'S256',                   // 平台强制
})
await mgr.signinRedirect()                          // 登录入口
const user = await mgr.signinRedirectCallback()     // 回调处，id_token 已验签
```

> 安全提示：public 客户端的令牌暴露面更大，仅建议用于内网工具 / 无敏感数据的应用；能上 BFF 的尽量走 confidential。

## 三、端点与 discovery

| 端点 | 路径 |
|---|---|
| discovery | `GET /​.well-known/openid-configuration` |
| JWKS 公钥 | `GET /​.well-known/jwks.json` |
| 授权 | `GET /oauth/authorize`（302 平台授权页） |
| 换牌 | `POST /oauth/token`（`client_secret_basic` / `client_secret_post`；form-encoded 与 JSON 均接受） |
| 用户信息 | `GET /oauth/userinfo`（Bearer access token） |
| 刷新 | `POST /oauth/token`（`grant_type=refresh_token`，轮转 + scope 只收窄） |
| 吊销 | `POST /oauth/revoke`（RFC 7009，恒 200） |
| 登出 | `GET /oauth/end_session`（`id_token_hint` + `post_logout_redirect_uri`） |

**`OIDC_ISSUER` 与内网 / HTTPS 反代**：默认 issuer 为 `http://127.0.0.1:<port>`，仅供本机调试。生产/内网部署时必须显式声明对外地址（反代场景取 `x-forwarded-host` 语义对应的对外域名）：

```bash
OIDC_ISSUER=https://sso.yourcompany.com   # discovery/JWKS/端点全部按此拼址
```

应用与用户浏览器都必须能访问该地址；反向代理需放行 `/oauth/*`、`/.well-known/*` 与 SPA 路由 `/#/oauth/*`。注意：更换 issuer 会使存量令牌 `iss` 校验失败，属预期（令牌生命周期短）。

## 四、claims 契约

| claim / 字段 | 语义 |
|---|---|
| `sub` | 平台用户 ID，**稳定不变，唯一关联键**（应用内账号映射以此为准，勿用 username） |
| `preferred_username` / `name` | 用户名 / 显示名（可能改名，勿作主键） |
| `email` | 仅当授权 scope 含 `email` 才返回 |
| `org` / `tenant` | 用户所属组织 `{id,name,tenantId}` / 租户 ID（多租户分域参考） |
| `roles` | 用户在平台的平台级角色 code（`super_admin` 等）——**平台治理角色，不是应用业务角色** |
| `id_token.token_use='id'` / `access.token_use='access'` | 令牌类型打标：`id_token` 只做身份证明，不能调 `userinfo` |

「业务权限自己管」：平台只负责「你是谁」（身份）与平台资源的平台级权限；应用内菜单 / 数据 / 功能权限由应用基于 `sub` 自行建模（建议在应用内维护 `sub → 业务角色` 映射表）。

## 五、安全清单

- **state**：平台强制必填并原样回传（CSRF 防护）；SDK 自动处理，直连时自行生成并校验。
- **PKCE S256**：平台对所有客户端强制；`code_challenge` 43–128 位 base64url。
- **client_secret 保管**：仅存应用后端（环境变量 / KMS）；轮换入口在应用详情「SSO 配置」，旧值立即失效。
- **HTTPS**：redirect_uri 仅允许 `https://` 或 `http://localhost[:port]`（本机调试）。
- **登出联动**：应用登出时应调 `end_session`，平台会吊销该用户在本应用下的 refresh 链（否则登出后应用仍可静默续期）。
- **冻结即时失效**：平台账号冻结 / 离职 → `userinfo` 与 `refresh` 立即拒绝（实时校验用户状态）。
- **门禁**：`web`/`h5` 应用上线前必须持有 active SSO 客户端；审批挂单期间客户端被禁用会在执行期复核失败。

## 六、令牌 TTL 说明（双 TTL 折中）

| 令牌 | TTL | 说明 |
|---|---|---|
| 平台控制台会话 access | 30 min | 平台自身安全基线（refresh 7d 轮转） |
| OIDC access token | 默认 2h（`OIDC_ACCESS_TTL_SECONDS`） | 折中：应用后端/JWKS 本地验签为主，过长放大泄漏面、过短导致 userinfo 窗口太碎 |
| OIDC refresh token | 默认 7d（`OIDC_REFRESH_TTL_SECONDS`） | 一次一换 + 重放整链吊销；冻结/禁用/登出即时失效 |

## 七、secret / 密钥轮换 runbook

- **应用 secret 轮换**：应用详情 → SSO 配置 → 「轮换 secret」→ 新值一次性展示 → 应用侧更新配置（旧值立即 401）。建议每季度或在疑似泄漏时执行。
- **平台 JWKS 签名密钥轮换**：「认证与令牌」→ 「轮换 OIDC 签名密钥」（需 `authn.oidc.write`）。新 key 立即签名，旧 key 24h 宽限内保留验签与 JWKS 公布（在途令牌不掉线）；SDK 会按 `kid` 自动选 key，无需应用改动。
- **应急处置**：疑似令牌泄漏 → 禁用客户端（授权/换牌/刷新立即失败，refresh 链吊销）→ 轮换 secret → 重新启用。

## 八、FAQ

- **本机调试**：redirect_uri 用 `http://localhost:<port>/cb` 即可过白名单；issuer 保持默认 `http://127.0.0.1:<port>`。
- **多环境 issuer**：一套应用对接多套平台环境时，按环境变量注入不同 issuer / client；`iss` 回跳参数与 id_token `iss` 可用于 mix-up 防护校验。
- **id_token vs userinfo**：只关心登录身份 → 验 `id_token`（本地 JWKS 验签）即可；需要最新组织/角色/状态 → 调 `userinfo`（实时、且能感知冻结）。
- **回调后拿到的 roles 是业务角色吗**：不是。`roles` 是平台治理角色；业务角色请应用内自理。
- **报错回跳**：授权失败一律 302 平台错误页（`/#/oauth/error`），不会重定向到外部地址（防开放重定向）；拒绝授权（`consent=false`）会按标准以 `error=access_denied` 回跳。
