# 应用内权限模块（RBAC）构造指南

> 面向对象：已完成或正在完成[统一身份接入](app-sso-integration.md)的自研应用开发者（含执行接入任务的 AI Agent）。
> 本文档随服务发布，可直接访问 `http://<平台地址>/docs/app-rbac-guide.md`（`/docs` 目录索引页可列全部文档）。
> 目标：在应用内基于平台身份（`userinfo.sub`）构造一套**分层清晰、自锁免疫、可交付**的业务权限模块。

平台只负责「你是谁」（统一身份）；应用内的菜单 / 数据 / 功能权限（「你能干什么」）由应用自理。
本文给出经过真实应用（React SPA 形态）完整验证的标准构造法：其他技术栈保持相同的模型与纪律，只换写法。

## 一、设计原则（五条红线）

1. **关联键只用 `sub`**：`userinfo.sub` 是平台账号的稳定唯一键（永不改变）。显示名 `name` / `preferred_username` 仅作展示，**禁止作主键**（用户可改名）。
2. **平台治理角色 ≠ 业务角色**：`userinfo.roles` 返回的是平台治理角色（`super_admin` 等），表达的是用户在**平台**的地位；应用业务权限一律由应用**自建 `sub → 角色` 映射表**，禁止拿 `roles` 直接放行业务写操作。
3. **登录门**：未取到平台身份（未完成 SSO 登录）前，不渲染任何业务数据、不调业务接口——未登录用户在 DOM 里看不到一条业务数据。
4. **默认最小权限**：映射表中未登记的登录用户一律默认 `viewer`（只读），任何写操作不因「未登记」而放开。
5. **前端显隐是交互层控制**：数据本就在用户浏览器里的纯前端应用，无法对抗打开 devtools 的用户——内网工具可接受；有强数据隔离需求的场景必须把权限判定放到服务端。

## 二、标准三级角色与能力矩阵

能力名可按应用语义增删（如没有导入功能就去掉 `import`），但**保持三段式分层**：查看为默认 → 编辑含数据变更与导入导出 → 管理员含恢复数据与用户授权。

| 能力 | viewer（默认） | editor | admin |
|---|---|---|---|
| view 查看 | ✅ | ✅ | ✅ |
| edit 增 / 删 / 改 | — | ✅ | ✅ |
| import / export 导入导出 | — | ✅ | ✅ |
| reset 恢复初始数据 | — | — | ✅ |
| manageUsers 用户授权 | — | — | ✅ |

```ts
export type Role = 'admin' | 'editor' | 'viewer'
export type Capability = 'view' | 'edit' | 'import' | 'export' | 'reset' | 'manageUsers'

export const ROLE_CAPS: Record<Role, Capability[]> = {
  viewer: ['view'],
  editor: ['view', 'edit', 'import', 'export'],
  admin:  ['view', 'edit', 'import', 'export', 'reset', 'manageUsers'],
}
export const DEFAULT_ROLE: Role = 'viewer'   // 未登记的登录用户默认只读
```

## 三、映射表存储与两条自保规则

**存储**：一条 ACL 记录（localStorage / 服务端均可，React SPA 常用 localStorage，与业务数据同域）：

```json
{ "roles": { "<sub>": { "role": "admin", "name": "张三", "assignedAt": "…" } },
  "users": { "<sub>": { "name": "张三", "lastSeen": "…" } } }
```

- `users` 是登录登记表：SSO 回调成功后调 `noteLogin(sub, name)` 登记，供授权页下拉选择。
- **首登引导**：`noteLogin` 时若映射表中没有任何 `admin`，把当前 sub 自动授予 admin——权限系统零配置起步。**交付时务必提醒用户：用正确的管理员账号首发登录**（第一个登录的人拿管理员）。
- **最后管理员保护**：降级 / 移除角色前检查 admin 数量，禁止动最后一个 admin（授权页 UI 与逻辑层双重校验），防止权限系统自锁。
- **存储语义写进交付文档**：
  - 映射表存浏览器 localStorage 时，换浏览器 / 换电脑需重新分配（跨机可借助应用自身「全量导出 / 导入」，或将来迁服务端）；
  - 「恢复初始数据」类功能**只清业务数据、不清权限映射**——否则会把管理员锁在门外。

## 四、UI 纪律（关键实操）

原则：**按能力点判断（`can('edit')` 风格）而非角色名比较**；无权限**隐藏而非禁用**；只读态表格去掉交互列。

