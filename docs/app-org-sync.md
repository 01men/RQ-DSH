# 应用组织架构同步指南（org-sync，组织模块复用）

> 面向对象：要在应用内实现与平台一致的组织架构功能（组织树、部门成员、负责人识别）的接入应用。
> 本文档随服务发布，可直接访问 `http://<平台地址>/docs/app-org-sync.md`。

平台组织架构的事实源是 IAM 组织树 + 在职账号（钉钉等三方组织由平台连接器定时自动同步进平台，
见 README「连接器定时自动同步」）。接入应用**不需要**自连钉钉拉通讯录、也不需要自建一套部门管理——
凭应用注册时自动签发的机器凭证即可把平台组织架构整体同步进应用，在应用内复刻或关联平台同款功能：

| 平台功能 | 应用内复刻方式 |
|----------|----------------|
| 组织树（部门层级/排序） | `orgs[]` 按 `parentId` 建树、`order` 排序 |
| 部门成员（谁在哪个部门） | `users[]` 按 `orgId` 归属，`primaryOrgId` 标主归属（跨部门兼任） |
| 部门负责人（审批/汇总人） | `orgs[].leaderUserIds` 直接给出，无需自建名单 |
| 登录身份 ↔ 部门挂接 | SSO `userinfo.sub` 即 `users[].id`，登录后直接定位部门/负责人 |

分工记忆：**登录（app-sso-integration.md）管"一个人来"，org-sync（本文档）管"组织长什么样、谁在哪个部门"**。

## 一、端点与数据契约

```
GET /api/apps/<appId>/org-sync          （Bearer 机器凭证令牌）
GET /api/apps/<appId>/org-sync?ifNoneMatch=<上次version>   （变更轮询）
→ 200 {
  unchanged: false,
  version: "9f2c1a4b7de30c58",
  generatedAt: "2026-09-15T02:00:00.000Z",
  orgs:  [{ id, name, parentId, order, status, leaderUserIds: ["<平台用户ID>"], updatedAt }],
  users: [{ id, username, displayName, title, jobNumber, orgId, orgName,
            primaryOrgId?, status, accountType?, updatedAt }]
}
```

- **授权（默认自助）**：绑定本应用的机器凭证（注册时自动签发，`refType:'app'`，默认 scope 已含所需
  `app.read`）、应用 owner、平台管理员可调；其他身份一律 403。**无需管理员追加任何 scope**。
- **关联键**：`users[].id` 即 OIDC `userinfo` 的 `sub`——名册铺的组织数据与登录回流的身份直接对上，
  应用内一张 `sub → 部门/负责人` 视图即可把两条通道拼起来。
- **`version`**：组织+成员**内容哈希**（16 位 hex）。任一组织/成员记录变更即变；内容不变则恒定。
  带 `?ifNoneMatch=<version>` 请求，未变化时返回 `{unchanged:true, version}`（无 orgs/users 载荷）。
- **快照即事实**：返回当前全量。检测到变化后拉全量并**整体覆盖**应用本地副本（删库重建或按 id 对齐均可），
  不做增量合并——组织删除/移动/改属不会在应用内留孤儿数据。
- **PII 最小化**：不含手机号、邮箱、角色、密码与三方绑定字段；已注销（deactivated）账号不出现；
  `status` 照常返回，应用业务只应面向 `active` 账号。
- **审计**：每次拉取记 invoke 审计（谁在何时拉了多少 / unchanged），可在控制台审计日志检索 `app.org-sync.pull`。

字段速查：

| 字段 | 含义 | 应用侧典型用法 |
|------|------|----------------|
| `orgs[].id` | 组织 ID（稳定） | 本地部门表主键 |
| `orgs[].parentId` | 父组织 ID（根为 null） | 建组织树 |
| `orgs[].order` | 同级排序号 | 树排序（次序键 `order` → `name`） |
| `orgs[].leaderUserIds` | 部门负责人（平台用户 ID，可多个） | 审批流/汇总人识别 |
| `orgs[].status` | active / archived | archived 部门不再展示（保留 id 便于历史数据归位） |
| `users[].id` | 平台用户 ID = SSO `sub` | 成员表主键、登录身份挂接 |
| `users[].orgId` | 归属组织 | 部门成员列表 |
| `users[].primaryOrgId` | 主归属组织（跨部门兼任时与 orgId 不同） | 兼任语义：主归属外仅只读类场景 |
| `users[].status` | pending / active / frozen / deactivated(不出现) | 只对 active 铺业务 |
| `users[].accountType` | internal / external / suspended-review | 外部顾问账号可差异化处理 |

## 二、同步流程（接入过程中完成，三步）

