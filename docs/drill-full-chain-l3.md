# 演练记录：四类资产「登记→审批→上架→授权→调用→回传」全链路（WP-08 L3 备案）

> 版本：v1.0（2026-09-02）· 分支：`custom/dsh-rq` · 执行：WP-08 全链路演练
> 依据：`docs/action-plan-dsh-frontend.md` §三 泳道 E · WP-08 DoD——四类资产各 ≥1 真实资产走完全链路；
> 演练记录入 `docs/`，每步引用真实 API 调用与 usage 事件 ID；L3 登记→上架当日完成。
> 脚本：`tests/full-chain-drill.mjs`（可重复执行，任一步 FAIL 退出码 1）；
> API 形状全部照 `tests/selftest.mjs` 既有真实调用序列，未新增/修改任何平台代码。
> 本次归档对应真实运行：2026-09-02，27 步全 PASS（`steps=27 pass=27 fail=0`，总耗时 3.4s，退出码 0）。

---

## 一、演练结论

| 资产类型 | 真实资产（ID） | 登记 | 审批 | 上架 | 授权 | 调用 | 回传 | 结论 |
|---|---|---|---|---|---|---|---|---|
| 提示词/技能（Skill） | `skl_mtkb7a7k2qgtjkjo` 周报生成助手 | PASS | PASS（L1 领域 + L2 安全两级） | PASS | PASS（安装授权留痕） | PASS | PASS | **全链路 PASS** |
| 自动化流程（AI 应用） | `app_mtkb7agi2qh8e8hn` 演练审批台 | PASS | PASS（上线审批单） | PASS（SSO 门禁双点过） | PASS（entry-ticket） | PASS（票据兑换=打开语义） | PASS | **全链路 PASS** |
| 接口/工具（MCP） | `mcp_mtkb7apy2qhnd3zg` drill-search-37637（real 执行层） | PASS | PASS（测试环境验证准入） | PASS（verifying→gray 20%→online 100%） | PASS（权限组） | PASS（网关 invoke + /mcp 双通道） | PASS（自动计量） | **全链路 PASS** |
| 数据目录（NAS） | `nas_mtkb7bbd2qib1i8k` 演练群晖 NAS | PASS | PASS（规则基线确认，见 §五.3） | PASS（transition online） | PASS（nas-authz 授权作用域） | PASS（allow/deny 判定 + 文件网关） | PASS | **全链路 PASS** |

- 六步×四资产矩阵：**24/24 PASS**（另含 3 步演练夹具准备，合计 27 步全绿）。
- **L3 时延结论：登记→上架当日完成达成**——四类资产登记→上架均在**秒级**内完成（Skill 0.0s、App 0.0s、MCP 0.4s、NAS 0.0s），远优于「≤1 工作日」口径。

## 二、实例形态

| 项 | 值 |
|---|---|
| 启动方式 | 脚本自起隔离实例：`node src/main.ts --port 7322 --data data-drill`，`DEMO_SEED=1`（完整演示种子），`DSH_UPDATE_AUTO_CHECK=off` |
| 数据目录 | `data-drill`（演练结束 finally 自动删除，不触碰生产 `data/`） |
| 演练账号 | admin / dev / ops / audit（口令统一 `Ybk@2026`，演示种子内置） |
| 外部依赖 | 无。MCP real 后端与 NAS 文件网关均为脚本进程内 stub（动态端口，复刻真实契约，照 selftest 同款） |
| 复现命令 | `node tests/full-chain-drill.mjs`（或 `DRILL_BASE=http://127.0.0.1:<port>` 指向已运行实例） |

夹具（真实 API 创建，随实例销毁）：演练租户 `t_mtkb7a7h2qgpppsm`、演练组织 `org_mtkb7a7i2qgr4ect`（usage principal 归属）；安装目标 Agent（演示种子）`agt_mtkb79sz2p9gh11y`（slug `dev-coder`）。

## 三、四资产×六步明细（每步真实 API + 返回 ID）

### 3.1 Skill：周报生成助手 `skl_mtkb7a7k2qgtjkjo`

