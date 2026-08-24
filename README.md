# 衡 · 企业 AI 资源统一管理平台

基于 **DeepSeek Harness（dsh）「一切皆插件」** 架构实现的企业级 AI 资源纳管与治理平台。
对应设计方案：《企业服务资源统一管理方案 V1.0》与《技术实现规划》；生态平台演进设计见
[docs/ecosystem-design-v1.2.md](docs/ecosystem-design-v1.2.md)，后续路线见 [docs/roadmap-9-10.md](docs/roadmap-9-10.md)。

> 组织账号（IAM）· 统一认证（Authn + OIDC Provider）· MCP 部署服务 · Skill/插件市场 · Agent 本体 ·
> AI 应用本体 · 计量计费（usage）· 钱包与复式分账（billing）· 模型转售网关（modelgw）· 审计与告警
> ——多类资源，一套身份、一套权限、一套计量、一套审计。

---

## 一、快速开始

```bash
npm install          # 安装依赖（@deepseek-ai/cordis）
npm start            # 启动平台（默认 http://127.0.0.1:7300）
```

打开 **http://127.0.0.1:7300** 进入管理控制台。首次启动在空数据目录上执行**基线初始化**（生产形态）：
内置角色 + 根组织 + 平台管理员 `admin`（无任何演示业务数据）。

- `admin` 口令取 `ADMIN_PASSWORD` 环境变量；未设置则随机生成，一次性写入 `data/admin-initial-password.txt` 并打印在启动日志（请立即登录并妥善保管）。
- 忘记口令：清空数据目录重启，或由持有 `iam.user.write` 的管理员在「组织与账号 → 账号详情 → 重置口令」重置。

**演示模式**（评估/培训，自动生成完整演示数据与演示账号，口令均为 `Ybk@2026`）：

```bash
DEMO_SEED=1 npm start   # 首次启动注入演示数据（组织树/演示账号/MCP/Skill/Agent/应用/28 天历史）
```

| 演示账号 | 角色 | 用途 |
|---|---|---|
| `admin` | 平台超级管理员 | 全功能 |
| `ops` | 资源管理员 | MCP/Skill/Agent/应用管理 |
| `hr` | 组织管理员 | 组织/账号/三方同步 |
| `dev` | 开发者 | 提交 Skill、注册 Agent |
| `audit` | 审计员（只读） | 审计与告警 |

演示模式下钉钉免密登录可用（mock 连接器）：登录页「钉钉扫码」输入工号 `DD0002`（林小满）；生产基线不配置连接器，三方登录入口自动隐藏。

```bash
npm run selftest      # 功能自测：隔离实例（DEMO_SEED）244 项端到端断言
npm run lint:manifests  # 插件清单五面 YAML 校验（60 项）
DSHCTL_USER=admin DSHCTL_PASS=*** node cli/dshctl.mjs help    # CLI 帮助（凭据经环境变量或 DSHCTL_TOKEN 提供）
```

### 平台自更新（v1.1+）

两类安装形态（GitHub 源码检出 / dsh 插件市场安装）都能感知上游仓库新版本，**是否升级永远由管理员决定**：

- **自动检查**：默认每 24h 一次（启动 15s 后首查），比对远端 `package.json` 版本 + GitHub compare 提交差；
  发现新版本 → 控制台顶栏「可更新」徽标 + `platform.update.available` 事件（audit 留痕）。控制台抽屉可开关/调频。
- **手动升级**：控制台顶栏徽标 → 抽屉「一键升级」（source 形态：`git pull --ff-only` + `npm install`，支持
  dry-run 预演、原因留痕、完成后提示重启）；CLI：`dshctl update status | check | apply [--dry-run]`；
  Agent 工具：`update_status` / `update_check` / `update_apply`。bundle 形态给出 `dsh plugin update` 指引。
