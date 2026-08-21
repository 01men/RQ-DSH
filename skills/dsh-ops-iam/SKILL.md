# Skill: dsh-ops-iam

## 何时使用
组织架构调整、账号生命周期（创建/冻结/注销）、角色与用户组维护、三方通讯录同步与冲突处理。

## 前置条件
需要 iam.* 权限组令牌。

## 操作手册

### 场景 1：员工离职联动
1. `dshctl user list --q=<姓名>` → 定位账号
2. `dshctl user freeze <userId> --reason="离职：<日期>" --yes`
   （联动：名下全部令牌立即吊销；若由三方同步触发则为自动流程）
3. `dshctl token list --principalId=<principalId>` 验证令牌已吊销
4. `dshctl audit logs --resourceId=<userId>` 留痕验证

### 场景 2：三方通讯录同步冲突处理
1. `dshctl sync run --provider=dingtalk` → 触发全量同步
2. `dshctl conflict list` → 查看待处理冲突
3. 逐条决策：`dshctl conflict resolve <id> --keep=third_party`（或 platform）
4. 复查：`dshctl user list --org=<orgId>`

### 场景 3：新部门组建
`dshctl org create --name=<部门名> --parent=<父orgId>`
随后批量导账号：`dshctl user create --username= --displayName= --orgId= <userId>`

### 场景 4：权限调整
`dshctl role list` 查看现有角色；通过控制台「角色权限」页勾选权限点（CLI 修改角色走 PATCH /api/iam/roles/:id）。
权限变更实时生效（权限缓存随 iam.permission.changed 事件失效）。

## 护栏
- freeze/deactivate 必须给 `--reason`（审计要求）
- 一人一号：同一三方身份只能绑定一个平台账号
- 删除组织前必须先清空账号与子组织
