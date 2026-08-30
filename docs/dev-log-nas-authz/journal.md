# NAS 数据权限（nas-authz）灰度日志

> 用途：跨会话接续。任何新窗口从这里恢复上下文：现在处于 G0 观察期，等数据核对后人工切 G1。

## 当前状态（2026-08-30）

**G0 观察期第 1 天**（observeOnly=true，只记录不拦截）。数据治理与多身份权限已全部落地并部署上线，等观察 3~5 天、deny 核对无误报后，人工逐令牌切 G1。

## 2026-08-30 会话完成清单

### 数据治理（P0）
- 两主体（杭州榕器创 / 金华聚杰电器）钉钉连接器重推，**65 个部门负责人落库**（来源 dept_manager_userid_list，零手工指定）；数字化技术服务平台负责人 = 师圆圆（钉钉侧任命）。
- 榕器创树因钉钉根部门改名（→「杭州榕器创科技有限公司」）被整树重建：20 人按 remoteId 迁移、15 个旧节点删除。
- 榕器创nas(0.196) 锚点重指新根 `org_mtfjjvin4kweaad9` + `orgPathOverrides={"新根":"/"}`（目录平铺口径，同 0.195 品管部→/日志归档）。

### 代码修复（全部已部署上线，selftest 658/658 · smoke 24/24 · lint 70/70）
| commit | 内容 |
|---|---|
| 2cbc834 | 网关映射补 fs_task_status/fs_task_clear（G0 实测 observeOnly 下映射外也硬拒）+ 工具面↔映射表双向一致断言 |
| d9a117a | **unionId+userid 双身份链**（修复 hermes 上报 userid 全员反查不到的系统性缺口）；负责人映射移到用户循环后；多部门兼任落库 |
| 08621bf | 多部门用户主归属以钉钉 dept_id_list[0] 为准 |
| f9bef48 | 作用域锚对齐：主部门在下属班组的负责人，作用域提升到所领导部门 |
| 05a952d | 跨分支领导作用域（leaderOfElsewhere）——师圆圆案例：主部门研发技术服务平台(D) + 跨分支领导数字化技术服务平台(D) + 挂靠产品中心 |
| a092765 | 多身份作用域重叠按 P>D>T 取最高档 |
| 15b628a | 主作用域 no-scope 不再提前拒绝（吞掉跨分支领导作用域的 bug） |
| 4067dc6 + 01fb5e4 | **G0 观察模式接入真实判定流**：未开 enforce 的令牌照常过 PDP 留痕（OBSERVE-DENY 数据=灰度退出依据），不拦截、不进缓存、PDP 故障直通 |
| df05c89 | nas-authz.md 一人多身份语义文档 |

### 实弹验证（agent 链路）
hermes 调用方式（MCP 令牌 + X-On-Behalf-User userid）穿透网关实测：越界 delete → PDP 判 deny（userName=师圆圆, role=D, observeOnly=true）→ 业务放行 → 留痕入库。**G0 deny 数据已从真实 agent 流量开始积累。**

## 日常机制

- **每日 09:00 自动核对报告**（ZCode 定时任务 automation-0ce96e1a）：跑 `D:\DSH-07\g0-daily-report.py`，输出 deny 明细 + 切换核对清单；历史在同目录 `g0-report-history.md`。只报告，**切 G1 永远等用户拍板**。
- 手动跑：`python D:\DSH-07\g0-daily-report.py --days 3`。

## 下一步（按序）

1. **G0→G1**（观察满后人工拍板）：网关 `nas-tokens.json` 逐令牌加 `enforce: true`，每令牌观察 1 天；回退=单令牌改回或 `AUTHZ_ENFORCE=off`。
2. **G2**：hermes 本地直读 guard（`integrations/hermes-patch/apply_patch6.py`）——0.7 上 `/opt/data/hermes-dingtalk-patch/` 目前为空、6 实例无 AUTHZ 环境变量，属未部署；需按实际镜像回填 TARGET_HASHES，0.195 单实例先行。
3. **DSM 兜底绑定**（dev-plan 步骤 0，未做）：6 个 hermes 令牌绑定收敛后的 DSM 账户。平台 fs 代理对 0.196 报 DSM 401 即此因。

## 遗留疑点（不阻塞，待确认）

- 双主体根部门同为钉钉 dept 1（remoteId=1 双根）：connectorId 区分，设计内；
- 战略 NAS(0.192) orgRoot=董事办（不是聚杰的战略平台部门）：待确认是否有意；
- cGroups 为空：C 跨域协作者角色无动态组挂载，需要时再配；
- 陈伟董事办负责人已被钉钉侧换人（如实同步，现为部门根只读）；
- 0.196 实际目录层级建议用真实业务路径复核 override。

## 关键入口

- 控制台 `#/nas-authz`（规则/例外/试算/留痕）；CLI `dshctl nas authz check|scope|rules|decisions`
- 服务：`systemctl restart ops-platform` / `synology-filestation-mcp`（0.7，root）
- 部署：`D:\DSH-07\daily-sync-deploy.py`（仓库→/opt/ops-platform，md5 复核）；网关运行副本在 `/opt/synology-filestation-mcp`，authz.js 改动需另行同步（当前与仓库一致）
- 管理员登录口径见 `D:\DSH-07\health-probe.js`
