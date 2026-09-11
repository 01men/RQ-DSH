# 01门 降级台账 —— panel-core/rq-card 可选服务访问点清扫（plan-gate01 Phase 2 交付物）

> 状态：**Phase 2 实施完成版**（2026-09-10）。依据 `docs/spike-cordis-optional-inject.md`：
> cordis 4.x 无 optional inject；未声明键 `ctx.<key>` 裸访问 = 硬抛 `without inject`；
> 唯一软读通道 `ctx.reflect.get(key, false)`。本台账逐点定性 9 个可选键的每一处访问。

## 降级模式（两级，审查定稿）

| 级别 | 适用键 | 行为 |
|---|---|---|
| **null-object**（记录/查询类） | `audit`、`usage`、`behavior` | 写记录=no-op；查询=空聚合（0/空数组）。业务与全量形态断言面零惊扰 |
| **特性级**（能力类） | `iam`、`authn`、`modelGateway`、`resourceCore`、`mcpRegistry`、`skillHub` | 管理端点 503 `DEGRADED`；聚合读=空数据/视为存活；SSE=干净 401；Agent/技能应答=诚实失败原因 |

## panel-core/src/index.ts（路由面）

| 位置 | 键 | 改写 |
|---|---|---|
| `changeLog`（写端点通用留痕） | audit | 软读 `?.record` → 缺席=no-op |
| `orgIdOf` | iam | 软读 → 缺席=`''` |
| GET /orgs | iam | 缺席 → 503 DEGRADED |
| PUT /:dept/config | iam | 缺席 → 503 DEGRADED |
| GET /:dept/overview（pendingActivations） | audit | 软读 `?.approvals()` → 缺席=`[]` |
| GET/POST/DELETE models、POST models/:slug/test | modelGateway | 缺席 → 503 DEGRADED |
| `refAlive` | resourceCore/mcpRegistry/skillHub/iam | 缺席 → `true`（演示态卡片全展示；既有 try/catch 保留兜运行期故障） |
| GET /board（user/roles） | iam | 软读 → 缺席=匿名角色视角 |
| GET /board（behaviorCount/usage/mcp 漏斗） | behavior/usage/mcpRegistry | **既有 try/catch 降级范式保留**（portal 范式，缺席 throw 被 catch=0/空，同时兜运行期故障） |
| GET /board（assets 聚合，原裸访问 :368-372） | resourceCore/skillHub/mcpRegistry | 软读 `?.… ?? 0` → 缺席=全 0 |
| POST /:dept/messages、:dept/skills/invoke（model 校验） | modelGateway | 软读 `?.findOne` → 缺席=视为未登记（用户显式带 model 才触发） |
| GET /industries（pendingCodes） | audit | 软读 → 缺席=`[]` |
| POST /industries/:code/activate-requests | audit | 缺席 → 503 DEGRADED |
| GET /api/panel/stream（?token= 自校验） | authn | 缺席 → 干净 401「认证中心未接入」（演示态 SSE 自校验失败=验收点） |
| apply 尾部 registerExecutor | audit | 软读 `?.… ?? (() => {})` → 缺席=不注册 |
| DingtalkDelivered 回调（fire） | audit | 软读 `?.fire` → 缺席=no-op |
| 工具 panel_board_digest（user/roles/assets） | iam/resourceCore/skillHub/mcpRegistry | 同 GET /board 改法（漏斗三键走既有 try/catch） |

## panel-core/src/service.ts（PanelService，helper `soft(key)`）

| 位置 | 键 | 改写 |
|---|---|---|
| `orgSubtreeContains` | iam | 缺席 → `false`（fail-closed；仅 dept.orgId 绑定后可达，演示态不绑组织不会走到） |
| `deptOrg` | iam | 软读 → 缺席=undefined（诚实显示未绑定） |
| `deptScopeAllowed` | iam | 软读 → 缺席按「用户不存在」处理（绑定部门 fail-closed 拒绝；未绑组织部门本就放行） |
| `deptMembers` | iam | 缺席 → `[]` |
| `agentWithAsset` | resourceCore | 缺席 → 视为未绑定资产（诚实展示） |
| `invokeAgent`（asset 解析） | resourceCore | 同上 → 转人工 |
| `invokeAgent`（invoke） | modelGateway | 软读缺席 → 显式 throw「模型网关未接入」→ 既有 catch → 诚实转人工 |
| `callerOrgId` | iam | **既有 try/catch 保留**（缺席 → `''`） |
| `askAgent`（asset 解析 / invoke） | resourceCore / modelGateway | 同 invokeAgent |
| `listInvokeableSkills` | skillHub | 缺席 → `[]` |
| `invokeSkill`（hint/record/auto-model） | skillHub/modelGateway | 软读 → 缺席=诚实失败原因/空在线目录 |
| `invokeSkill`/`askAgent`/`invokeAgent` 计量 | usage | **既有 try/catch 保留**（计量失败不阻塞） |
| `buildActivationExecutor`（grantCapabilities） | usage | **既有 try/catch 保留**（计费面独立降级） |
| `cardAction`（approval.request） | audit | 缺席 → 显式 throw「审批中心未接入」 |
| `industryStates`/`sceneSummaryForDept`/`sceneContext` | scenegraphs | **硬依赖（inject 保留），不改** |

