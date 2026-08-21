# Skill: dsh-ops-mcp

## 何时使用
MCP 服务的接入、部署、灰度发布、回滚、下线、调用网关与运行监控；处理 `mcp.unhealthy` 熔断告警。

## 前置条件
需要 mcp.service.* / mcp.invoke 权限组令牌（dshctl token / DSHCTL_TOKEN）。

## 操作手册

### 场景 1：处理 MCP 熔断告警（audit alerts 出现 mcp_unhealthy）
1. `dshctl mcp list --output json` → 找到 status=unhealthy 的服务
2. `dshctl mcp health <id>` → 手动探测确认（连续失败≥3 触发熔断）
3. `dshctl mcp metrics <id>` → 查看错误率与延迟序列定位时段
4. 恢复策略：
   - 配置/版本问题：`dshctl mcp rollback <id> --targetVersion=<上一稳定版>`
   - 无法恢复：`dshctl mcp offline <id> --reason="<原因>"`（生成 L4 审批单）
5. `dshctl audit logs --resourceId=<id>` 验证处置留痕

### 场景 2：灰度发布新版本
1. `dshctl mcp deploy <id> --dry-run --changelog=<说明>` → 影响面预览
2. `dshctl mcp deploy <id> --gray=10 --version=<x.y.z> --changelog=<说明> --yes`
3. `dshctl mcp metrics <id>` 观察 10-30 分钟错误率
4. 全量：`dshctl mcp deploy <id> --gray=100 --yes`
5. 异常回滚：`dshctl mcp rollback <id> --targetVersion=<稳定版>`

### 场景 3：调用网关验证工具可用性
`dshctl mcp invoke <id> --tool=<工具名> --args='{"query":"连通性验证"}'`
返回 denied 时先检查权限组是否覆盖该调用方；rate_limited 说明触发了限流。

### 场景 4：下线 MCP（L4）
1. `dshctl mcp deploy <id> --dry-run`（或 impact 接口）→ 查看依赖影响面
2. `dshctl mcp offline <id> --reason="<业务原因>"` → 生成审批单
3. 通知第二管理员：`dshctl approval decide <审批单id> --decision=approve --opinion=<意见>`
4. 验证：`dshctl mcp list` 状态 offline，调用方令牌吊销

## 护栏
- offline 必须给 `--reason`；生产环境灰度比例建议 ≤20% 起步
- 熔断开启时网关自动拒绝调用（breaker_open），不要绕过网关直连 endpoint
