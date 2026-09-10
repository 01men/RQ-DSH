/**
 * 自持组件通道（plan-gate01 Phase 4.2）：面板自带 ui.js（modal/drawer/toast/表单）与
 * realtime.js（SSE 优先 + 30s 轮询降级，钉钉 webview 铁律）副本（自 console 侧拷贝，见文件头），
 * 按 BASE 动态装载——纯前台形态（01门 装态）无 console 可借用，两形态同一路径自持。
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

/** 面板自持 ui.js：toast/openModal/openDrawer/confirmDialog 等（0 依赖拷贝引用）。 */
export function ui() {
  return load('/panel/js/ui.js')
}

/** 面板自持 realtime.js：createEventStream({url, pollPath, ...})。 */
export function realtime() {
  return load('/panel/js/realtime.js')
}
