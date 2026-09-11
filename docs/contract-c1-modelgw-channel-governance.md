# 契约冻结 v1：模型渠道治理面（分级路由 / 降级链 / 遥测 / 预算熔断）

> **来源**：`docs/handoff-iaw-gaps-to-main.md` 交接 1-1 / 1-2 / 1-3 / 1-4（PRD M2 / §4.1 / §6.2.2 / §7.2 / §7.10）
> **冻结日期**：2026-09-11｜**变更纪律**：升版须发发布说明并双侧同步（红线 1）
> **结构变更登记**：`ModelRecord.dataClassLimit`（红线 2：记录结构变更走契约冻结）

## 一、数据结构（additive-only）

### ModelRecord（modelgw:models，additive 字段）

| 字段 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `dataClassLimit` | `'public' \| 'internal' \| 'secret'` | `'internal'`（存量登记兼容） | 渠道可承载的**最高**数据分级上限。分级序：public(0) < internal(1) < secret(2) |

### 渠道组 ChannelGroupRecord（modelgw:channelGroups，新增集合）

| 字段 | 类型 | 说明 |
|---|---|---|
| `slug` | string（唯一） | 组标识，调用方按组点名 |
| `primary` / `backup1` / `backup2` | string（模型 slug） | 降级链：主 → 备1 → 备2（可只配主） |
| `manual` | boolean | 链尾转人工：true 时全链失败返回 `ok:false + escalated:true`，不造假回复 |
| `stepTimeoutMs` | number（500-60000，缺省 8000） | 单步超时（PRD §4.1 口径 8s） |
| `enabled` | boolean | 停用组拒绝调用 |

### 预算 BudgetRecord（modelgw:budgets，新增集合）

| 字段 | 类型 | 说明 |
|---|---|---|
| `orgId` | string（缺省=平台级） | 组织维度；org 专属优先于平台级匹配 |
| `modelSlug` | string（缺省=全部模型） | 模型维度收敛 |
| `dailyLimitCents` / `monthlyLimitCents` | number（分，至少一项） | 日/月上限（UTC 日界，与 usage 报表口径一致） |
| `warnRatio` | number（缺省 0.8） | used/limit ≥ warnRatio 触发 `modelgw.budget.warning`（每预算每自然日最多 1 条） |
| `action` | `'warn' \| 'block'` | block=任一窗口 breached 时**调用前**熔断（抛错，文案含「预算熔断」） |

### 遥测 TelemetryRecord（modelgw:telemetry，新增集合，滚动保留 8 天）

逐次调用记录 `{model, at, ok, latencyMs, outputTokens, degraded?, error?}`。

## 二、调用语义

### 分级路由（1-1）

- `modelGateway.invoke(input)` 增可选 `input.dataClass`（缺省 `'internal'`）。
- 判定：`DATA_CLASS_RANK[渠道.dataClassLimit] < DATA_CLASS_RANK[请求.dataClass]` → 直接拒绝，错误文案含「数据分级越界」与「锁死」（供面板选择器锁死+原因展示）。
- 候选过滤：`modelGateway.resolveChannels(dataClass, {onlineOnly?})` 返回 `{available, excluded[]（含 reason 文案）}`。
- 降级链每一步同样执行分级校验——**备用渠道分级低于请求数据分级时同样锁死**（降级不降密级）。

### 降级链（1-2）

- 入口：`modelGateway.invokeWithFallback({group, …invoke 入参})`；HTTP 面 `POST /api/modelgw/channel-groups/:slug/invoke`。
- 触发条件：超时（stepTimeoutMs）/ 上游 5xx / 网络错误；**4xx 上游错误同样降级**（视为该渠道本次不可用）。
- 每次降级：emit 平台事件 `modelgw.degraded`（payload：`{group, from, to, reason, step, subject, orgId}`）——面板 SSE 通道可直接消费做提示条；遥测记 `degraded: true`。
- 内容安全拦截：**诚实缺位**——外部内容安全网关未接入，接入后在 invokeOnce 返回路径挂钩（本契约 v1 不预支该能力）。

### 遥测（1-3）

`GET /api/modelgw/:slug/telemetry?window=7d`（1-30d）返回：

```
{ model, windowDays, invocations, failures, availability(0-1|null), p50LatencyMs,
  avgTps(output_tokens/总时延,代理口径), adoptionRate(model:<slug> 反馈聚合|null),
  degradedInvocations, ttftMs: null, note }
```

**TTFT 诚实缺列**：非流式单轮无法测首 token 时延，`ttftMs` 恒 null 并随 `note` 声明口径；网关流式通道上线后升版补真值。

## 三、端点与权限

| 端点 | 权限点 | 说明 |
|---|---|---|
| `GET /api/modelgw/channel-groups` | `panel.read` | 组列表（附 chain/stepTimeoutMs 缺省展开） |
| `PUT /api/modelgw/channel-groups` | `panel.config.write` | 登记渠道组（校验模型已登记） |
| `POST /api/modelgw/channel-groups/:slug/invoke` | `panel.write` | 降级链调用（返回带 `degradations[]`；manual 链尾=200+`ok:false+escalated:true`） |
| `GET /api/modelgw/:slug/telemetry?window=` | `panel.read` | 遥测聚合（未登记模型 404） |
| `GET /api/modelgw/budgets?org=` | `panel.read` | 预算查询 |
| `PUT /api/modelgw/budgets` | `panel.config.write` | 预算登记（同键 upsert） |

`POST /api/modelgw/models` 与 `POST /api/panel/models` 增 `dataClassLimit` 透传；`POST /api/modelgw/invoke` 增 `dataClass` 透传（additive，缺省 internal）。

## 四、selftest 固化

`npm run selftest` 分节「IAW 1-1..1-4」：双 stub（主 500/备 200）验证分级锁死文案、降级接管 + degradations 留痕、可用率与 ttft 缺列口径、预算熔断与摘要预算进度回显。
