# Skill: dsh-ops-admin（平台总控）

## 何时使用
管理员/运维 Agent 需要对「企业 AI 资源管理平台」执行任何运维操作时，先读本索引找到对应的领域 Skill，再按其操作手册执行。典型场景：监控告警处理、资源上下线、审批处理、异常排查、成本分析。

## 前置条件
- 平台服务运行中（默认 http://127.0.0.1:7300，可用 `DSHCTL_URL` 覆盖）
- 需要 ops 类权限令牌：`DSHCTL_TOKEN`，或 `DSHCTL_USER/DSHCTL_PASS`（默认 admin）
- CLI：`node cli/dshctl.mjs <resource> <action>`（所有输出可 `--output json`）

## 领域 Skill 索引
| 领域 Skill | 覆盖范围 | 关键命令前缀 |
|---|---|---|
| dsh-ops-iam | 组织/账号/角色/用户组/三方同步/冲突 | `dshctl org` `dshctl user` `dshctl sync` `dshctl conflict` |
| dsh-ops-authn | 机器凭证/令牌签发吊销/密钥轮换 | `dshctl token` `dshctl credential` |
| dsh-ops-mcp | MCP 部署/灰度/回滚/网关调用/监控 | `dshctl mcp` |
| dsh-ops-skillhub | Skill 提交/审批/上架/安装/弃用 | `dshctl skill` |
| dsh-ops-agent | Agent 注册/绑定/上下线/指标 | `dshctl agent` |
| dsh-ops-app | AI 应用/拓扑/成本穿透 | `dshctl app` |
| dsh-ops-audit | 审计日志/告警/审批中心/成本 | `dshctl audit` `dshctl approval` `dshctl cost` |

## 通用运维闭环（方法论）
1. **诊断**：`dshctl audit alerts --unread` + `dshctl mcp list` 定位异常
2. **取证**：`dshctl audit logs --resourceId=<id>` 回溯操作链
3. **预演**：变更命令带 `--dry-run` 查看影响面
4. **执行**：L4 高危操作生成审批单（`--reason` 必填），等待双人确认自动执行
5. **验证**：`dshctl <resource> get <id>` 确认终态 + 审计回写

## 护栏（全局）
- offline / freeze / revoke / deprecate 必须给出 `--reason`，原因永久留痕
- L4 操作（下线/吊销/删除/批量>10）一律走审批单，发起人与审批人不得为同一人
- 批量操作超过 10 个对象需二次确认
- 一切只读命令（list/get/metrics/logs）可放心执行

## 帮助
`dshctl help` 查看全部命令与全局选项。
