/**
 * 会话视图 Tab「01门工作台」（M3 对话打通）：整页内嵌 /gate01/panel/（同源 iframe）。
 *
 * 嵌套防护：面板侧带 ?embed=1 打开——panel boot 链检测 embed/被嵌套时，其自身的
 * 「Agent 对话」回落内置聊天并隐藏再次内嵌 dsh 的入口（防 iframe 递归）。
 * iframe 加载失败（数据面未挂载等）时顶栏保留「在浏览器打开」外链兜底。
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PANEL_EMBED_URL } from '../wire.ts'

/** 视图完整 props（list 条目标准组合；本视图是纯容器，不消费注入面）。 */
export type RqWorkbenchProps = PropsRuntime<'conversation.view'>
  & PropsLocale<'rq-card'>

/** 工作台视图组件。 */
export function RqWorkbench({ t }: RqWorkbenchProps) {
  return <div className="rq-wb">
    <div className="rq-wb-bar">
      <span className="rq-wb-title">🌳 {t('view.workbench')}</span>
      <a className="rq-wb-link" href={PANEL_EMBED_URL.replace('?embed=1', '')} target="_blank" rel="noreferrer">
        {t('view.open.external')} ↗
      </a>
    </div>
    <iframe
      className="rq-wb-frame"
      src={PANEL_EMBED_URL}
      title={t('view.workbench')}
      referrerPolicy="same-origin"
    />
  </div>
}
