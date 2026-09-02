/**
 * 四态状态源映射 —— 纯函数（行动方案 §三 泳道 C 的 C2 表，WP-06 交付物 2）。
 *
 * 【零依赖铁律】本文件不 import 任何东西（react / 任何包 / Node 内建）——
 * 主仓 selftest 会直接 import 这个 TS 文件做单测（Node ≥22.18 原生加载 TS），
 * 自证脚本：node packages/plugin-rq-card/src/client/state.test.mjs
 *
 * 与 C2 表的逐行对应：
 *   ┌────────┬────────────────────────────────────────────┬──────────────────────┐
 *   │ 用户四态 │ 状态源（C2 表原文）                          │ 本函数判定            │
 *   ├────────┼────────────────────────────────────────────┼──────────────────────┤
 *   │ 调用中   │ mcp invoke() 发起中                          │ invokePhase='calling' │
 *   │ 执行中   │ online/gray 且 health∈{healthy,degraded}     │ health=healthy|       │
 *   │        │ （30s 轮询）                                 │ degraded，且无结果     │
 *   │ 已完成   │ 调用返回 + usage.recorded 落库               │ hasResult 且非错误     │
 *   │ 异常阻断 │ down / breakerOpen / nas-authz deny /        │ 任一阻断标志在场       │
 *   │        │ 额度耗尽                                     │ （见下方优先级）       │
 *   └────────┴────────────────────────────────────────────┴──────────────────────┘
 *
 * 判定优先级（自上而下，命中即返回）：
 *   ① 异常阻断（平台侧标志，按既定优先级取首个命中）
 *      authzDenied > quotaExceeded > pdpUnreachable > breakerOpen > down > bindingInvalid
 *      —— 阻断整体优先于调用生命周期：阻断标志描述「当前不允许/不可用」，fail-safe
 *      原则下呈现红边条永远不会误导；历史调用的完成信息以工具结果 markdown 兜底
 *      文本（宿主半 summarizeForToolResult 契约）与 usage 台账为准。
 *   ② 已完成：hasResult 且结果非错误 → 'done'（呈现结果 + 👍/👎）；
 *      结果为错误（spike §2.5 证据 E3：tool/result.isError → 异常）→ 'blocked' +
 *      兜底原因码 'invoke-error'（C2 表原因码为平台侧六码，工具自身报错补此码）。
 *   ③ 调用中：invokePhase='calling'（invoke 发起段，网关握手未落到资源执行段）
 *      → 'calling'（同一时刻健康面也在场时仍先呈现发起段：骨架 + 可取消）。
 *   ④ 执行中：health ∈ {healthy, degraded} 且无结果 → 'executing'；
 *      degraded 时附加 degraded:true（呈现「有点慢」提示，C2 表执行中行）。
 *   ⑤ 其余 → 'idle'（空闲基态：无结果、无 invoke、健康面 unknown）。
 */

/** invoke 发起相位（本插件当前能观测到的调用发起侧信息）。 */
export type InvokePhase = 'idle' | 'calling'

/** 资源健康面（30s 轮询；unknown = 尚无健康数据）。 */
export type HealthStatus = 'unknown' | 'healthy' | 'degraded' | 'down'

/** 四态映射的输入快照（全部字段都是「当前观测」，无时序耦合）。 */
export interface ExecutionStateInput {
  /** 已收到工具结果（tool/result 已定稿）。 */
  hasResult: boolean
  /** 结果是否为错误（ToolResultNode.isError）。 */
  resultIsError: boolean
  /** 资源健康面（缺省 unknown）。 */
  healthStatus?: HealthStatus
  /** mcp 网关熔断器开启。 */
  breakerOpen?: boolean
  /** nas-authz 五步判定拒绝（fail-closed）。 */
  authzDenied?: boolean
  /** 钱包额度耗尽。 */
  quotaExceeded?: boolean
  /** 策略决策点（PDP）不可达——保护性阻断。 */
  pdpUnreachable?: boolean
  /** dsh-bridge 身份绑定失效。 */
  bindingInvalid?: boolean
  /** invoke 发起相位。 */
  invokePhase: InvokePhase
}

/** 用户可感知四态 + 空闲基态（C2 表「用户四态」列；idle 为无调用时的基态）。 */
export type ExecutionUiState = 'idle' | 'calling' | 'executing' | 'done' | 'blocked'

/**
 * 异常阻断原因码 —— C3 错误文案共享模块（console 侧 js/errors.js）的键。
 * 前六码与 C2 表/C3 初始清单一一对应；'invoke-error' 为工具自身报错的兜底码
 * （spike 证据 E3 判 isError 为异常，但 C2 平台侧六码不含它，故补一码，
 * 呈现通用错误文案 + 结果详情）。
 */
export type BlockedReason =
  | 'nas-authz-deny'
  | 'quota-exhausted'
  | 'pdp-unreachable'
  | 'breaker-open'
  | 'down'
  | 'binding-invalid'
  | 'invoke-error'

/** 四态映射输出：UI 态 + 阻断原因码 + degraded 附加信息。 */
export interface ExecutionState {
  /** UI 态。 */
  state: ExecutionUiState
  /** 仅 state === 'blocked' 时存在：阻断原因码（错误文案/行动按钮的键）。 */
  reason?: BlockedReason
  /** 仅 state === 'executing' 且 healthStatus === 'degraded' 时为 true（「有点慢」提示）。 */
  degraded?: boolean
}

/** 组装阻断态（窄化输出形状：blocked 必带 reason）。 */
function blocked(reason: BlockedReason): ExecutionState {
  return { state: 'blocked', reason }
}

/**
 * 四态状态源映射纯函数（C2 表的代码化）。
 * 输入输出均为纯数据：不读时钟、不发请求、不改外部状态，同输入恒同输出。
 */
export function deriveExecutionState(input: ExecutionStateInput): ExecutionState {
  // ① 异常阻断：平台侧标志按既定优先级取首个命中（任务书顺序：
  //    authzDenied > quotaExceeded > pdpUnreachable > breakerOpen > down > bindingInvalid）。
  if (input.authzDenied === true) return blocked('nas-authz-deny')
  if (input.quotaExceeded === true) return blocked('quota-exhausted')
  if (input.pdpUnreachable === true) return blocked('pdp-unreachable')
  if (input.breakerOpen === true) return blocked('breaker-open')
  if (input.healthStatus === 'down') return blocked('down')
  if (input.bindingInvalid === true) return blocked('binding-invalid')

  // ② 已完成 / 结果级异常：调用已返回，usage 落库由服务端保证（前端只认结果）。
  if (input.hasResult) {
    return input.resultIsError ? blocked('invoke-error') : { state: 'done' }
  }

  // ③ 调用中：invoke 发起段（C2 表第一行的状态源）。
  if (input.invokePhase === 'calling') return { state: 'calling' }

  // ④ 执行中：资源 online/gray 且健康面健康/降级（30s 轮询）；
  //    degraded 附带 degraded:true → 卡片呈现「有点慢」。
  if (input.healthStatus === 'healthy') return { state: 'executing' }
  if (input.healthStatus === 'degraded') return { state: 'executing', degraded: true }

  // ⑤ 空闲基态。
  return { state: 'idle' }
}