内容含外部 URL（`https://wiki.example.com/runbook`）→ 静态扫描 warn → 风险等级 high → 触发两级审批，覆盖 L1/L2 按钮流。

| 步 | API（真实调用） | 结果与返回 ID |
|---|---|---|
| 1 登记 | `POST /api/skills`（dev） | 200，status=`pending_approval`，findings=1（network warn），id=`skl_mtkb7a7k2qgtjkjo` |
| 2 审批 | `POST /api/skills/:id/approve` `{level:'domain'}`（admin，L1）→ 200 版本状态 `pending_security`；`{level:'security'}`（admin，L2）→ 200 版本状态 `approved` | 两级审批全通过 |
| 3 上架 | `POST /api/skills/:id/publish`（admin） | 200，status=`published`（登记→上架 0.0s） |
| 4 授权 | `POST /api/skills/:id/install` `{agentId:'agt_mtkb79sz2p9gh11y'}`（dev） | 200，installs=1（安装即授权留痕，Agent 关联 Skill 自动回填） |
| 5 调用 | `POST /api/skills/:id/download`（dev）→ 200 留痕（125 字节 SKILL.md）；**调用侧由 usage 管道回传**：`POST /api/usage/record` resource=`skill:skl_mtkb7a7k2qgtjkjo` meters=`calls×1`（模拟运行时调用侧，零费率） | 200，usage 事件 `uevt_mtkb7a7z2qh6qsox` |
| 6 回传断言 | `GET /api/usage/events?resource=skill:skl_mtkb7a7k2qgtjkjo`（admin） | 200，total=3，charge 全 0（零费率），事件：`uevt_mtkb7a7z2qh6qsox`（调用侧）、`uevt_mtkb7a7w2qh45sf6`（下载）、`uevt_mtkb7a7r2qh0ccfc`（安装） |

> 注明：Skill 无独立运行时调用端点，「调用」= 下载留痕（平台真实端点）+ 调用侧由 usage 管道回传（`POST /api/usage/record`，命中 `skill:*` 零费率规则，charge=0）。

### 3.2 AI 应用：演练审批台 `app_mtkb7agi2qh8e8hn`

| 步 | API（真实调用） | 结果与返回 ID |
|---|---|---|
| 1 登记 | `POST /api/apps`（ops，owner=资源管理员） | 200，app=`app_mtkb7agi2qh8e8hn`，机器凭证 clientId=`mc-mtkb7agi2qh9fmol` |
| 2 审批 | SSO 上线门禁：`POST /api/apps/:id/sso-client`（ops owner 签发）→ 200 clientId=`oc-mtkb7agk2qhbktr3`；`POST /api/apps/:id/transition` `{action:'online'}` → 审批单 `apr_mtkb7agm2qhexjrw`；`POST /api/approvals/:id/decide` `{decision:'approve'}`（admin）→ 200 status=`executed`（审批通过且上线执行成功） | 上线审批闭环 |
| 3 上架 | `GET /api/apps/:id`（admin）确认 | status=`online`，sso=`active`（登记→上架 0.0s） |
| 4 授权 | `POST /api/apps/:id/entry-ticket`（admin，human-only 语义） | 200，一次性票据 `etk_ZoWZxy3yblQfy7yfhgiLxNwsuy-yCWpmENz73AgOC2o`（授权直达语义） |
| 5 调用 | `POST /api/authn/entry-tickets/redeem` `{ticket}`（打开语义=领票兑换） | 200，refType=`app`，refId=`app_mtkb7agi2qh8e8hn`，identity.sub=`usr_mtkb78uf2p7rvz3p`（平台身份直达） |
| 6 回传 | `POST /api/usage/record` resource=`app:app_mtkb7agi2qh8e8hn` meters=`calls×1` nonbillable（平台已播种 `app:*` 零费率规则）；`GET /api/usage/events?resource=app:app_mtkb7agi2qh8e8hn` 断言 | record 200 charge=0 rate.nonbillable=true；total=1，事件 `uevt_mtkb7agu2qhlhgmq` |

### 3.3 接口/工具（MCP）：drill-search-37637 `mcp_mtkb7apy2qhnd3zg`