1. **换牌**（同接入指引第 1 步）：

```bash
curl -s -X POST <平台地址>/api/auth/client-credentials \
  -H 'content-type: application/json' \
  -d '{"clientId":"<mc-开头>","clientSecret":"<cs-开头>"}'   # → data.token（2 小时有效）
```

2. **首拉全量**，落地本地部门表/成员表：

```bash
curl -s "<平台地址>/api/apps/<appId>/org-sync" -H "Authorization: Bearer <token>"
```

```js
// 应用后端（Node 示例）：全量对齐 + version 轮询
async function syncOrg(token) {
  const res = await fetch(`${PLATFORM}/api/apps/${APP_ID}/org-sync?ifNoneMatch=${db.meta.orgVersion ?? ''}`,
    { headers: { authorization: `Bearer ${token}` } })
  const { data } = await res.json()
  if (data.unchanged) return            // 内容未变，零处理
  db.transaction(() => {                // 快照即事实：整体覆盖本地副本
    db.orgs.replaceAll(data.orgs); db.users.replaceAll(data.users)
    db.meta.orgVersion = data.version
  })
}
```

3. **定时轮询**：建议「用户登录后 + 每日一次」各拉一次（带 `ifNoneMatch`，未变时平台只回一个小 JSON）；
   不要高频轮询——组织数据以天级变化为主，平台每次全量拉取都会记审计。

## 三、应用内落地：复刻平台组织架构功能

组织树构建（`parentId` 建树、`order`→`name` 排序，与平台控制台同规则）：

```tsx
function buildTree(orgs: Org[]): TreeNode[] {
  const nodes = new Map(orgs.map((o) => [o.id, { ...o, children: [] as TreeNode[] }]))
  const roots: TreeNode[] = []
  for (const node of nodes.values()) {
    const parent = node.parentId && nodes.get(node.parentId)
    parent ? parent.children.push(node) : roots.push(node)
  }
  const sortRec = (list: TreeNode[]) => {
    list.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh'))
    list.forEach((item) => sortRec(item.children))
  }
  sortRec(roots); return roots
}
```

- **部门人员选择器**：按 `orgId` 精确匹配 + 子树包含两种口径（`users[].orgId` 是否落在目标部门子树）；
  跨部门兼任人员出现在其每个归属部门，主归属以 `primaryOrgId` 为准。
- **负责人识别**：目标部门 `leaderUserIds` 非空即取之；为空时沿 `parentId` 向上找最近祖先部门的负责人
  （与平台 NAS 数据权限「最近负责人」口径一致），都不为空再回退到应用管理员。
- **与 SSO 登录关联**：`userinfo.sub` → `users` 表查得部门/负责人/职务，登录后界面即可按部门组织数据视图；
  `sub` 在 `users` 表中不存在时（如外部账号），按应用自身访客逻辑处理，不要报错阻断登录。
- **状态纪律**：业务任务/审批只面向 `status === 'active'`；`frozen` 账号在应用内同步冻结；
  `accountType === 'external'` 的外部顾问按应用策略差异化（平台侧默认按外部账号收紧数据权限）。

## 四、与全员名册（/api/iam/roster）的关系

| | org-sync（本文档） | /api/iam/roster |
|---|---|---|
| 授权 | 应用绑定凭证**默认自助** | 需管理员为凭证追加 `iam.roster.read` scope |
| users 字段 | 无 email（PII 更小） | 含 email、组织名等 |
| orgs 字段 | 含 `order`/`updatedAt` | 无排序/更新时间 |
| 变更检测 | `version` + `ifNoneMatch` 零载荷轮询 | 全量重拉自行比对 |
| 端点归属 | 按应用隔离（`/api/apps/:id/…`，owner 校验） | 全局名册（invoke 审计） |

**选择建议**：只要组织架构功能（树/成员/负责人）→ org-sync；还需要 email 做全员通知/人事台账 → roster。
两者 `users[].id` 同键，可并存（org-sync 供界面，roster 供任务铺排）。

## 五、安全与合规边界

- **仅服务端到服务端**：机器凭证只存在应用后端，禁止下发到浏览器/客户端（与 SSO 的 public 客户端是两回事）。
- **最小化使用**：同步的组织数据仅用于应用内组织功能实现，禁止转投第三方、禁止对外暴露原始名册接口。
- **平台是事实源**：组织变动经平台连接器自动同步（含负责人 `dept_manager` 链），应用侧只读消费；
  发现组织数据与钉钉不一致时先在平台控制台「组织管理」核对，不要在应用内手改部门数据。
- **审计可追溯**：每次拉取（含 unchanged 轮询）在平台审计日志留痕（`app.org-sync.pull`）。
