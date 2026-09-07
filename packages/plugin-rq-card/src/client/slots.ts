/**
 * 注入面类型（InjectFace / PropsRuntime 组合，spike §4.1 文件清单的 slots.ts）。
 *
 * 两个 slot 条目的 props 形状：
 *   - ExecutionCard ← `tool.call.toolview` 键位槽：owner（ui-tool 的 ToolCallTree）
 *     提供 callId/toolName/block/cwd/openFile/inspect；InjectFace 展开本插件
 *     inject 回调的产物；PropsLocale 绑定 `rq-card` 词典座位。
 *   - RqFeedback ← `conversation.chat.assistant-actions` list 槽：owner 提供
 *     messageId（spike §2.4 证据 D2）。
 *
 * 全部 dsh 包引用都是 type-only（编译期擦除，不进 bundle、不触构建纯度门禁）。
 * @module @dsh-ops/plugin-rq-card/client/slots
 */

import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only：拉入 ui-conversation 的 SlotMap merge（assistant-actions 条目形态）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only：拉入运行时快照的 ToolCallBlock 联合类型（spike §2.5 证据 E3）。
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only：拉入本包的 LocaleNamespaceMap merge（'rq-card' 座位）。
import type {} from './locales.ts'
import type { ExecutionState, ExecutionStateInput } from './state.ts'

/**
 * 执行卡的注入面。
 */
export interface RqToolviewInjected {
  /**
   * 四态映射入口（包一层 deriveExecutionState，保持卡片为纯渲染器、测试可替换）。
   */
  deriveState: (input: ExecutionStateInput) => ExecutionState
  /**
   * 资源健康面/阻断标志快照（30s 轮询与熔断/授权/绑定标志的接线点）。
   * 宿主半接线前返回空对象（= health unknown），卡片按调用生命周期降级呈现；
   * 接线后本函数的返回值展开进 deriveState 的输入，卡片自动升级为四态完整呈现。
   */
  healthSnapshot?: () => Partial<ExecutionStateInput>
}

/** 执行卡完整 props（键位条目标准组合，对齐 ui-tool 的 ToolCallViewProps 惯例）。 */
export type ExecutionCardProps = PropsRuntime<'tool.call.toolview'>
  & InjectFace<RqToolviewInjected>
  & PropsLocale<'rq-card'>

/** 反馈条视图：每消息已提交评分的本地乐观态（服务端确认不回填——薄端点
 * 无读接口，失败静默保留本地标记，不打扰会话）。 */
export interface RqFeedbackView {
  /** 每消息一条：当前选中的评分。 */
  items: ReadonlyMap<string, { score: 'up' | 'down' }>
}

/**
 * 反馈条的注入面。
 */
export interface RqFeedbackInjected {
  /** 本会话共享的乐观态（每 Session 一个控制器）。 */
  hooks: { rqfb: HostObservable<RqFeedbackView> }
  /**
   * 提交评分（fire-and-forget：网络失败静默降级，不向会话区报错）。
   * @param messageId 定稿 assistant 消息 id。
   * @param score 👍/👎。
   * @param note 可选补充说明（当前 UI 不收集，契约预留）。
   */
  rate: (messageId: string, score: 'up' | 'down', note?: string) => Promise<void>
}

/** 反馈条完整 props（list 条目标准组合，对齐 ui-message-feedback 的惯例）。 */
export type RqFeedbackProps = PropsRuntime<'conversation.chat.assistant-actions'>
  & InjectFace<RqFeedbackInjected>
  & PropsLocale<'rq-card'>

/** 组件实际消费的 ToolCallBlock 形态说明（运行时由框架传入 dsh 真实类型）。 */
export type ToolCallBlockView = ToolCallBlock
