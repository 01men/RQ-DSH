# 双轨开发计划 · 定制分支（custom/dsh-rq）

> 生成：2026-09-08。前置事实：宿主平台功能域已按 [handoff-host-features-to-main.md](handoff-host-features-to-main.md)
> 移植进上游 main（89074d9 + 80a65e3 + ff1a8de，selftest 927/927 绿），8 项风险/疑点结论见
> [handoff-host-features-clarification.md](handoff-host-features-clarification.md)。
> 本计划确立双轨模型与本分支落地路线。主分支侧参考计划：[plan-dual-track-host-main.md](plan-dual-track-host-main.md)。

---

## 0. 双轨模型与收敛判据（北极星）

| 轨道 | 分支 | 职责 |
|---|---|---|
| 宿主轨 | 上游 `01men/ybkk-AIOS` main | 宿主平台/控制台开发：platform-core、console、authn/oidc、agent、portal、iam、usage、skillhub、nas-authz、**plugin-dsh-bridge（宿主桥=宿主入口设施）**；API/事件契约所有者 |
| 定制轨 | `custom/dsh-rq`（本分支） | dsh 前端交互插件/看板研发：plugin-panel-core、plugin-rq-card、plugin-dingtalk-bridge、scenegraphs 业务数据；dsh 部署装配（cordis 链、宿主形态验证）；**部署物理真相**（dsh 单进程 /rq 挂载） |

代码流向：合并方向唯一（main → custom）；定制 → 上游仅允许「交接清单 + cherry-pick/重放」受控回流。

**北极星（收敛判据）**：定制轨对宿主轨的**代码差异收敛为零**——

```bash
# 锚点=真上游 main 头（当前 ff1a8de；上游前进后更新锚点哈希）。
# 不用 origin/main 追踪引用——它在 push/fetch 之间摇摆（见 AGENTS.md「已知无害怪象」），自比较会假绿。
git diff ff1a8de custom/dsh-rq -- \
  packages/platform-core packages/plugin-console packages/plugin-portal \
  packages/plugin-authn packages/plugin-agent packages/plugin-audit packages/plugin-iam \
  packages/plugin-usage packages/plugin-skillhub packages/plugin-app \
  packages/plugin-mcp packages/plugin-nas packages/plugin-dsh-bridge \
  src/boot-all.ts README.md cordis.yml cordis.patch.yml
```

