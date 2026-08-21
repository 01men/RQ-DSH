# 衡 · 企业 AI 资源统一管理平台

基于 **DeepSeek Harness（dsh）「一切皆插件」** 架构实现的企业级 AI 资源纳管与治理平台。
对应设计方案：《企业服务资源统一管理方案 V1.0》与《技术实现规划》。

> 组织账号（IAM）· 统一认证（Authn）· MCP 部署服务 · Skill 市场 · Agent 本体 · AI 应用本体 · 审计与告警
> ——五类资源，一套身份、一套权限、一套审计。

---

## 一、快速开始

```bash
npm install          # 安装依赖（@deepseek-ai/cordis）
npm start            # 启动平台（默认 http://127.0.0.1:7300）
```

打开 **http://127.0.0.1:7300** 进入管理控制台（首次启动自动初始化演示数据）。

**演示账号**（密码均为 `Ybk@2026`）：

| 账号 | 角色 | 用途 |
|---|---|---|
| `admin` | 平台超级管理员 | 全功能 |
| `ops` | 资源管理员 | MCP/Skill/Agent/应用管理 |
| `hr` | 组织管理员 | 组织/账号/三方同步 |
| `dev` | 开发者 | 提交 Skill、注册 Agent |
| `audit` | 审计员（只读） | 审计与告警 |

钉钉免密登录演示：登录页「钉钉扫码」输入工号 `DD0002`（林小满）。

```bash
npm run selftest      # 功能自测：隔离实例 82 项端到端断言
node cli/dshctl.mjs help    # CLI 帮助
```

## 二、架构：一切皆插件

运行中的平台就是一棵 **cordis 插件树**（与 dsh 同一插件框架，`@deepseek-ai/cordis`）。
每个业务域 = 一个插件包，独立声明依赖/权限点/事件，可独立启停：

```
接入层   dsh-plugin-console        REST 网关 + 控制台 SPA + 工具桥 + 种子数据
业务域   dsh-plugin-iam            组织/账号/角色/用户组/三方连接器（钉钉演示）
         dsh-plugin-authn          双轨身份 + 令牌 + on-behalf-of 链
         dsh-plugin-mcp            部署/灰度/回滚/健康熔断/权限组/调用网关/监控
         dsh-plugin-skillhub       提交→静态扫描→两级审批→版本化上架
         dsh-plugin-agent          Agent 本体（resource-core 底座 + 机器凭证）
         dsh-plugin-app            AI 应用（编排拓扑 + 应用指标 + 成本穿透）
         dsh-plugin-audit          四类审计日志 + 告警规则 + 成本归集 + 审批中心
底座     dsh-plugin-resource-core  资源本体：属性 schema + 生命周期状态机 + 依赖图
基础层   dsh-plugin-platform-core  存储(JSON集合/原子落盘) + 事件总线 + ToolRuntime-lite + HTTP
```

**插件协作铁律**：状态变更必发事件；跨插件联动只通过事件总线或扩展点（`ctx.platformBus`），
禁止直连对方数据。例：`iam.user.frozen → authn 吊销全部令牌`、`agent.offlined → 凭证吊销 + 绑定用户通知`、
`skill.deprecated → 引用 Agent 告警`、`mcp.unhealthy → 熔断 + 审计`。

### 一份插件代码，两种宿主

- **独立宿主**（本项目默认）：`node src/main.ts` 启动完整平台（控制台 + API + 工具）。
- **完整 dsh 运行时**：`cordis.yml` 把同一批插件挂载进 `dsh web`——此时平台注册的
  **37 个运维工具**直接对模型可见（`provideToolRuntime: false`，使用 dsh 原生 ToolRuntime），
  Agent 即可按自然语言运维整个平台。

```bash
# 在 deepseek-harness 源码检出中（替换 <PROJECT_ROOT> 为绝对路径）：
pnpm dsh web --patch <PROJECT_ROOT>/cordis.yml
```

## 三、目录结构（插件标准解剖）

```
packages/
  platform-core/            基础层插件
  plugin-<name>/            每个业务插件：
    plugin.yaml             声明：id/version/depends/permissions
    manifest/
      api.yaml              REST + 工具 + 服务键（三端对齐的事实源）
      permissions.yaml      权限点（注册进统一 RBAC）
      events.yaml           发布/订阅事件
      ui.yaml               路由 + 菜单
    src/index.ts            服务 + 插件装配
    src/tools.ts            对模型暴露的工具（dsh ToolRuntime 契约）
  plugin-console/public/    控制台 SPA（原生 ES Modules，零构建）
cli/dshctl.mjs              CLI（--output json|table / --dry-run / --yes）
skills/dsh-ops-*/SKILL.md   8 个运维 Skill（含 dsh-ops-admin 总控索引）
scripts/selftest.mjs        功能自测（82 项断言）
scripts/gen-manifests.mjs   插件声明生成器
src/main.ts                 独立宿主入口
cordis.yml                  dsh 接入 overlay
```

