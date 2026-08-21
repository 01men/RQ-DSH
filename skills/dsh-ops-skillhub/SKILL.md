# Skill: dsh-ops-skillhub

## 何时使用
Skill 提交、审批流水线（静态扫描→领域审批→安全加签）、上架/安装/弃用、市场检索。

## 前置条件
skill.submit（提交）/ skill.approve（审批）/ skill.publish（上架）权限。

## 操作手册

### 场景 1：提交新 Skill
1. 准备 SKILL.md（何时使用/步骤/输出格式）
2. `dshctl skill submit --name=<名称> --content-file=./SKILL.md --category=<分类>`
3. blocked（恶意代码/密钥泄露）会自动驳回——修复后重新提交
4. 高风险（外联/写文件）需两级：领域审批 + 安全加签

### 场景 2：审批（领域负责人/安全团队）
1. `dshctl skill list --pending` 或控制台「待审批」视图
2. `dshctl skill approve <id> --level=domain --decision=approve --opinion=<意见>`
3. 高风险再执行：`--level=security`
4. `dshctl skill publish <id>` 上架（版本不可变）

### 场景 3：安装到 Agent
`dshctl skill install <id> --agentId=<agentId>`（自动登记依赖并回填关联列表）

### 场景 4：弃用与迁移
`dshctl skill deprecate <id> --reason=<原因>`
存量引用的 Agent 会收到迁移告警——通知负责人更换替代版本。

## 护栏
- 版本不可变：修复必须递增版本号
- 强制下架（force）属 L4 操作，建议走审批
