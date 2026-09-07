/**
 * 每 Session 反馈控制器（参照 ui-message-feedback/MessageFeedbackController 的
 * 对象层姿态，但刻意更薄）：
 *   - 数据回流走同源 REST（fetch FEEDBACK_ENDPOINT，credentials same-origin 复用
 *     rq_sid 登录态），不占 dsh Remote 通道（spike §4.3 建议先走 ②）。
 *   - 本地乐观态：点击即记；服务端确认不回填（薄端点无读接口）。
 *   - 失败静默（WP-06 契约「降级不打扰会话」）：网络/HTTP 失败只 console 留痕，
 *     不向会话区渲染任何错误——反馈是锦上添花，绝不能变成新的打扰源。
 *   - HostObservable 契约（getSnapshot/subscribe）与 dsh 的 useSyncExternalStore
 *     绑定-kit 兼容，视图经 slots 注入面的 hooks.rqfb 下发。
 * @module @dsh-ops/plugin-rq-card/client/controller
 */

import type { FeedbackResult, FeedbackScore } from '../wire.ts'
import { FEEDBACK_ENDPOINT } from '../wire.ts'
import type { RqFeedbackView } from './slots.ts'

/** 初始视图（冷态：无任何本地标记）。 */
const INITIAL_VIEW: RqFeedbackView = Object.freeze({
  items: new Map(),
})

/** 同源 POST；任何失败折叠为 ok:false，绝不 reject 到调用方。 */
async function postFeedback(body: {
  messageId: string
  score: FeedbackScore
  note?: string
}): Promise<FeedbackResult> {
  try {
    const response = await fetch(FEEDBACK_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    })
    if (!response.ok) {
      return {
        ok: false,
        error: { code: 'http', message: `feedback endpoint HTTP ${response.status}` },
      }
    }
    // 薄端点允许空体（204/空串）：读到什么算什么，ok 缺省按成功解释。
    await response.json().catch(() => undefined)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'transport',
        message: error instanceof Error ? error.message : 'feedback request failed',
      },
    }
  }
}

/**
 * 每 Session 反馈对象层：一个实例背书该 Session 内全部消息的 👍/👎 控件。
 */
export class RqFeedbackController {
  private view: RqFeedbackView = INITIAL_VIEW
  private readonly listeners = new Set<() => void>()

  /** 返回缓存的不可变视图（HostObservable 契约）。 */
  getSnapshot = (): RqFeedbackView => this.view

  /** 订阅视图替换（HostObservable 契约）。 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * 提交评分：先写本地乐观态（选中即亮），再 fire-and-forget 上报。
   * 同分重复点击为 no-op（幂等，避免无意义重发）。
   * @param messageId 定稿 assistant 消息 id。
   * @param score 👍/👎。
   * @param note 可选说明（UI 暂不收集，契约预留）。
   */
  rate(messageId: string, score: FeedbackScore, note?: string): Promise<void> {
    const current = this.view.items.get(messageId)
    if (current?.score === score) return Promise.resolve()
    this.commit(messageId, score)
    // 上报与 UI 解耦：结果只影响 console 留痕，不回滚乐观态（失败静默语义）。
    return postFeedback({ messageId, score, ...(note === undefined ? {} : { note }) })
      .then((result) => {
        if (!result.ok) {
          // 静默降级：端点未上线（404）/网络失败都落在这里，不向会话区报错。
          console.debug('[rq-card] feedback not recorded:', result.error.message)
        }
      })
  }

  /** 替换视图并通知订阅者（订阅者异常就地吞掉，不拖垮通知循环）。 */
  private commit(messageId: string, score: FeedbackScore): void {
    const items = new Map(this.view.items)
    items.set(messageId, { score })
    this.view = Object.freeze({ items })
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[rq-card] feedback subscriber threw:', error)
      }
    }
  }
}
