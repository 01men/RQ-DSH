# 契约冻结 v1：事务流引擎（TF 编排 / 模板库 / SLA / 步骤状态机）

> **来源**：`docs/handoff-iaw-gaps-to-main.md` 交接 3-1 / 3-2 / 3-3 / 3-4（PRD M5 / §4.3 / §6.3.1 / §7.5；宿主新域 flow）
> **冻结日期**：2026-09-11｜**变更纪律**：升版须发发布说明并双侧同步（红线 1）
> **结构变更登记**：TF 记录结构（sla/progress 维度，红线 2）

## 一、定位

事务流（TF）= 从触发到归档的**多步编排**，是任务（panel:tasks 四泳道）之上的编排层；
面板执行面继续以任务为最小单元，TF 由本引擎承载（3-1 交接语义）。

## 二、数据结构（新增集合）

### FlowRecord（flow:flows，唯一键 code）

| 字段 | 类型 | 说明 |
|---|---|---|
| `code` | `tf_YYYYMMDD_xxxxxx`（唯一） | 业务编号 |
| `name` / `sceneCode?` / `dept?` / `orgId?` | string | 场景/部门/组织维度（过滤与事件路由键） |
| `templateCode?` | string | 模板实例化来源（自由编排无此字段） |
| `steps[]` | StepRecord[] | 步骤链（1-30 步） |
| `status` | `running \| completed \| cancelled \| archived` | TF 状态 |
| `slaMinutes?` / `dueAt?` | number / ISO | SLA（3-3）：dueAt=createdAt+slaMinutes；逾期=**读取时点计算**（slaBreached/overdueMinutes），无后台定时器 |
| `createdBy` / `finishedAt?` | string / ISO | — |

### FlowStepRecord（步骤）

| 字段 | 说明 |
|---|---|
| `key`（链内唯一，`[A-Za-z0-9._-]{1,40}`）/ `name` | — |
| `actorType` | `human \| agent \| gateway`（步骤型人/Agent/网关，3-1） |
| `assignee?` | human=userId / agent=数字同事名 / gateway=网关动作名 |
| `status` | `pending → running → done/blocked/skipped`；`blocked → running`（restart） |
| `startedAt?` / `finishedAt?` / `actor?` / `note?` | **时间字段齐备即甘特数据源**（3-4：前端直接渲染） |

派生视图（additive 不落库）：`progress`（done/(total-skipped)，0-100 一位小数）、`currentStep`、`elapsedMinutes`、`slaBreached`、`overdueMinutes`。

### FlowTemplateRecord（flow:templates，模板库 3-2）

`{code(唯一), name, sceneCode?, description?, steps[](模板步), slaMinutes?, contextPack?(上下文包), createdBy}`。
实例化时 `contextPack` 随创建响应返回，供调用方**自动注入**首个步骤；`slaMinutes` 未显式指定时继承模板。

## 三、状态机与事件

- 步骤动作：`start / complete / block / restart / skip`（跳序拒绝，错误文案含「不允许」）。
- `complete` 自动推进下一个 `pending` 步骤为 `running`；全链 `done/skipped` → TF `completed`（finishedAt 落时）。
- 已结束 TF（completed/cancelled）步骤不可流转（错误文案含「已结束」）。
- 平台事件（platformBus，面板 SSE 经 wireEventBus 扇出，payload 带 `dept` 时按部门路由、无 dept 广播）：
  - `flow.created` / `flow.step.updated`（每次流转）/ `flow.completed` / `flow.template.changed`。
- 真实化红线：TF 不虚构业务状态——步骤推进必须显式调用，无任何自动「假装完成」逻辑。

## 四、端点与权限（/api/flow/*，本插件自注册 guarded）

| 端点 | 权限点 |
|---|---|
| `GET /api/flow/templates?sceneCode=` | `flow.read` |
| `PUT /api/flow/templates` · `DELETE /api/flow/templates/:code` | `flow.admin` |
| `GET /api/flow/flows?sceneCode=&dept=&status=` · `GET /api/flow/flows/:id` | `flow.read` |
| `POST /api/flow/flows`（templateCode 实例化或自由编排） | `flow.write` |
| `POST /api/flow/flows/:id/steps/:key/transition`（body `{action, note?}`） | `flow.write` |
| `POST /api/flow/flows/:id/cancel` | `flow.write` |

权限点：`flow.read` / `flow.write`（member、org_admin、developer、auditor 读） / `flow.admin`（org_admin、resource_admin）；已同步 PermissionCatalog + BuiltinRoles + BUILTIN_ROLE_MIGRATION 三处。

## 五、selftest 固化

分节「IAW 3-1..3-4」：模板登记/按场景查询/member 403、模板实例化（首步 running+contextPack 注入+dueAt 折算）、跳序拒绝、自动推进、skip 收尾 completed+progress=100、详情时间轴（甘特数据源）、自由编排+取消、列表过滤与视图字段。
