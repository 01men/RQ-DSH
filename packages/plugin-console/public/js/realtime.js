/**
 * 实时通道（WP-11）：SSE 优先、失败自动降级轮询（不恢复 WS）。
 *
 * 钉钉微应用 H5 场景（docs/dingtalk-webview-report.md）：钉钉 webview 对长连接
 * （SSE/WS）支持不稳，因此一律 SSE 优先，10s 内未 open 或中途 error 即降级为
 * 30s 轮询，降级一次性回调 onDowngrade(reason)，之后不再尝试恢复 SSE/WS。
 *
 * 零依赖：本文件不 import 任何模块；fetch / EventSource 由调用方传入或从
 * globalThis 取（钉钉 webview 与 Node 测试环境通吃，便于脚本直测）。
 */

/**
 * 纯函数：给定 SSE 状态决定传输方式（'sse' | 'polling'）。
 * - 环境不支持 EventSource → 轮询；
 * - SSE 已出错 → 轮询；
 * - SSE 已成功 open → 保持 SSE；
 * - 其余（超时仍未 open）→ 轮询。
 */
export function decideTransport({ sseOpened, sseError, supportsEventSource }) {
  if (!supportsEventSource) return 'polling'
  if (sseError) return 'polling'
  return sseOpened ? 'sse' : 'polling'
}

/**
 * 建立事件流：优先 EventSource(url)，失败自动降级为轮询 pollPath。
 *
 * @param {object} options
 * @param {string} options.url              SSE 端点
 * @param {string} options.pollPath         降级轮询端点（fetch GET）
 * @param {number} [options.pollIntervalMs=30000] 轮询间隔
 * @param {number} [options.openTimeoutMs=10000]  SSE open 超时（超时未 open 即降级）
 * @param {(data: unknown) => void} [options.onMessage] 收到消息（SSE data 或轮询响应体，尽量 JSON.parse）
 * @param {(reason: string) => void} [options.onDowngrade] 降级回调（恰好一次）
 * @param {object} [options.headers]        轮询请求头（如鉴权 authorization）
 * @param {typeof fetch} [options.fetchImpl] 轮询用 fetch（缺省取 globalThis.fetch）
 * @param {typeof EventSource} [options.EventSourceImpl] SSE 实现（缺省取 globalThis.EventSource）
 * @returns {{ close: () => void }}
 */
export function createEventStream(options) {
  const {
    url,
    pollPath,
    pollIntervalMs = 30000,
    openTimeoutMs = 10000,
    onMessage,
    onDowngrade,
    headers,
    fetchImpl = globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined,
    EventSourceImpl = globalThis.EventSource,
  } = options ?? {}

  let closed = false
  let downgraded = false
  let es = null
  let openTimer = null
  let pollTimer = null
  let pollInFlight = false // 仅一次在途：上一轮未完成不发起下一轮

  const emitMessage = (data) => {
    if (closed || typeof onMessage !== 'function') return
    try { onMessage(data) } catch { /* 消费方异常不中断通道 */ }
  }

  /** 尽量解析为 JSON，失败原样返回文本（SSE data 与轮询响应体共用）。 */
  const parseMaybeJson = (text) => {
    try { return JSON.parse(text) } catch { return text }
  }

  const schedulePoll = (delay) => {
    if (closed) return
    pollTimer = setTimeout(runPoll, delay)
  }

  const runPoll = async () => {
    if (closed || pollInFlight || !fetchImpl) return
    pollInFlight = true
    try {
      const res = await fetchImpl(pollPath, { headers })
      const text = await res.text()
      if (!closed) emitMessage(parseMaybeJson(text))
    } catch { /* 单轮失败静默，下一轮再试 */ } finally {
      pollInFlight = false
      schedulePoll(pollIntervalMs)
    }
  }

  /** 降级：恰好一次；关停 SSE 与 open 超时器后立刻发起首轮轮询。 */
  const downgrade = (reason) => {
    if (downgraded || closed) return
    downgraded = true
    if (es) { try { es.close() } catch { /* 忽略 */ } es = null }
    if (openTimer) { clearTimeout(openTimer); openTimer = null }
    if (typeof onDowngrade === 'function') {
      try { onDowngrade(reason) } catch { /* 忽略 */ }
    }
    runPoll()
  }

  // 环境无 EventSource：直接降级（如 Node 测试环境 / 极旧 webview）
  if (!EventSourceImpl) {
    downgrade('unsupported')
    return { close: () => { closed = true; if (pollTimer) clearTimeout(pollTimer) } }
  }

  // SSE 优先：open 超时兜底 + error 即降级（不依赖 EventSource 的自动重连）
  try {
    es = new EventSourceImpl(url)
  } catch {
    downgrade('sse-init-failed')
    return { close: () => { closed = true; if (pollTimer) clearTimeout(pollTimer) } }
  }
  es.onopen = () => {
    if (openTimer) { clearTimeout(openTimer); openTimer = null }
  }
  es.onmessage = (event) => {
    emitMessage(parseMaybeJson(event.data))
  }
  es.onerror = () => {
    downgrade('sse-error')
  }
  openTimer = setTimeout(() => downgrade('open-timeout'), openTimeoutMs)

  return {
    close() {
      closed = true
      if (es) { try { es.close() } catch { /* 忽略 */ } es = null }
      if (openTimer) { clearTimeout(openTimer); openTimer = null }
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
    },
  }
}