输出应为空。全部差异集中于：定制自有三包、scenegraphs/*.json、docs/、治理文件（AGENTS.md / PROJECT.md / scripts/hooks）。
cordis.yml / cordis.patch.yml 属宿主面（装配清单随 main 演进）；定制部署个性走 gitignore 的 cordis.local.yml。达成后，日常上游同步不再产生宿主面冲突。
**建议每次 push 前跑一次北极星 diff 作为纪律护栏。**

---

## Phase 0 收口合并（第一优先级，后续一切的前提）

**目标**：吸收上游 ff1a8de（移植三提交 + 上游 7 个新提交），消除「同一批宿主功能两份实现并存」的窗口期。

**步骤**：

1. `git fetch origin main && git merge origin/main`（merge-base `229ce59`；已用 merge-tree 预演，冲突约 13 文件）。
2. 冲突解决规则：
   - **A–E 域文件以 main 为准**（main 版 = 定制改动在 main 底座重放 + 加固：CORS `/api/auth/*` 收紧、
     LICENSE 上架契约、装配补全）：platform-core（http.ts / index.ts）、console（app.js / pages/login.js /
     src/index.ts）、plugin-platform-core manifests、lint-manifests、selftest、panel-core 两个 add/add 文件
     （移植已含 ff8e275 模型配置面，实质取 main，逐块 diff 确认定制侧无丢失）。
   - **portal 单独处理**：main 侧有 4bcde8e 端点扩展 + 已移植的 behavior inject（A–E）；定制侧另有 board
     端点（F 域）——逐 hunk 取 main 为底、保留 board 端点块（Phase 2 会拆除）。
   - **F 域保留定制**：cardpacks.ts + cardpacks/*.json、console board/register/asset-filters 及页面改动、
     portal board 端点、审批深化（audit 终审 + SLA）、nas-authz、integrations、AGENTS.md / PROJECT.md /
     hooks / .gitignore、docs。
   - **README、cordis.yml、cordis.patch.yml 以 main**（宿主面；所有权修正后装配清单随 main 演进，
     定制部署个性走 gitignore 的 cordis.local.yml），核对 main 侧新增装配条目。
3. selftest 口径更新：CORS `*` 断言改为澄清第 1 条新口径（`*` 不作用于 `/api/auth/*`；精确来源配置可放行）。
4. `npm run selftest && npm run lint:manifests` 全绿 → `git push` 备份。

**验收**：合并提交落分支、回归全绿、RQ-DSH main 同步到新头。

---

## Phase 1 治理修订（AGENTS.md 双轨化）

对照现行铁律的改写清单：

1. 铁律 1「唯一开发分支是 custom/dsh-rq」→ **双轨条款**：上游 main 承载宿主平台开发线；
   custom/dsh-rq 承载 dsh 交互插件/看板开发线 + 部署装配。
2. 铁律 2「上游只读」→ git 层面 fetch-only 不变；语义改为「宿主面改进在主分支开发，
   定制分支不携带宿主面补丁」。
3. 铁律 4「方向唯一」→ 保留（合并方向唯一），补唯一例外通道「受控回流」：
   交接清单文档 + 主分支侧 cherry-pick/重放；整分支反向 merge 仍然禁止；pre-push 钩子保留。
4. 新增**目录所有权三区表**（宿主面 / 定制面 / 治理/文档，与主分支参考计划 §2 同一张表）。
5. 新增**修改纪律**：定制分支禁止修改宿主面文件；宿主面缺陷/需求 → `docs/handoff-*.md` 清单 →
   主分支落地 → merge 吸收。
6. PROJECT.md 背景段同步双轨模型。

**验收**：新会话只读 AGENTS.md 即可理解双轨模型、回流通道与所有权边界。

---

## Phase 2 看板迁入 panel-core（选项 b 落地）

**范围勘定（已核实代码地图）——只迁「看板/仪表盘」面**：

| 现状位置 | 处置 |
|---|---|
| `platform-core/src/cardpacks.ts`（192L，CardpackService） | 迁 → `plugin-panel-core/src/cardpacks.ts`；platform-core 删除 import（L17）/export（L31）/index.ts 装配行 → 收敛到 main 原样 |
| `platform-core/cardpacks/*.json`（strategy/marketing/manufacturing/rd/quality 共 5 份） | 迁 → `plugin-panel-core/cardpacks/` |
| `plugin-portal/src/index.ts` board 端点（ENDPOINTS `'board'`，L220 分支） | 删除（portal 收敛到 main）；panel-core 新增 `GET /api/panel/board`（复用 forPlatform + refAlive 失效过滤语义；权限 `panel.read`；manifest/api.yaml 登记 + routeMatrix 自注册） |
| `plugin-console/src/index.ts` L3532-3565 cardpack hunks（平台清单 / setRefAliveResolver） | 删除（console 收敛到 main） |
| console 前端 `pages/board.js`（88L，调 `/api/portal/board`）+ app.js NAV `#/board 战略看板` + index.html | 迁 → panel SPA：新增顶层视图切换（工作台 / 战略看板，hash 路由，保持零构建风格）；调用点改 `/api/panel/board` |
| selftest 看板相关断言 | 随迁改口径（`/api/panel/board` + `panel.read` 权限） |

**明确不迁（属控制台 UX，走 Phase 3 回流清单）**：
`pages/register.js`（资产登记引导——磁贴直通 #/skills、#/apps、#/mcp 等控制台页，语义属平台资产运营）、
`asset-filters.js`（资产目录筛选，assets.js 消费）、dashboard / approvals / assets / skills 页的 WP-09~12 改动。

**验收（强判据）**：
1. `git diff origin/main -- packages/platform-core packages/plugin-console packages/plugin-portal` 为空
   （如出现无法收敛的残留，逐项登记进 Phase 3 清单后再放宽）。
2. selftest + lint:manifests 全绿；/panel 战略看板可用；`scripts/verify-live-host.mjs` 增补看板断言并通过。
3. push 备份。

---

## Phase 3 F 域余量受控回流（第二份交接清单）

- **内容**：审批深化（audit 终审标记 + SLA 报表，约 +77）、mcp/app riskLevel 水印、
  console UX 余量（register.js 登记引导、asset-filters.js 目录筛选、dashboard/approvals/assets/skills 页改动）、
  dingtalk-h5-smoke.mjs / walkthrough.mjs 测试（随对应功能域）。
- **形式**：`docs/handoff-f-remainder-to-main.md`，沿用 handoff-host-features-to-main.md 模板
  （功能域 / 承载提交 / 文件 / 冲突预警 / 验收基线）。
- **闭环规则**：主分支采纳 → 定制 merge 吸收 → 宿主面进一步收敛；**不采纳 → 定制侧拆除该差异**
  （收敛优先，不留长期分叉）。

---

## Phase 4 常态运转

- **同步节奏**：每周或每上游版本 `fetch → merge → selftest+lint → push`（现行铁律流程不变）。
- **需求分流**：dsh 交互面/看板需求 → 本分支直接开发；宿主面需求 → Phase 3 清单回流。
- **本分支主业方向**：panel 看板视图扩展、场景图谱（scenegraphs/*.json）业务深化、
  behavior 效果回传看板化、rq-card 卡片交互迭代。
- **定制自有包回流**：rq-card 为双面插件（宿主形态也消费），panel-core/dingtalk-bridge 若宿主侧需要，
  按 Phase 3 清单节奏同步给 main；plugin-dsh-bridge 属宿主面，其演进需求走清单回流 main。
- **Phase 4 首个专项（2026-09-08 交付）**：dsh 插件化充分落地——装机铁律门禁、B/C 双形态连接登录
  向导、dsh 标准对话与看板双向打通；定版设计见 [plan-dsh-plugin-first.md](plan-dsh-plugin-first.md)，
  其宿主侧增强余量并入交接清单 G 节（[handoff-f-remainder-to-main.md](handoff-f-remainder-to-main.md)）。

---

## 风险与回退

- **Phase 0**：冲突面已预演可控；备份在 RQ-DSH（859fbde），可整分支 reset 回退。
- **Phase 2**：拆（console/portal/platform-core）与建（panel-core）在同一工作窗内完成，避免中间态长存；
  迁移窗口内看板短暂双入口属预期。
- **最大长期风险是修改纪律松懈**（定制侧顺手改宿主面文件）——护栏 = Phase 1 所有权表 +
  北极星 diff 检查命令入 push 前自检。

---

## 执行纪要（2026-09-08 收官）

- **Phase 0 ✅** 收口合并 94bfa07：15 冲突文件按规则解决（含 selftest 导入区/分节区自动合并重复的语义修复）；
  顺带修复 WP-10 水印测试的时刻彩票假红（种子演示调用带当天合成时间戳，查询窗口 5→200 全量）。
- **Phase 1 ✅** AGENTS.md/PROJECT.md 双轨化（0cdb3c4）。
- **Phase 2 ✅** 看板/卡片包域整体迁入 panel-core（197d173）：cardpacks 模型+5 份 JSON+下发端点归 /panel 面；
  `/api/panel/board` 一套端点下发聚合面+卡片包面；portal/console/platform-core 看板接线拆除；
  dashboard 卡片改源 /api/panel/board；selftest 965/965。
- **Phase 3 ✅** `docs/handoff-f-remainder-to-main.md`（A 审批深化 / B usage-recent / C 主题与钉钉H5 / D 目录与登记 / E 测试资产）。
- **所有权修正 ✅** cordis.patch.yml 从「定制面」改划「宿主面」并逐字节收敛：吸收 ff1a8de 补的
  ops-panel-core / ops-dingtalk-bridge 装配入口（Phase 0 的 --ours 决议曾让定制侧落后这两条）；
  cordis.yml 一行示例路径注释同步收敛。定制部署个性（安装源 RQ-DSH 等）走 gitignore 的 cordis.local.yml
  或部署文档，不进版本化装配清单。
- **北极星现状（对真上游 ff1a8de）**：宿主面剩余差异 = F 域余量（已登记，待主分支采纳/拆除闭环）；
  packages/ 差异仅剩定制自有包（plugin-panel-core 增量 + cardpacks 域文件）。

### ⚠ 踩坑记录：origin/main 追踪引用摆动（AGENTS.md「已知无害怪象」的实锤）

push 之后 `origin/main` 追踪引用会指向**备份仓库的 main（= 本分支自己）**，此时所有
`git diff origin/main` / `git show origin/main:*` / `git checkout origin/main --` 都是**自比较**，
结论全部无效。本次执行中段一度据此误判「真上游已有卡片包域」，做出方向相反的收敛操作，
随后 fetch 刷新 + 直接对 ff1a8de 哈希操作才纠正。**铁律：跨分支对拍前先 `git fetch origin main`，
并以 `git ls-remote` 双仓库实测为准；关键对拍直接用提交哈希（如 ff1a8de），不用追踪引用。**