## panel-core/src/seed/seed.ts

| 位置 | 键 | 改写 |
|---|---|---|
| 组织名自动绑定（matchedOrg） | iam | `ctx.reflect.get('iam', false)` 软读 → 缺席=部门不绑组织（范围权限全开放） |
| 内置行业激活（rootOrg） | iam | 同上 → 缺席=跳过激活登记，骨架/演示内容照常播种 |

## panel-core 鉴权（Phase 2.2，配置标志 fail-closed）

- `PanelConfig.demoAuth`（缺省 **false=严格**）：仅 cordis.patch.yml 的 01门 6-entry 装配声明；
- `requirePermission` 前置守卫：
  1. `demoAuth` 态：写动词（非 GET/HEAD/OPTIONS）→ 403 `DEMO_READONLY`；只读动词挂 `DEMO_PRINCIPAL`
     （`panel.read` + `scenegraph.read` 最小只读权限点）；
  2. 严格态 principal 缺失（console 中间件缺位/装配序异常）→ 干净 401 `UNAUTHENTICATED`
     （原 TypeError→500 修复；**绝不 fail-open**——运行时不探测 authn 在场，形态性缺席只能由装配声明表达）。

**2026-09-11 增补（写通道补环，6-entry 扩容配套）**：装配补入 iam/authn 两个宿主面 dist entry 后，
面板对**自带 Bearer 的请求**经 `authn.verify` 自校验建立 principal（与 SSE `?token=` 通道同规；
出示了令牌但校验失败 → 干净 401，**绝不降级为演示访客**）。`demoAuth` 语义随之收紧为
「**仅无有效 principal 时介入**」：匿名只读动词仍以演示访客渲染（响应带 `demo:true`，已登录用户的
响应不再误标），写动词匿名仍 403，**已登录用户写操作按其真实权限点放行**（admin `*` / 成员
`panel.write` 预设）。配套面板自持公开登录面 `POST /api/panel/auth/login|refresh`（panel 自有
命名空间，不依赖 console；authn 缺席时请求期诚实 503）——dsh Loader 并发装载 entry，
禁止任何「apply 期软读兄弟服务决定路由存在性」的竞态写法。

## plugin-rq-card（Phase 2.3）

| 位置 | 处置 |
|---|---|
| `inject`（原 5 键含 authn/iam） | 收缩为 `[httpServer, tools, opsStorage]`——authn/iam 仅被已删除的「本机初始化」使用 |
| `hostlink.ts` localFirstRun/initialPasswordFile/localInitAdmin/userPayload/localInterfaces | 整段删除（形态 B 设口令全链路，决策 1） |
| `index.ts` GET /rqcard/local-init、POST local-init/admin、POST local-init/listen-plan | 端点删除；GET /rqcard/link 响应删 `localFirstRun` 字段 |
| `wizard.js` 本机卡片 | 重写：探测同源 `/api/health` → 在场=「在本机控制台登录」链接；缺席=诚实引导连接服务器 |
| `boot.js`/`app.js` | `localFirstRun` 传参删除 |

## 验收断言（selftest，Phase 2 落地）

- 「5 键形态（config 模拟）下 board/overview 端点不 500」：仅提供 platform-core 基座服务时
  GET /api/panel/board、GET /api/panel/:dept/overview 返回 200；
- demoAuth 边界：`demoAuth:true` 时 GET 200（demo:true 语义由 Phase 4 端点补全）、
  POST/PUT/DELETE 干净 403；缺省（严格态）无 principal 时 401 而非 500。