- **内网/限流**：`GITHUB_TOKEN` 提升限额；`DSH_UPDATE_API_BASE` / `DSH_UPDATE_RAW_BASE` 指向私有镜像；
  `DSH_UPDATE_AUTO_CHECK=off` 关闭自动检查。权限点：`platform.update.read`（查看/检查）、`platform.update.apply`（升级）。

> **企业部署 / Agent 一键接入**：部署 runbook、dsh 运行时接入与「可直接下达给 dsh 自带 Agent 的一键部署指引」
> 见 [docs/deploy-enterprise.md](docs/deploy-enterprise.md)；日常运维 Agent 指引见 `skills/dsh-ops-admin/SKILL.md`。

## 二、架构：一切皆插件

运行中的平台就是一棵 **cordis 插件树**（与 dsh 同一插件框架，`@deepseek-ai/cordis`）。
每个业务域 = 一个插件包，独立声明依赖/权限点/事件，可独立启停：

```
接入层   dsh-plugin-console        REST 网关 + 控制台 SPA + 工具桥 + 种子数据
业务域   dsh-plugin-iam            组织/账号/角色/用户组/三方连接器（钉钉演示）
         dsh-plugin-authn          双轨身份 + 令牌 + on-behalf-of 链
         dsh-plugin-mcp            部署/灰度/回滚/健康熔断/权限组/调用网关/监控（真实 HTTP 传输层）
         dsh-plugin-skillhub       提交→静态扫描→两级审批→版本化上架
         dsh-plugin-agent          Agent 本体（resource-core 底座 + 机器凭证）
         dsh-plugin-app            AI 应用（编排拓扑 + 应用指标 + 成本穿透）
         dsh-plugin-usage          计量管道（schema v1 / 幂等 / 死信重放 / 价格簿 / 三方对账 / 能力漂移）
         dsh-plugin-billing        钱包 + 只追加流水 + 复式分账 ledger（结转/试算平衡/红字冲正）
         dsh-plugin-modelgw        模型转售网关（OpenAI 兼容真实转发 / 预检 / 实测 tokens 计量）
         dsh-plugin-market         第三方与自营插件市场（契约五面 / Ed25519 验签 / L0 运行时 / 订阅代收）
         dsh-plugin-audit          四类审计日志 + 告警规则 + 成本归集 + 审批中心
         dsh-plugin-connect        远程 dsh 接入（宿主角色：接入码/enroll/客户端管理；客户端角色：凭证申请 + 工具远程代理 + 本机配置页）
         dsh-plugin-update         平台自更新：上游版本检查（自动+手动）→ 通知 → source 形态一键升级（git pull + npm install，dry-run/审计/权限点）
底座     dsh-plugin-resource-core  资源本体：属性 schema + 生命周期状态机 + 依赖图
基础层   dsh-plugin-platform-core  存储(JSON集合/原子落盘) + SQLite 事务存储 + YAML 解析 + 事件总线 + ToolRuntime-lite + HTTP
```

**插件协作铁律**：状态变更必发事件；跨插件联动只通过事件总线或扩展点（`ctx.platformBus`），
禁止直连对方数据。例：`iam.user.frozen → authn 吊销全部令牌`、`agent.offlined → 凭证吊销 + 绑定用户通知`、
`skill.deprecated → 引用 Agent 告警`、`mcp.unhealthy → 熔断 + 审计`。

### 一份插件代码，两种宿主

- **独立宿主**（本项目默认）：`node src/main.ts` 启动完整平台（控制台 + API + 工具）。
- **完整 dsh 运行时**：`cordis.yml` 把同一批插件挂载进 `dsh web`——此时平台注册的
  **运维工具**直接进入 dsh 原生 ToolRuntime、对模型可见可调用（`provideToolRuntime: false`），
  Agent 即可按自然语言运维整个平台（「列出所有 MCP 服务和健康状态」→ `mcp_service_list`，
  「Skill 市场里能装什么」→ `skill_search`）。

**源码检出模式（本地开发）**——两条硬性要求，缺一不可：

