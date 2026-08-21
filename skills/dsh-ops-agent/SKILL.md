# Skill: dsh-ops-agent

## 何时使用
Agent 注册与属性登记、用户绑定、试运行/上线/下线生命周期（L4 审批）、运行监测与异常排查。

## 前置条件
agent.write / agent.approve 权限；上线审批需第二管理员配合。

## 操作手册

### 场景 1：下线异常 Agent（标准闭环）
1. `dshctl agent metrics <id>` → 确认异常（成功率骤降/调用突增）
2. `dshctl audit logs --resourceId=<id>` → 回溯最近变更
3. 影响面预览：GET /api/agents/<id> 的 impact 字段
4. `dshctl agent offline <id> --reason="<原因>" --requesterId=<发起人> --requesterName=<姓名>`
   → 生成 L4 审批单
5. 第二管理员：`dshctl approval decide <审批id> --decision=approve --opinion=<意见>`
6. 验证：`dshctl agent get <id>`（状态 offline、机器凭证禁用、绑定用户已通知）

### 场景 2：注册新 Agent
`dshctl agent create --name=<名称> --model=deepseek-chat --riskLevel=low`
→ 返回机器凭证（仅一次）。补全 systemPromptVersion/dataClass 后方可上线。

### 场景 3：上线流程
1. 确认治理属性齐备（否则接口会给出具体缺失项）
2. 试运行：`dshctl agent ... transition submit_trial`（限定用户组）
3. 上线：POST /api/agents/<id>/transition {action:"online"} → 审批单 → 双人确认

## 护栏
- offline 必须给 reason；上线/下线均为 L4 审批
- 下线联动：吊销机器凭证 + 通知绑定用户 + 保留审计数据
- 调用频次突增（10 分钟 >120 次）会自动触发行为告警
