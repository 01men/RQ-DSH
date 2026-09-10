# spike 结论 —— cordis 4.0.1 可选服务依赖语义（plan-gate01 Phase 0）

> 状态：**定稿**。2026-09-10 实证完成，探针脚本实测复现全部结论（探针脚本见文末，已运行验证）。
> 对象：`@deepseek-ai/cordis` 4.0.1（`node_modules/@deepseek-ai/cordis`，ESM 单文件
> `lib/index.js` 1829 行 + `src/*.ts` 原始实现 + `lib/types/*.d.ts`）。
> 本结论是 plan-gate01.md Phase 2/3 的全局设计输入。

## 一、两个核心问题的答案

### Q1：inject 声明了键、但环境无该键提供者

**永久静默挂起。** 不抛错、不超时、apply 永不执行；且 `await fiber` 会**假成功**立即 resolve。
提供者稍后注册时会自动激活（响应式，无轮询）。

实现链路（行号指 `lib/index.js`）：
- `Inject.resolve()`（:1490-1499）把声明归一为 `name → intercept config` 映射，**每个键都是硬依赖**；
- `Fiber._refresh()`（:1316-1328）：任一键的 `_store[name]` 缺失 → epoch = INACTIVE；
- `_setEpoch(INACTIVE)`（:1329-1343）：初始 epoch 即 INACTIVE，直接 return，无日志无异常，**无超时机制**；
- `fiber.await()`（:1398-1402）：等待期 `inertia` 与 `_error` 均空 → 立即正常返回
  （实测 `[B] await() resolved -> state 0`）——**装机门禁不能用 await 判断启动成功，
  必须用 `fiber.state === 2`（active）或监听 `internal/status`**；
- 提供者出现：`provide()`（:799-823）→ `_updateState`（:1293-1304）→ `notify()`（:831-851）
  → 依赖齐 → `_reload()`（:1348-1370）执行 apply（实测延迟提供后 state 0→2）。

仓库注释佐证：`packages/plugin-panel-core/src/index.ts:35`「cordis 的 inject 是加载前硬依赖，
自依赖=永久挂起」。

### Q2：插件未声明某键，运行期访问 `ctx.<key>`

**在已激活插件内直接抛 `Error: cannot get property "<key>" without inject`**——
不是 undefined、不是 pending 代理；即使该服务有提供者也抛。只有 root/非插件上下文静默返回 undefined。

实现：`ReflectService.handler.get` 代理 trap（:672-698），关键行：
- :675 构造 `cannot get property "<key>" without inject`；
- :679 仅 root 静默 `ctx.reflect.get(prop, false)`；
- :686-690 键在 `fiber.inject` 中 → 改抛 `cannot get required service "<key>" in inactive context`（等待中插件访问已提供键也抛——**全有或全无**）；
- 否则向上层 fiber 链查 store 快照，到 root 仍无 → 抛 :675 的错。

### 补充语义（均实测）

- 等待中的插件内访问**已提供**的声明键也抛（部分满足不可用）；
- **逃生舱**：`ctx.reflect.get(name, strict = true)`（:762-771）绕过 inject 要求直接读 store；
  `strict = false` 连「提供者未激活」也容忍，返回 undefined。仓库既有用法：
  `packages/plugin-dsh-bridge/src/index.ts:71/:267`（form B 装配注释）。

## 二、optional inject 语法：**不支持**

- 类型 `lib/types/registry.d.ts:13-15`：`Inject<M> = (keyof M)[] | { [K in keyof M]?: M[K] }`
  ——只有字符串数组、或「服务名 → intercept config」对象（对象的值是 resolveConfig 配置，
  :1804-1815）；`lib/index.js` 全文无 `{ required: [], optional: [] }` 解析。
- 实测：字面写 `inject: { required: ['httpServer'], optional: ['iam'] }` 会被解析成
  对名为 `"required"` 与 `"optional"` 两个**服务**的依赖（`fiber.inject` 键 =
  `["required","optional"]`），httpServer 不被注入，插件永久挂起（state 0）。
- 可选依赖唯一等价替代：**不声明该键，用 `ctx.reflect.get('<key>', false)` 软读**；
  或监听 `internal/get` waterfall 事件兜底（:680）。