1. `cordis.yml` 中 `<PROJECT_ROOT>` 必须替换为 `file:///` URL 形式的绝对路径
   （Windows 下裸盘符路径会被 ESM 判为 `ERR_UNSUPPORTED_ESM_URL_SCHEME`）；
2. 本项目 `node_modules/@deepseek-ai/cordis` 必须指向 dsh 源码树的 `vendor/cordis`
   （junction），保证插件与宿主加载**同一个 cordis 实例**——两份实例会导致
   `ctx.plugin(类插件)` 静默失效、服务链（iam→usage→audit…）全部 `pending`：

```powershell
# 一次性设置（PowerShell，替换两处路径为你的实际检出位置）：
Remove-Item -Recurse -Force node_modules/@deepseek-ai/cordis
New-Item -ItemType Junction -Path node_modules/@deepseek-ai/cordis -Target D:\dsh-harness\vendor\cordis

# 之后每次（在 deepseek-harness 源码检出中）：
pnpm dsh web --patch <本项目绝对路径>/cordis.yml
```

**安装模式（发布使用）**——`dsh plugin add` 走 pnpm 安装，补丁里的 entry 以
「包名 + 子路径」声明（Node 从 profile 目录沿 node_modules 解析，无需感知安装位置）：

```bash
dsh plugin --profile web add github:01men/ybkk-AIOS
# 验证：dsh --profile web --dump-config 应列出全部 ops-* entry；
# 会话中问「列出所有 MCP 服务和健康状态」，模型应调用 mcp_service_list 而非静态作答。
```

安装模式的关键约束：`@deepseek-ai/cordis` 只在 `devDependencies`（本地开发/独立宿主用），
**绝不能进 `dependencies`**——否则 pnpm 会把它 hoist 进 profile 的 node_modules，
插件解析到第二份 cordis 实例，服务链整体失效（同上）。安装后插件沿
`<profile>/node_modules → $DSH_HOME/profiles/node_modules`（dsh 自建的宿主闭包 symlink）
解析到宿主自己的 cordis。

**平台服务键已做宿主去冲突**：JSON 存储服务键为 `opsStorage`（不是 `storage`——
dsh 宿主自带同名 `storage` 服务，曾导致 iam 等插件构造时拿到宿主服务、方法不存在而崩溃）。
`tools` 键是**刻意共享**的接缝：独立宿主下由 ToolRuntimeLite 提供，dsh 下即原生
ToolRuntime——37 个运维工具由此进入 dsh。

**领域 Skill 手册**（`skills/dsh-ops-*/SKILL.md`）默认不随插件自动进入 dsh 技能系统
（dsh 只扫描 `<project>/.dsh/skills`、`~/.dsh/skills` 等根目录）。要让 Agent 获得
分领域操作手册，复制或链接一份：

```bash
# 用户级（所有会话可用）：
cp -r skills/dsh-ops-* ~/.dsh/skills/
# 或项目级（仅当前项目）：
mkdir -p .dsh/skills && cp -r skills/dsh-ops-* .dsh/skills/
```

### 远程 dsh 接入（第三种形态：免源码、免同机共享 data）

其他电脑经插件市场安装本平台后（安装模式见上），无需源码检出、也无需与宿主共享
`data/` 目录——插件树中的 `plugin-connect` 以 **client 角色**运行，向宿主平台申请
机器凭证并把全部运维工具的执行**远程代理**到宿主（权限按模板收敛、全程审计）：

```text
宿主侧（管理员，一次性）            远程电脑（使用者，两条通道任选）
────────────────────────          ─────────────────────────────────
控制台「平台接入」页创建接入码   →   ① dsh 界面对 Agent 说：
（一次性，默认 15 分钟有效，           「接入宿主 http://宿主IP:7300，
 模板：readonly/operator/full）        接入码 enr_xxx…」
                                   Agent 调 connect_setup 自动申请口令
                                   ② 浏览器打开 http://127.0.0.1:7390
                                      本机配置页可视化填写/更新/断开
```

