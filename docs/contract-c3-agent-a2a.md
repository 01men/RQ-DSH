# 契约冻结 v1：Agent 自治级别（A0-A3）与 A2A 跨运行时点名调用

> **来源**：`docs/handoff-iaw-gaps-to-main.md` 交接 7-1（PRD §3.3 / §7.6；Hermes/OpenClaw/WorkBuddy 互调）
> **冻结日期**：2026-09-11｜**变更纪律**：升版须发发布说明并双侧同步（红线 1）
> **结构变更登记**：Agent 资产 attrs 增 `autonomy` / `runtime`（红线 2）

## 一、Agent 资产结构（AGENT_TYPE_SPEC，additive 字段）

| 字段 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `autonomy` | enum `A0/A1/A2/A3` | `A0` | 自治级别：A0 提示（不执行动作）/ A1 执行（低风险，人在环）/ A2 自主（事后报告）/ A3 协商（跨 Agent 双向）。面板数字同事卡「自治级别」展示位数据源 |
| `runtime` | enum `dsh/hermes/openclaw/workbuddy/external` | `dsh` | 运行时登记（A2A 互调的对端标识） |

存量登记无此二字段时按缺省口径处理（资源实体为 JSON 集合，读取兼容）。

## 二、A2A 最小闭环（v1 范围声明）

**在范围**：平台原生 Agent 作为被调方的**点名调用**端点 + 自治级别随响应透出（调用方可据此决定交互深度）。

**不在范围（诚实缺席，升版另议）**：完整 A2A 会话协商协议、跨运行时发现（discovery）、自治级别双向协商握手、A3 多方仲裁。v1 以「登记维度 + 单向点名 + 级别透出」为最小真实闭环，不做前端假实现。

## 三、端点契约

`POST /api/agents/:idOrSlug/a2a/invoke`（权限点 `agent.a2a.invoke`；`agent.*` 通配角色覆盖 resource_admin）

请求：`{ message: string（必填）, dataClass?: 'public'|'internal'|'secret', contextNote?: string }`

- 仅 `online` 状态 Agent 可被点名（其余 400，文案含状态）。
- `dataClass` 透传 modelgw 分级路由（契约 c1）：越级走渠道锁死拒绝。
- 计量：非计费零价快照事件 `resource=agent:<id>`（幂等键 `a2a:<agentId>:<principal>:<序号>`）；审计 `agent.a2a.invoke`（invoke 类，ok/error 双分支）。
- 事件：`agent.a2a.invoked`（payload：`{agentId, slug, from, model, autonomy, runtime}`）。

响应（200，业务成败以 `ok` 区分——J1 契约同形）：

```
{ ok: true,  reply, model, autonomy, runtime, inputTokens, outputTokens }
{ ok: false, reason, autonomy, runtime }          // 模型调用失败等，诚实降级
```

## 四、selftest 固化

分节「IAW 批次」内 A2A 相关断言随 Agent 域回归覆盖；权限点 `agent.a2a.invoke` 进 RBAC 越权探针矩阵（member 403）。
