/**
 * 登录回跳（next）统一消费面 —— 交接 F 清单 P 节（2026-09-11）。
 *
 * next 的解析 / 白名单 / 出口原本只存在于登录页（login.js finishLogin 出口）；控制台路由在
 * 已有会话时直接渲染外壳（app.js navigate），宿主已登录态打开「宿主/?next=<面板地址>」时
 * next 参数被静默丢弃——远程 dsh 面板向导的跨源扫码回跳死洞（钉钉扫码通道须先登出宿主才能走通）。
 *
 * 现把消费逻辑提升为共享模块，两个消费者同规则：
 *   - login.js（未登录态）：登录成功出口 finishLogin；
 *   - app.js（已登录态）：启动链 boot 静默授权——已有会话 + next 可解析 → 跨源签一次性自助
 *     entry_ticket（TTL ≤120s）带 #entry_ticket= 片段回跳 / 同源直接跳转。
 *
 * 本模块零裸 fetch（api 经参数注入，走查豁免面不变）；location/history/sessionStorage 可注入，
 * Node 可直接单测（next-redirect.test.mjs）。
 */
import { sanitizeNext, sanitizeCrossOriginNext } from './landing.js'

/** 同源深链暂存键（api.js 401 打断处写入，字面量与 api.js 同步）。 */
export const NEXT_SAME_KEY = 'heng_ops_next'
/** 跨源目的地暂存键（startDingOauth 整页跳钉钉授权前写入，SSO 回调脚本消费）。 */
export const NEXT_CROSS_KEY = 'heng_ops_next_cross'

/**
 * 一次读取并消费全部 next 来源：?next= 参数 + 两个 sessionStorage 暂存。
 * 返回 { sameOrigin, crossOrigin }（白名单外一律 ''：同源仅绝对路径，跨源仅回环/私网 http(s)）。
 * URL 清参后置到全部来源读完之后（L 节教训：双消费者共享一次读取，不得各读各的）。
 */
export function consumeNextSources({ location, history, sessionStorage } = {}) {
  const loc = location ?? globalThis.location
  const hist = history ?? globalThis.history
  const storage = sessionStorage ?? globalThis.sessionStorage
  const urlNext = new URLSearchParams(loc?.search ?? '').get('next') ?? ''
  const sameOrigin = sanitizeNext(urlNext) || sanitizeNext(readStorage(storage, NEXT_SAME_KEY))
  const crossOrigin = sanitizeCrossOriginNext(urlNext) || sanitizeCrossOriginNext(readStorage(storage, NEXT_CROSS_KEY))
  try { storage?.removeItem(NEXT_SAME_KEY) } catch { /* 忽略 */ }
  try { storage?.removeItem(NEXT_CROSS_KEY) } catch { /* 忽略 */ }
  if (urlNext) {
    try {
      const params = new URLSearchParams(loc.search)
      params.delete('next')
      const rest = params.toString()
      hist?.replaceState(null, '', loc.pathname + (rest ? `?${rest}` : '') + loc.hash)
    } catch { /* 忽略 */ }
  }
  return { sameOrigin, crossOrigin }
}

/**
 * 回跳出口（与登录页 finishLogin 同规则）。返回是否已出口（true=调用方停止后续渲染/跳转）：
 *   - 跨源：签一次性自助票（POST /api/auth/entry-tickets/self）以 #entry_ticket= 片段回跳；
 *     签票失败仍回跳——对端走「我已完成扫码」回导校验诚实降级，不阻断在宿主侧；
 *   - 同源：直接整页跳转。
 */
export async function exitWithNext({ sameOrigin, crossOrigin, api, location } = {}) {
  const loc = location ?? globalThis.location
  if (crossOrigin) {
    try {
      const issued = await api.post('/api/auth/entry-tickets/self', {})
      loc?.assign(`${crossOrigin}#entry_ticket=${encodeURIComponent(issued.ticket)}`)
    } catch {
      loc?.assign(crossOrigin)
    }
    return true
  }
  if (sameOrigin) {
    loc?.assign(sameOrigin)
    return true
  }
  return false
}

function readStorage(storage, key) {
  try { return storage?.getItem(key) ?? '' } catch { return '' }
}