| UI 元素 | 能力点 | 无权限时的处理 |
|---|---|---|
| 新增 / 行编辑 / 行删除 / 删除所选 / 勾选列 / 操作列 | `edit` | 整块条件渲染；表头 tbody 同步去列，修正空态 colSpan |
| 导入 Excel / 模板 / 覆盖导入开关 / 上传附件 | `import` | 隐藏（`<input type=file>` 可常驻但无入口） |
| 导出 / 导出汇总 | `export` | 隐藏 |
| 恢复初始数据 / 危险操作 | `reset` | 隐藏 |
| 权限管理导航与页面 | `manageUsers` | 隐藏导航 + 页面入口二次校验 |
| 行内编辑输入框（onBlur 保存类） | `edit` | 只读态渲染纯文本 |

兜底：所有数据变更入口走权限显隐后，仍建议在 `add / update / remove / importRows` 调用点前断言 `can('edit')`，防止未来新增入口漏改。

## 五、授权管理页（admin 专属，`manageUsers` 能力点）

- 用户列表 = `users` 登记表 ∪ `roles` 映射表的 sub 并集；当前登录用户置顶并加「我」徽章。
- 列：用户名、平台 ID（`sub`，等宽字体截断 + title 悬浮全文）、最近登录时间、角色下拉。
- 角色下拉：`未分配（默认查看）/ 查看 / 编辑 / 管理员`；「未分配」= 删除映射条目（回落默认 viewer）。
- 页头说明文案必须包含：sub 为平台唯一关联键、各角色能力一句话、**权限存本机浏览器（换电脑需重新分配）**、「恢复初始数据不清除权限」。

## 六、React 参考实现（Provider + 通知总线）

```tsx
// src/lib/permissions.tsx —— 要点骨架（完整能力见上文矩阵与规则）
const AclContext = createContext<Acl | null>(null)
const listeners = new Set<() => void>()
export const notifyAclChanged = () => listeners.forEach((fn) => fn())   // 模块级通知总线

export function AclProvider({ children }: { children: ReactNode }) {
  const [acl, setAcl] = useState(() => readAcl())          // 从 localStorage 读
  useEffect(() => {
    const refresh = () => setAcl(readAcl())
    listeners.add(refresh)
    return () => { listeners.delete(refresh) }
  }, [])
  // 登录 / 登出 / 改角色后调 notifyAclChanged()，Provider 与 currentUser() 同步刷新
  const can = (cap: Capability) =>
    myRole(acl) !== null && ROLE_CAPS[myRole(acl)!].includes(cap)    // 未登录恒 false
  const setRole = (sub: string, role: Role | null, name?: string) => { /* 最后管理员保护 + 写回 + notify */ }
  return <AclContext.Provider value={{ acl, mySub, myRole, can, setRole }}>{children}</AclContext.Provider>
}
export const useAcl = () => useContext(AclContext)!
```

- `noteLogin(sub, name)`（SSO 回调成功后调用）：登记 `users[sub]` + 首登引导（无 admin 则授 admin）+ `notifyAclChanged()`。
- 登出：清 SSO 会话 + `notifyAclChanged()`（`can()` 因未登录恒 false，UI 自动收敛为不可操作）。
- 组件内用法：`const { can } = useAcl()` → `{can('edit') && <Button onClick={…}>新增</Button>}`。

## 七、验证清单（交付前按序自测）

1. 未登录：只见登录页，业务数据零渲染。
2. 首登（系统无管理员）：当前用户自动成为 admin，授权页可见。
3. admin 把自己降级为 viewer：被「最后管理员保护」拦截。
4. editor 登录：可见编辑 / 导入导出，不可见「恢复初始数据」与「权限管理」。
5. 未登记用户新登录：默认只读（viewer），无任何写入口。
6. 执行「恢复初始数据」：业务数据还原，权限映射不变，admin 仍可管理。
7. 只读态表格：无勾选列 / 操作列，空态行 colSpan 与列数一致。

## 八、已知边界（写进交付文档）

1. 前端显隐只管交互层：纯前端应用无法对抗打开 devtools 的用户（见原则 5）。
2. localStorage 方案在多机 / 多浏览器间各自独立分配；换机交付需重新授权。
3. 首登成 admin 是自助引导机制：生产环境第一个登录的人拿管理员，务必安排对账号首发。
