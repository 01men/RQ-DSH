/**
 * 共享组件复用通道（review F-清单「可直接复用」项）：console 的 ui.js（modal/drawer/toast/表单）
 * 与 realtime.js（SSE 优先 + 30s 轮询降级，钉钉 webview 铁律）按 BASE 动态装载——
 * console 在两种部署形态都挂在 <BASE>/ 下，面板不复制代码，只做同源 ESM 引用。
 */
const cache = {}

async function load(path) {
  cache[path] ??= await import(/* @vite-ignore */ `${BASE}${path}`)
  return cache[path]
}

export let BASE = ''

export function setBase(value) {
  BASE = value
}

/** console ui.js：toast/openModal/openDrawer/confirmDialog 等（0 依赖拷贝引用）。 */
export function ui() {
  return load('/js/ui.js')
}

/** console realtime.js：createEventStream({url, pollPath, ...})。 */
export function realtime() {
  return load('/js/realtime.js')
}