real 执行层 + 进程内真实 JSON-RPC stub 后端（`tools/call` 返回 usage.totalTokens=4321），保证调用自动进入计量管道（demo 执行层不计费不计 SLO，故不用）。

| 步 | API（真实调用） | 结果与返回 ID |
|---|---|---|
| 1 登记 | `POST /api/mcp/services`（admin，transport=http / mode=external / exec=real / 工具 `drill_query` read） | 200，status=`draft`，id=`mcp_mtkb7apy2qhnd3zg`，slug=`drill-search-37637` |
| 2 审批（准入验证） | 草稿态调用 `POST /api/mcp/invoke` → 被拒（denied）；`POST /api/mcp/services/:id/verify` → 200 health=`healthy`（real initialize 真实探测） | 测试环境验证通过=准入放行 |
| 3 上架 | `POST /api/mcp/services/:id/deploy` `{grayPercent:20,version:'0.1.0'}` → `gray`；`{grayPercent:100,version:'1.0.0'}` → `online`（verifying→gray→online 流水线） | 200×2（登记→上架 0.4s） |
| 4 授权 | 授权前 dev 调用 → 网关拒绝（status=`denied`）；`POST /api/mcp/perm-groups`（policies 允许 `drill_query` 只读，subjects=`user:usr_mtkb78ug2p7ubd2h`） | 200，权限组 `mpg_mtkb7b282qhyo91j`（授权前后行为对比即授权语义） |
| 5 调用 | `POST /api/mcp/invoke`（dev，`drill_query`）→ 200 ok=true；`POST /mcp` JSON-RPC `tools/call mcp_invoke`（平台即 MCP Server 通道）→ 200 status=ok | 双通道调用成功 |
| 6 回传断言 | `GET /api/usage/events?resource=mcp:drill-search-37637` | 200，total=2，subject=`user:usr_mtkb78ug2p7ubd2h`，**自动计量（invoke 管道自动产出，非手动补报）**：`uevt_mtkb7b2k2qi8qg06`、`uevt_mtkb7b2e2qi2lj8o` |

### 3.4 NAS 数据目录：`nas_mtkb7bbd2qib1i8k`（文档/知识包的深化期前形态）

进程内 NAS 文件网关 stub（synology-filestation-mcp 契约：Bearer + X-NAS-IP 校验、fs_* 工具面）。

| 步 | API（真实调用） | 结果与返回 ID |
|---|---|---|
| 1 登记 | `POST /api/nas`（admin，attrs 携带 gatewayUrl/accessToken/nasIp） | 200，status=`draft`，id=`nas_mtkb7bbd2qib1i8k` |
| 2 审批（把关） | `PATCH /api/nas/:id` `{attrs:{orgRoot:'元冰可集团'}}`（锚定组织树）；`GET /api/nas/authz/rules` v1 → `PUT /api/nas/authz/rules` `{ifVersion:1}` 200 → v2 | 规则基线确认（NAS 无独立审批工作流，见 §五.3） |
| 3 上架 | `POST /api/nas/:id/transition` `{action:'online'}` | 200，status=`online`（登记→上架 0.0s） |
| 4 授权 | `GET /api/nas/authz/scope?nasId&userId=usr_mtkb78ug2p7ubd2h` → role=`M`，scope=`/元冰可集团/技术中心/AI 平台部`；`POST /api/nas/authz/check`（dev，read `/元冰可集团/技术中心/AI 平台部/演练报告.docx`）→ decision=`allow` | 授权作用域生效 |
| 5 调用 | 拒绝判定：`POST /api/nas/authz/check`（audit 挂根用户）→ decision=`deny`，reasons=`org.root-no-role`（拒绝 100% 带理由）；文件网关调用：`GET /api/nas/:id/fs?path=/skillhub`（dev，授权用户读）→ 200；`POST /api/nas/:id/fs/upload`（admin）→ 200 | allow/deny 双判定 + fs 调用全通 |
| 6 回传断言 | `GET /api/usage/events?resource=nas:nas_mtkb7bbd2qib1i8k` | 200，total=2（calls 全量 + upload 附 bytes=33），事件：`uevt_mtkb7bch2qik7094`、`uevt_mtkb7bbx2qii1yyc` |

