/**
 * 设置页「榕器宿主」分区（M2）：连接状态丸 + 打开向导/工作台入口。
 *
 * 形态对齐 ui-auth 的 AccountSection（settings.section list 条目）：
 * 状态读取走同源 /rq/rqcard/link（hostStatus.ts），动作是打开
 * /rq/panel/（未连接且未登录时面板首屏即连接向导——向导与面板同一入口，
 * 避免在注入面重复实现一份表单）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only：拉入 settings 壳的 SlotMap merge（settings.section 条目形态）。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { fetchHostLink, type HostLinkView } from './hostStatus.ts'
import { PANEL_URL } from '../wire.ts'

/** 注入面：打开面板（向导）/刷新状态的动作。 */
export interface RqSettingsInjected {
  open: (url: string) => void
  refresh: () => Promise<HostLinkView | null>
}

/** 分区完整 props（list 条目标准组合）。 */
export type RqSettingsProps = PropsRuntime<'settings.section'>
  & InjectFace<RqSettingsInjected>
  & PropsLocale<'rq-card'>

/** 设置分区组件。 */
export function RqSettings({ open, refresh, t }: RqSettingsProps) {
  const [link, setLink] = useState<HostLinkView | null | undefined>(undefined)

  const reload = useCallback(async () => {
    setLink(await refresh())
  }, [refresh])

  useEffect(() => { void reload() }, [reload])

  const mode = link?.mode
  const modeText = mode === 'remote' ? t('settings.mode.remote')
    : mode === 'local' ? t('settings.mode.local')
      : mode === 'none' ? t('settings.mode.none') : '…'
  const probeText = link?.mode === 'remote'
    ? (link.probe?.reachable === true ? t('settings.probe.ok') : t('settings.probe.fail'))
    : null

  return <div className="rq-set">
    <div className="rq-set-row">
      <span className={`rq-set-mode rq-set-mode-${mode ?? 'unknown'}`}>{modeText}</span>
      {link?.mode === 'remote' && link.hubBase
        ? <span className="rq-set-hub">{String(link.hubBase)}{probeText ? ` · ${probeText}` : ''}</span>
        : null}
      <button type="button" className="rq-set-btn" onClick={() => void reload()}>{t('settings.refresh')}</button>
    </div>
    <p className="rq-set-hint">{t('settings.hint')}</p>
    <div className="rq-set-row">
      {mode === 'none'
        ? <button type="button" className="rq-set-btn rq-set-primary" onClick={() => open(PANEL_URL)}>{t('settings.open.wizard')}</button>
        : <button type="button" className="rq-set-btn rq-set-primary" onClick={() => open(PANEL_URL)}>{t('settings.open.panel')}</button>}
    </div>
  </div>
}
