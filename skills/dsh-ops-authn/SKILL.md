# Skill: dsh-ops-authn

## 何时使用
机器凭证签发（Agent/应用/外部系统接入）、令牌签发与吊销、签名密钥轮换、on-behalf-of 链路验证。

## 前置条件
需要 authn.* 权限组令牌。

## 操作手册

### 场景 1：为外部系统签发机器凭证
1. `dshctl credential create --name="external:ci-system" --scope=mcp.invoke`
2. clientSecret 仅返回一次——立即转存密钥管理系统
3. 对方用法：POST /api/auth/client-credentials 换取访问令牌（2h 有效）

### 场景 2：疑似泄露应急
1. `dshctl token list --principalId=<id>` 找到全部令牌
2. `dshctl token revoke <jti> --reason="疑似泄露"` 逐个吊销
3. 严重时禁用主体（控制台认证与令牌页）或轮换签名密钥（吊销全部令牌）

### 场景 3：验证 on-behalf-of 链
POST /api/agents/<id>/obo-token（用户令牌发起）→ 返回 act 链：
用户 → Agent。审计日志的「令牌链」字段可还原完整链路。

## 护栏
- clientSecret 任何情况下不得明文落库/入日志
- 轮换签名密钥会使全部存量令牌失效，需提前公告
