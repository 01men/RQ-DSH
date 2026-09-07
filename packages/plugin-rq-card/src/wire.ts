/**
 * @dsh-ops/plugin-rq-card —— 通道常量与载荷类型（wire 层）。
 *
 * 【浏览器安全】本文件被宿主半与浏览器半共同消费：只允许常量与纯类型，
 * 零 Node 内建、零包依赖——可被任意一侧（含浏览器 bundle）内联而不泄漏
 * 运行时身份（对齐 dsh tsdown.client.ts 的 INLINE_SAFE 判据）。
 *
 * 【数据回流选型（spike §4.3 二选一）】走同源 REST：浏览器直接 fetch 到
 * plugin-dsh-bridge 已挂在 /rq 前缀的榕器数据面，复用榕器自身鉴权（rq_sid
 * Cookie）与审计；不新增宿主 RPC 通道（connection.rpc 的 loopback 判定在
 * 反代/远端访问场景有不确定性，spike 风险 R6）。
 */

/** 榕器数据面对外前缀（plugin-dsh-bridge mountPath，单进程单入口）。 */
export const CONSOLE_BASE = '/rq'

/** 👍/👎 反馈薄端点（同源 REST 相对路径）。端点本体由 WP-07 实现
 * （POST → usage.record 零价快照，主体经绑定身份归因）；端点未上线期间
 * 前端调用会得到 404，控制器按「失败静默」处理，不打扰会话。 */
export const FEEDBACK_ENDPOINT = `${CONSOLE_BASE}/api/usage/feedback`

/** 反馈评分（WP-07 契约：score 只有两值）。 */
export type FeedbackScore = 'up' | 'down'

/** POST /rq/api/usage/feedback 请求体（note 可选；不传即纯评分）。 */
export interface FeedbackPayload {
  messageId: string
  score: FeedbackScore
  note?: string
}

/** 反馈端点的最小应答形态（薄端点允许空体：空体按成功解释）。 */
export interface FeedbackReply {
  ok?: boolean
}

/** 反馈提交结果：传输层失败不抛出，折叠为 ok:false（调用方静默降级）。 */
export type FeedbackResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** 本插件注册的 slot 名（与 dsh rc.7 SlotMap 对齐，spike §3.2 名录）。 */
export const SLOT_TOOLVIEW = 'tool.call.toolview' as const
export const SLOT_ASSISTANT_ACTIONS = 'conversation.chat.assistant-actions' as const
export const SLOT_OVERLAY = 'shell.overlay' as const

/** 反馈条在 assistant-actions list 槽的条目 id：与 dsh 自带 'feedback'（order 10）并存。 */
export const FEEDBACK_ENTRY_ID = 'rq-feedback' as const

/** 执行卡在 tool.call.toolview 键位槽的条目 id 前缀（实际条目 id = 前缀 + 工具名）。 */
export const TOOLVIEW_ENTRY_PREFIX = 'rq-tool-' as const

/** 降级角标在 shell.overlay list 槽的条目 id（spike §5 第 6 条）。 */
export const DEGRADED_BADGE_ID = 'rq-card-degraded' as const