## 四、核心能力对照（方案 → 实现）

| 方案条目 | 实现 |
|---|---|
| 组织/账号/角色/用户组（§2） | 多级组织树、批量导入、账号状态机、动态/静态用户组、权限点矩阵 |
| 三方同步与冲突（§2.1/2.3） | OrgConnector 接口 + 钉钉模拟连接器、全量同步、三种冲突策略、对比式冲突工单 |
| 统一认证（§7） | 双轨身份、HMAC 短期令牌（默认 2h）、吊销/轮换、Client Credentials |
| on-behalf-of（§5.5/6.5） | 用户→Agent 令牌链（act 叠加），审计可还原完整链路 |
| MCP 部署/灰度/回滚（§3.2） | 草稿→验证→灰度→全量，版本不可变，一键回滚 |
| MCP 令牌网关（§3.3/3.4） | 统一鉴权（权限组 + Tool 粒度 + 只读约束）、限流、熔断、调用监控（P95/成功率/Token） |
| Skill 市场（§4） | 静态扫描（恶意代码/密钥泄露自动驳回）、两级审批（高风险安全加签）、版本化、安装登记依赖、弃用告警 |
| Agent 本体（§5） | 属性表三组（基本/技术/治理）、注册颁发机器凭证、用户绑定、监测指标、生命周期 L4 |
| AI 应用本体（§6） | 应用 schema、编排拓扑（SVG 一图穿透）、DAU/留存、成本穿透 |
| 安全与审计（§7） | 四类日志、告警规则引擎、越权计数告警、成本多维报表 |
| L4 护栏（§4.4） | 上线/下线/下架/吊销强制审批单，双人确认（发起人不可自审），执行结果回写 |

## 五、控制台交互（飞书式）

- **⌘K 命令面板**：搜资源（Skill/Agent/应用/MCP）、跳页面、执行高频动作
- **角色化工作台**：待办审批 + 告警 + 事件流 + 成本趋势
- **任务式导航**：按"要做什么"组织（市场/本体/治理/组织）
- **详情一律右侧抽屉**：列表不跳页；Agent/应用详情六页签（概览/监控/权限/拓扑/审计/生命周期）
- **渐进式表单**：必填最小集创建草稿，上线前强制补全治理属性
- **危险操作可逆感知**：dry-run 影响面预览、L4 审批时间线、原因必填
- **空状态即引导**：插画 + 一句话 + 主按钮
- 统一徽章体系 / 红绿灯健康 / 灰度进度条 / SVG 图表（无第三方依赖）

## 六、常用 API 与 CLI

```bash
# CLI（机器可读优先）
node cli/dshctl.mjs mcp list --output json
node cli/dshctl.mjs mcp deploy <id> --dry-run --changelog="优化召回"
node cli/dshctl.mjs agent offline <id> --reason="连续异常"    # 生成 L4 审批单
node cli/dshctl.mjs approval decide <id> --decision=approve --opinion="已确认"
node cli/dshctl.mjs tool exec --name=agent_list --args='{"status":"online"}'
```

```bash
# REST（Bearer 令牌）
curl -X POST localhost:7300/api/auth/login -H 'content-type: application/json' \
     -d '{"username":"admin","password":"Ybk@2026"}'
curl localhost:7300/api/overview -H "authorization: Bearer <token>"
```

## 七、自测

`npm run selftest` 在独立端口 + 独立数据目录启动隔离实例，覆盖 **82 项端到端断言**：
登录/RBAC 越权、冻结→令牌联动吊销、机器凭证与 scope 越权、MCP 灰度/回滚/网关鉴权（含只读约束拦截）、
Skill 恶意提交驳回与两级审批、Agent 属性校验与 L4 双人审批（含自审拦截）、on-behalf-of 链、
审计四类日志与筛选、告警、成本穿透、工具桥执行。

## 八、说明与边界

- 存储为 JSON 集合（原子落盘、启动恢复），替换 `ctx.storage` 实现即可切换数据库
- MCP 执行层为确定性模拟传输（延迟/成功率/Token 可配），管理面与网关语义为真实实现
- 钉钉连接器为模拟目录服务，接口（`syncFull/healthCheck/authLogin`）与真实 OpenAPI 对齐
- Node ≥ 22.6（原生 TypeScript 运行，无需构建步骤）
