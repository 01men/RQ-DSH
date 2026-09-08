/**
 * 宿主连接状态的浏览器侧读取（M2/M3 注入面共用）。
 *
 * 走同源 REST（spike §4.3 数据回流二选一的同款选择）：/rq/rqcard/link 注册在
 * 榕器数据面（dsh-bridge /rq 挂载之下），须带向导头（服务端 CSRF 防线）。
 * 端点不存在（独立形态/宿主半未装）返回 null——注入面按「未知」降级。
 */
import { LINK_ENDPOINT, RQCARD_CALL_HEADER } from '../wire.ts'

/** 浏览器可见的宿主连接视图（服务端 HostLinkConfig + 探测摘要的子集）。 */
export interface HostLinkView {
  mode: 'none' | 'local' | 'remote'
  hubBase?: string | null
  hubMountPrefix?: string | null
  probe?: { reachable: boolean; status?: number; version?: string } | null
  localFirstRun?: boolean
}

/** 读取宿主连接状态；任何失败折叠为 null（调用方按未知降级，绝不抛错炸宿主）。 */
export async function fetchHostLink(): Promise<HostLinkView | null> {
  try {
    const response = await fetch(LINK_ENDPOINT, { headers: { [RQCARD_CALL_HEADER]: '1' } })
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.ok !== true) return null
    return (payload?.data ?? null) as HostLinkView | null
  } catch {
    return null
  }
}
