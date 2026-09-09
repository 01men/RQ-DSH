# F 域余量 · 受控回流清单（custom/dsh-rq → 上游 main · 第二批）

> 目标读者：ybkk-AIOS main 开发 Agent。生成：2026-09-08（双轨改造 Phase 3 交付物）。
> 前置：宿主平台 A–E 域已于 2026-09 移植进 main；看板/卡片包域已由定制侧整体迁入
> `plugin-panel-core`（/panel 面），定制分支对上游的宿主面差异已收敛至本清单所列余量。
> 模板沿用 [handoff-host-features-to-main.md](handoff-host-features-to-main.md)。
> 闭环规则（[plan-dual-track-custom.md](plan-dual-track-custom.md) Phase 3）：主分支采纳 → 定制侧 merge 吸收；
> **不采纳 → 定制侧拆除该差异**（收敛优先，双方都不留长期分叉）。

## 0. 当前残余差异基线（对 main `ff1a8de` 实测）

```bash
git diff ff1a8de custom/dsh-rq --stat -- packages/   # 本清单全部内容
```

除下述功能余量外，其余差异均为**治理与布局类或定制自有面，不回流**：定制自有三包
（plugin-panel-core 含 cardpacks 域 / plugin-rq-card / plugin-dingtalk-bridge）与 scenegraphs、
AGENTS.md / PROJECT.md / docs/plan-*、tests 目录布局（scripts→tests 迁移，澄清第 8 条已定版）、
scripts/hooks/pre-push、package.json 的 selftest 路径与 dsh STORE 契约、examples/cli 布局。

## A. 审批深化（WP-10/L1：高风险二次确认 + 公司级终审 + SLA 看板）——建议采纳

| 文件 | 改动 |
|---|---|
| `packages/plugin-agent/src/index.ts` | +8：Agent 上线 L4 审批 riskLevel 统一标注 `high`（2 处，附注释） |
| `packages/plugin-audit/src/index.ts` | +78/-1：WP-10/L1 底座——`ApprovalRecord` 增 `riskLevel`/`finalReview` 字段；`decideApproval` 高风险通过强制二次确认（`confirmed`，服务端 fail-closed）并落公司级终审标记（审计 `approval.final_review` 可追溯）；`slaReport()` SLA 报表（≤2 个工作日达成率+逾期清单） |
| `packages/plugin-console/src/index.ts` | +69 中的审批部分：`POST /api/mcp/services/:id/final-review`（公司级终审标记端点）；`/api/approvals/sla`（SLA 达成率看板端点）；审批 decide 的 `confirmed` 强制二次确认（服务端 fail-closed） |

说明：`plugin-audit` 的 WP-10 底座此前**未移植进 main**（对 ff1a8de 实测为定制侧增量），采纳 A 时
须与 console 侧执行端点一并回流。
selftest 对照分节：`审批 SLA 与公司级终审（WP-10）`（tests/selftest.mjs）。
采纳方式：按文件 cherry-pick + main 底座重放；验收 = selftest 该分节全绿。

## B. 全员工作台最近调用（WP-04/A3）——建议采纳

| 文件 | 改动 |
|---|---|
| `packages/plugin-console/src/index.ts` | +69 中的 usage 部分：`GET /api/usage/recent`（登录人自身计量事件 ≤5 条自见，只读不跨人） |

依赖：无（usage 管道两侧一致）。selftest 对照：`usage 最近调用（WP-04/A3）` 分节。

## C. 五平台主题 + 钉钉 H5 降级 + 工作台联动（WP-05/B3 + WP-11 + dashboard 联动）——成组评估

| 文件 | 内容 | 依赖 |
|---|---|---|
| `packages/plugin-console/public/js/platform.js` | 平台主题回放（记忆平台免闪） | base.css 主题块 |
| `packages/plugin-console/public/css/base.css` | 五平台 `data-platform` 定版色块（+88） | — |
| `packages/plugin-console/public/js/app.js` | +17：主题回放启动 + 钉钉 webview 入口探测 + 登记引导 NAV | platform.js / register.js |
| `packages/plugin-console/public/js/realtime.js` | +132：钉钉 webview UA 探测降级链路（30s 轮询兜底） | — |
| `packages/plugin-console/public/js/pages/dashboard.js` | +126：场景卡片区 / 最近调用区 / 主题联动 | **见下方依赖警示** |
| `packages/plugin-console/public/js/pages/approvals.js`、`pages/assets.js` | 审批终审展示 / 目录筛选联动 | A / D |