接入成功后：远程 dsh 里的 37 个运维工具自动切换为**转发宿主执行**（本地不再持有数据），
另新增 `connect_status / connect_setup / connect_login / connect_test / connect_reset`
5 个接入工具供 Agent 自助管理；宿主控制台「平台接入」页可查看已接入客户端、最近使用，
并可随时禁用（联动吊销全部机器令牌，立即生效）。宿主侧另有 4 个接入管理工具
（`connect_code_create / connect_codes / connect_clients / connect_client_disable`）。

安全基线：接入码只存哈希（创建时一次性展示）、一次性消费、TTL 可配、按来源 IP
接入宿主既有失败锁定（15 分钟窗口 5 次锁定）；机器凭证等价口令仅保存在远程电脑本机
（0600）；`enroll` 端点公开但接入码本身即凭证。

详细流程与验收清单见 [docs/deploy-enterprise.md](docs/deploy-enterprise.md) 第四节。

### 已融合 OS-skill 模块设计（v1.1）

选择性吸收了 [01men/OS-skill](https://github.com/01men/OS-skill) 两个模块中具有长远价值的设计（决策全记录见 [docs/roadmap.md](docs/roadmap.md)）：

- **IdentityProviderAdapter 统一身份源抽象**（auth-identity docs/03）：三方登录主流程面向接口编程，钉钉/飞书/企微差异收敛在 Adapter 内
- **引擎级唯一约束**（红线工程化）：`collection.uniqueOn()` 模拟数据库部分唯一索引，「一人一号」等业务唯一性由存储引擎兜底，取代「先查后插」
- **refresh_token 轮转链 + sid 会话**（docs/06）：access 30min + refresh 7d 仅存哈希、单次轮转，重放即整链吊销；前端 401 静默续期
- **state 防 CSRF + code 一次性消费 + 未命中绑定/注册分支**（docs/04/05/07）：完整的三方登录产品化流程
- 自测含安全攻击演练（state/code/refresh 重放、唯一约束冲突），详见 `npm run selftest`

## 三A、生态平台 v1.2 交付（第 0–8 步，本迭代）

在 v1.0 基础上完成生态化演进（实施依据 [docs/ecosystem-design-v1.2.md](docs/ecosystem-design-v1.2.md)）：

- **执行层/连接器真实化（第 0 步）**：MCP 真实 HTTP JSON-RPC 传输层（探活/超时/错误路径/实测 tokens）、
  钉钉真实 OpenAPI 连接器（corp token → 部门 BFS → 成员分页）、SQLite 事务存储（WAL/幂等唯一索引/只追加表）。
- **令牌收紧（第 1 步）**：`aud` 受众校验 + 插件 scope 命名空间强制（唯一收敛面）。
- **多租户最小集 + 计量管道（第 2/4 步）**：租户建模、schema v1 计量事件、先写后发、引擎级幂等、
  死信重放、价格簿（计价时点费率快照）、三方对账、运行时能力漂移检测。
- **契约五面 + L0 市场（第 3/7 步）**：第三方开发者身份域、契约五面 Ed25519 验签、内容扫描、
  L1 门禁、审批上架/安装/卸载、L0 提示词运行时与计量、自营首批供给与订阅代收登记。
- **钱包与模型网关（第 5 步）**：余额+流水同事务、乐观锁、幂等键、月度预算预检、余额恒等式全量重放；
  模型转售网关真实 OpenAI 兼容转发（无 endpoint 拒绝调用，不造假 completion）。
- **OIDC Provider（第 6 步）**：RS256/JWKS/discovery/authorize（一次性 code）/token/id_token/userinfo，
  账号冻结令牌即时失效。
- **复式分账 ledger（第 8 步）**：账期汇总结转（费率版本快照、尾差归平台）、试算平衡、红字冲正、开发者应收。
- **资金红线（v1.2 §六过渡）**：对公收款/开票/开发者付款通道未就位——充值仅管理员手工录入（幂等键=转账单号），
  订阅代收为 manual-settlement 登记，平台不自动扣外部资金。
- 验收：`npm run selftest` **244/244**、`npm run lint:manifests` **60/60**；KBaaS/连接器市场/合规门户与
  L1 有码沙箱为下一迭代（设计见 [docs/roadmap-9-10.md](docs/roadmap-9-10.md)）。

## 三B、评审缺陷修复与资产运营（本迭代，v1.3）

针对外部技术评审（严重 S1–S4 / 中等 M1–M5 / 轻微 L1–L4）逐项整改：

- **S1 账期结算硬缺陷**：`settle()` 改 keyset 分页全量归集（不再单页 limit:1000 截断），
  归集条数与 SQL COUNT 对账不符即拒绝结转；同一账期二次红字冲正被拒；钱包幂等键绑定主体（同键异主体拒绝）。
- **S2 密钥轮换宽限期**：轮换不再立即吊销全部令牌——旧密钥进入 24h 验签宽限期，在途请求不掉线，
  refresh 随时换取新密钥令牌，全局无感轮换。
- **S3 暴力破解防护**：登录 / Client Credentials / SSO 绑定 / OIDC 授权与换牌全部接入失败锁定
  （15 分钟窗口 5 次失败锁定，时长逐次升级至 24h，持久化防重启绕过，触发即告警）。
- **崩溃恢复**：认证类集合（令牌/主体/锁定计数）即时落盘并 fsync，登出/吊销返回 200 后被杀不丢失；
  坏 JSON 集合文件自动备份为 `*.corrupt-*` 并显式告警，不再静默当空集合。
- **计量消费幂等（重放不双计）**：引擎级消费水位（usage_consumptions 唯一索引）——replay/死信重投
  对 billing/audit 投影零重复副作用；消费失败真实即时重试 3 次后入死信，支持一键重投。
- **OIDC 收敛**：scope 白名单（openid/profile/email）、PKCE S256 全链路、JWT 校验 iss/aud/kid；
  issuer 支持 `OIDC_ISSUER` 环境变量对外声明。
- **MCP 熔断业务化**：真实调用失败与探活失败共用连续失败计数（连续 3 次开熔断，业务成功即半闭合）；
  回滚目标版本校验（当前版本/已回滚版本不可作为目标）。
- **多租户隔离补全（M1）**：钱包流水查询支持 tenant_id 过滤；审计/计量口径一致。
- **M2 撤销列表收敛**：吊销状态全量走持久化令牌记录（去掉进程内无限增长集合），
  过期令牌 7 天后物理清理（启动 + 每日巡检）；refresh 哈希索引化查询。
- **企业 AI 资产运营（新）**：`资产运营` 控制台页 + REST——统一台账（MCP/Agent/应用/Skill/模型路由
  五类资产一处盘点，含归属组织、负责人、健康、近 N 天调用与消耗）、一键健康巡检（批量探活留审计）、
  成本报表（Top 资产 / 主体分摊 / 日趋势，计量口径）。
- **商业化放缓（决策）**：真实支付网关/对公收款/开票/开发者付款等资金通道**保持手工过渡态暂缓实施**，
  插件市场变现（订阅代收/分账结算自动化）同样暂缓——本迭代优先企业内资产治理与运营能力。

## 三、目录结构（插件标准解剖）

```
packages/
  platform-core/            基础层插件
  plugin-iam/src/providers.ts  IdentityProviderAdapter 统一身份源抽象
  plugin-<name>/            每个业务插件：
    plugin.yaml             声明：id/version/depends/permissions
    manifest/
      api.yaml              REST + 工具 + 服务键（三端对齐的事实源）
      permissions.yaml      权限点（注册进统一 RBAC）
      events.yaml           发布/订阅事件
      ui.yaml               路由 + 菜单
    src/index.ts            服务 + 插件装配
    src/tools.ts            对模型暴露的工具（dsh ToolRuntime 契约）
  plugin-connect/           远程 dsh 接入插件（宿主端点 + 客户端代理 + 本机配置页，一份代码两种角色）
  plugin-console/public/    控制台 SPA（原生 ES Modules，零构建）
cli/dshctl.mjs              CLI（--output json|table / --dry-run / --yes；含 connect 接入管理）
skills/dsh-ops-*/SKILL.md   8 个运维 Skill（含 dsh-ops-admin 总控索引）
scripts/selftest.mjs        功能自测（244 项断言，含安全攻击演练、远程接入与平台更新链路；隔离实例 + DEMO_SEED）
docs/roadmap.md             OS-skill 融合决策与演进路线
scripts/gen-manifests.mjs   插件声明生成器
src/main.ts                 独立宿主入口
cordis.yml                  dsh 接入 overlay（源码检出 + --patch）
cordis.patch.yml            dsh.bundle 安装补丁（dsh plugin add）
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
node cli/dshctl.mjs plugin init --id=com.demo.hello --dir=./my-plugin   # 脚手架（契约五面 + 发布者密钥对）
node cli/dshctl.mjs plugin sign --dir=./my-plugin && node cli/dshctl.mjs plugin submit --dir=./my-plugin
```

```bash
# REST（Bearer 令牌）
curl -X POST localhost:7300/api/auth/login -H 'content-type: application/json' \
     -d '{"username":"admin","password":"<你的口令>"}'
curl localhost:7300/api/overview -H "authorization: Bearer <token>"
```

## 七、自测

`npm run selftest` 在独立端口 + 独立数据目录启动隔离实例，覆盖 **244 项端到端断言**：
v1.0 全量（登录/RBAC 越权、冻结→令牌联动吊销、机器凭证与 scope 越权、MCP 灰度/回滚/网关鉴权（含只读约束拦截）、
Skill 恶意提交驳回与两级审批、Agent 属性校验与 L4 双人审批（含自审拦截）、on-behalf-of 链、
审计四类日志与筛选、告警、成本穿透、工具桥执行、安全演练）+ v1.2 新增
（真实 MCP/钉钉/OpenAI stub 往返、计量幂等与对账、钱包扣费与预算拦截、OIDC RS256/JWKS 全链路、
市场验签/安装/卸载、复式分账试算平衡与红字冲正）+ 远程 dsh 接入
（接入码创建/掩码存储/伪造拒绝/一次性消费、机器凭证换牌、operator 模板越权拦截、
工具桥代理路径、客户端禁用联动吊销、管理工具 RBAC）。测试内 stub 均为进程内真实 HTTP 服务，不降级为 mock。

## 八、说明与边界

- 生产部署默认**基线初始化**（内置角色 + 根组织 + `admin`，零演示数据）；完整演示数据仅在 `DEMO_SEED=1` 时注入，请勿在生产环境启用
- 业务配置存储为 JSON 集合（原子落盘）；计量/资金/分账类数据存 SQLite（`data/txnstore.db`，WAL + 事务 + 幂等唯一索引）
- MCP 执行层支持真实 HTTP 传输（`exec: real`，JSON-RPC tools/call + initialize 探活）；`exec: demo` 为显式降级演示传输层（确定性模拟、不计费不计 SLO）
- 钉钉连接器支持真实 OpenAPI（`mode: real` + `apiBase`）与 mock 演示（显式标注）
- 模型网关仅转发 OpenAI 兼容 chat/completions；模型未配置 endpoint 时拒绝调用（不生成假 completion）
- 资金通道为手工过渡形态（见「三A」资金红线）；OIDC 私钥存 data 目录，生产建议迁 KMS
- Node ≥ 22.6（原生 TypeScript 运行，无需构建步骤；node:sqlite 在 Node 24 下为 Experimental，无害）