## 三、仓库内 inject 写法清单

全部为字符串数组形式（无对象形式、无 required/optional）：
- 模块级 `export const inject = [...]`：全部 23 个 packages + 各包 src/tools.ts；
- 类上 `static readonly inject = [...]`：plugin-authn/src/oidc.ts:132、entry-ticket.ts:46、
  platform-core/src/behavior.ts:121、plugin-nas/src/authz.ts:89；
- 对象字面量 `inject: [...]`：plugin-connect/src/host.ts:113/:339、plugin-update/src/index.ts:526/:594。

## 四、对 Phase 2/3 的设计决定（全局设计输入）

1. **inject 收缩可行**：panel-core 收缩为 `[httpServer, opsStorage, platformBus, tools, scenegraphs]`、
   rq-card 收缩为 `[httpServer, tools, opsStorage]`——只要剩余键全部有提供者，apply 正常执行
   （且更早），去掉键只减少等待项，不引入错误。
2. **降级模式选定：`inject 收缩 + ctx.reflect.get(key, false) 软读`**，不必拆条件装配子插件。
   两级降级按 plan-gate01 §四 Phase 2.1：
   - 记录/查询类（audit/usage/behavior）：null-object 适配（空记录、空聚合）；
   - 能力类（modelGateway/resourceCore/mcpRegistry/skillHub/iam/authn）：特性级降级
     （端点 503 DEGRADED 或向导隐藏入口）。
3. **硬约束**：业务代码不得残留对被删 9 键的直接 `ctx.<key>` 访问（激活插件内=硬错误），
   全部改软读——这也是 Phase 2「访问点清扫台账」逐点定性的依据。
4. **启动断言**：装机验证用 `fiber.state === 2`，不能用 `await fiber`（假成功）。

## 五、最小探针脚本（已运行验证）

```js
// probe-cordis.mjs — node >= 22.6, 在 D:\DSH-RQ 根目录运行
import { Context, Service } from './node_modules/@deepseek-ai/cordis/lib/index.js'

class HttpServer extends Service { constructor(ctx) { super(ctx, 'httpServer') } }
class Iam extends Service { constructor(ctx) { super(ctx, 'iam') } }
const root = new Context()
root.plugin(HttpServer)
await new Promise(r => setTimeout(r, 30))

// 1) 字面 { required, optional } 对象形式：被解析成两个名为 "required"/"optional" 的服务依赖
const pA = root.plugin({ name: 'A', inject: { required: ['httpServer'], optional: ['iam'] },
  apply(c) { console.log('[A] apply ran, ctx.iam =', c.iam) } })
await new Promise(r => setTimeout(r, 30))
console.log('[A] state =', pA.state, '| inject 被解析为服务名:', Object.keys(pA.inject))

// 2) 数组 inject：提供 httpServer，永不提供 iam
const pB = root.plugin({ name: 'B', inject: ['httpServer', 'iam'],
  apply(c) { console.log('[B] apply ran, ctx.iam =', c.iam?.name) } })
await new Promise(r => setTimeout(r, 30))
console.log('[B] state =', pB.state, '| await() 结果 state =', await pB.await().then(f => f.state))

// 3) 激活插件内访问未声明键 ctx.usage；root 上访问同键
await root.plugin({ name: 'C', inject: [], apply(c) {
  try { console.log('[C] ctx.usage =', c.usage) } catch (e) { console.log('[C] ctx.usage THREW:', e.message) } } })
console.log('[root] ctx.usage =', root.usage)

// 4) 延迟提供 iam → B 自动激活
setTimeout(() => root.plugin(Iam), 300)
setTimeout(async () => { await new Promise(r => setTimeout(r, 150))
  console.log('[B] state AFTER iam =', pB.state); process.exit(0) }, 600)
```

实测输出：
`[A] state = 0 / keys ["required","optional"]`；
`[B] state = 0 / await() 结果 state = 0`（await 假成功）；
`[C] ctx.usage THREW: cannot get property "usage" without inject`；
`[root] ctx.usage = undefined`；
`[B] apply ran, ctx.iam = iam`；`[B] state AFTER iam = 2`。

**Phase 0 关闭，书面结论齐备，Phase 1 解锁。**