⚠ **依赖警示（dashboard.js）**：场景卡片数据源已从 `/api/platform/card-packs`（main 无此端点）改为
`/api/panel/board`——该端点属于**定制面板数据面**（plugin-panel-core，非宿主面）。主分支如采纳
dashboard 改动，二选一：① 连同卡片包模型一并回流（platform-core 级 cardpacks.ts + cardpacks/*.json +
下发端点，即原 WP-05/B1 全量，main 侧此前未移植）；② 不采纳 dashboard 卡片区块，仅采纳其余部分。
定制侧建议：**暂缓**，待主分支对卡片包域是否有宿主面诉求表态后一并决策。

## D. 目录筛选 + 资产登记引导（WP-12 + WP-08）——运营向，主分支自行取舍

| 文件 | 内容 |
|---|---|
| `packages/plugin-console/public/js/asset-filters.js` | 纯函数目录筛选（类型/平台/关键词，1000 项 <50ms 有性能断言） |
| `packages/plugin-console/public/js/pages/assets.js` | 资产目录接筛选（+86） |
| `packages/plugin-console/public/js/pages/register.js` | 资产登记引导页（六磁贴分诊 + 描述 embedding 规范预检，+149） |

不采纳则定制侧拆除对应页面与 NAV（不留分叉）。

## E. 测试资产（随对应功能域决策）

| 文件 | 随迁域 |
|---|---|
| `tests/selftest.mjs` 对应分节 | A/B/C/D 各分节随功能域一并搬（main 侧 scripts/selftest.mjs 布局） |
| `tests/walkthrough.mjs`、`tests/dingtalk-h5-smoke.mjs` | C（钉钉 H5 降级）——澄清第 7 条既定口径 |
| `tests/dom-smoke.mjs`、`tests/full-chain-drill.mjs`、`tests/morning-peak-entry.mjs` | 布局随 tests/ 迁移（澄清第 8 条：行为等价，不强制） |

## F. mcp/app riskLevel 水印（WP-10/L1）——建议采纳

| 文件 | 改动 |
|---|---|
| `packages/plugin-app/src/index.ts` | +4：应用上/下线 L4 审批统一标注 `riskLevel: 'high'`（2 处，附注释） |
| `packages/plugin-mcp/src/index.ts` | +5：`McpServiceRecord` 增 `finalReview` 终审标记字段；`McpCallRecord` 增调用水印字段——终审服务的全部调用附 `watermark`，审计可追溯 |

依赖：A 的 `plugin-audit` 底座（`finalReview` 标记来源）。任何宿主部署都受益（双轨计划 §3 评估口径倾向采纳）。
selftest 对照：`审批 SLA 与公司级终审（WP-10）` 分节水印断言。

## G. 远程 dsh 人类登录闭环 + 模型流式（dsh 插件化充分落地，2026-09-08）——建议采纳

定制侧已完成「装好插件即可用」的连接向导与对话打通（定版设计：[plan-dsh-plugin-first.md](plan-dsh-plugin-first.md)）：
免登 `/rqcard/*` 向导命名空间、LAN 扫描选宿主、账号密码经本机插件代理全闭环登录、dsh 会话
「榕器工作台」视图 Tab 与面板「Agent 对话」双向内嵌、`panel_agent_invoke`/`panel_board_digest`
协作工具族。以下为**远程形态（C）钉钉扫码登录闭环**的宿主侧增强建议——不采纳也能用
（定制侧维持「跳宿主登录页 + 回导向导校验」降级），采纳后体验闭环：

| # | 文件（main 侧） | 改动 | 价值 |
|---|---|---|---|
| G1-a | `packages/plugin-console/src/index.ts`（登录页/登录成功路径） | 登录页支持可信 `next` 参数：完成登录（含钉钉扫码）后按 `next` 回跳，fragment 携带一次性自助 `entry_ticket`；需新增 `POST /api/auth/entry-tickets/self`（已登录人类为自己签发短时票据，进 PUBLIC_PATHS） | 远程 dsh 面板向导发起 `next=<本地面板地址>`，钉钉扫码后自动回到本机 dsh、票据兑换即建立会话——零手工回导 |
| G1-b | 同上（票据签发约束） | 自助票据 TTL ≤120s，复用 authn EntryTicket 既有一次性/防重放语义；`authn.entryticket.redeemed` 审计留痕 | 防票据扩散；审计闭环 |
| G2（可选） | `packages/plugin-modelgw/src/index.ts` | `invoke` 增 `stream` 变体（SSE，OpenAI 兼容流式透传） | 面板内置协作会话与 dsh 侧富卡可升级流式输出（非必须；现状单轮非流式诚实工作） |
| G3 | dsh 侧 `vendor/loader`（或 main 侧预构建分发） | 拷贝安装形态（`dsh plugin add github:`，pnpm 装入 node_modules）下 Node（≥22.6）拒绝类型剥离 node_modules 内 TS（实测 `--experimental-transform-types` 亦不解除）——全部 `src/index.ts` 形式 loader entry 不可执行，**全仓架构级**限制。解法二选一：① dsh loader 在 import 前自行剥离 TS（vendor/loader Entry._init 预处理）；② 平台提供预构建分发（构建 JS 镜像 + 指向 .js 的安装补丁）。定制侧已实证：源码/链接形态（`link:` 安装，真实路径在 node_modules 外）完整体验 8/8 绿 | 「全新 dsh 拷贝安装完整体验」的最后一公里；定制侧根包已补 `@dsh-ops/plugin-rq-card` file: 依赖使包名在安装形态可解析（该修复与 G3 无关、始终需要） |

定制侧对照降级路径已实现（2026-09-08）：向导打开宿主登录页**已携带** `?next=<本机面板绝对地址>`（G1 前向兼容，
未采纳宿主按防 open redirect 白名单忽略、无害）；boot.js 已按连接形态经代理兑换回跳票据（query/fragment 双形态、
会话落连接作用域）——**G1 采纳即闭环，定制侧零后续改动**；未采纳期向导提供「我已完成扫码」回导校验诚实降级
（proxy `/api/auth/me`：本机有有效会话即进工作台，无则如实说明并导向账号密码登录）。同批修复：探活严格判据
（独立宿主 SPA 兜底 200 HTML 不再误判挂载前缀）、代理对宿主 HTML 响应显式 502、api.js 代理请求补向导头
（形态 C 数据面防线内通行）、实时轮询远端代理映射。
selftest 对照：`宿主连接向导` 分节（50 项，含向导 jsdom DOM 全链与 G1 回跳闭环回归）+ `panel_agent_invoke/board_digest`（4 项）+ `fresh-install 装机模拟`（13 项）。

## H. README「装好插件即可用」定制文档段（2026-09-08）——随整包同步取舍

| 文件 | 内容 |
|---|---|
| `README.md`（+33） | 「装好插件即可用（fresh-install 体验）」节：向导首启与形态 B/C 体验说明、`/rqcard/*` 免登命名空间三道防线、对话与看板双向打通、装机铁律与装机形态边界（对应 G3）——内容描述的是定制面功能，落在宿主面 README 上 |

归属建议：宿主侧文档「遗留 1」的整包同步时随包采纳；不采纳则定制侧把该节移入
`docs/plan-dsh-plugin-first.md` 并还原 README（收敛检查红项清零）。

## 决策回执（请 main 侧填写后回传）

| 域 | 采纳？ | 备注 |
|---|---|---|
| A 审批深化 | | |
| B usage/recent | | |
| C 五平台主题/钉钉H5/dashboard | | |
| D 目录筛选/登记引导 | | |
| E 测试资产 | | 随对应域 |
| F mcp/app riskLevel 水印 | | 依赖 A（plugin-audit 底座） |
| G1 远程登录回跳闭环（next + 自助 entry_ticket） | | 采纳后定制侧向导自动升级闭环 |
| G2 modelgw 流式化 | | 可选 |
| G3 拷贝安装形态 TS 装载（dsh loader 预剥离 / 平台预构建分发） | | 「全新 dsh 拷贝安装完整体验」最后一公里；源码/链接形态已实证闭环 |

未采纳项由定制侧在下一个同步周期内拆除（北极星 diff 相应归零）。