## 四、usage 事件 ID 清单（本次归档运行真实值）

| 资源 | event_id | 产出口径 |
|---|---|---|
| `skill:skl_mtkb7a7k2qgtjkjo` | `uevt_mtkb7a7r2qh0ccfc` | 安装（平台自动计量，零费率） |
| `skill:skl_mtkb7a7k2qgtjkjo` | `uevt_mtkb7a7w2qh45sf6` | 下载留痕（平台自动计量，零费率） |
| `skill:skl_mtkb7a7k2qgtjkjo` | `uevt_mtkb7a7z2qh6qsox` | 调用侧经 usage 管道回传（`POST /api/usage/record`） |
| `app:app_mtkb7agi2qh8e8hn` | `uevt_mtkb7agu2qhlhgmq` | 打开/调用（nonbillable，`app:*` 零费率规则播种） |
| `mcp:drill-search-37637` | `uevt_mtkb7b2e2qi2lj8o` | `POST /api/mcp/invoke` 自动计量 |
| `mcp:drill-search-37637` | `uevt_mtkb7b2k2qi8qg06` | `POST /mcp`（mcp_invoke）自动计量 |
| `nas:nas_mtkb7bbd2qib1i8k` | `uevt_mtkb7bbx2qii1yyc` | fs 列目录（calls）自动计量 |
| `nas:nas_mtkb7bbd2qib1i8k` | `uevt_mtkb7bch2qik7094` | fs 上传（calls + bytes=33）自动计量 |

## 五、发现的问题与处置

1. **Skill 提交响应未回显 riskLevel**（演练输出 `risk=-`）：`POST /api/skills` 响应体仅含 `{id,status,findings,hasPackage}`，风险等级要再查 `GET /api/skills/:id` 才可见。轻微观测缺口，不阻断链路。处置：WP-08 登记引导页前端取风险等级改走详情接口；无需改平台。
2. **MCP invoke 响应未回显 exec 字段**（演练输出 `exec=-`）：执行层标记（real/demo）在响应体不可见，仅在 `/api/mcp/calls` 调用留痕里有。处置：前端展示执行层口径时读调用留痕；记录在案。
3. **NAS 无独立审批工作流**：上架（transition online）无审批单。演练以「orgRoot 锚点 + 数据权限规则基线确认（乐观锁 PUT，v1→v2）」作为审批把关步，并在矩阵中如实标注。处置：深化期 KBaaS/知识包登记若需审批流，建议复用 skillhub 两级（领域+安全）模式，另行立项。
4. **Skill 调用侧无独立运行时端点**（已知形态，非缺陷）：调用=下载留痕 + usage 管道回传，已在 §3.1 注明。与 WP-03 零价快照约定一致（`skill:*` 零费率，charge=0，不污染计费总额）。
5. **审批响应语义不一致（观察项）**：Skill approve 返回资产记录（版本状态 `approved`），App 上线审批 decide 返回 `status=executed`（审批+执行复合语义）。前端审批按钮流（WP-10 L1/L2 全量化）需按对象类型区分判定值，避免把 `executed` 误判为未知态。

## 六、Phase 1 门禁映射

| 门禁验收项（action-plan §三） | 本演练证据 |
|---|---|
| ① 全链路闭环演练通过 | 四资产 24 步全 PASS，脚本退出码 0（§一矩阵） |
| 调用→usage 事件覆盖率 | 四类资产末步均断言到 usage 事件并回填 event_id（§四），覆盖率 4/4 |
| NAS 拒绝 100% 有理由/闭环 | deny 判定带 `org.root-no-role` 结构化理由（§3.4 步 5） |
| L3 登记→上架 ≤1 工作日 | 四资产登记→上架 0.0s/0.0s/0.4s/0.0s，秒级达成（§三各步 3 耗时） |

---

*演练脚本与记录归档于 `custom/dsh-rq` 分支；重跑 `node tests/full-chain-drill.mjs` 可复验（ID 随实例重建而不同，判定逻辑与链路不变）。*
