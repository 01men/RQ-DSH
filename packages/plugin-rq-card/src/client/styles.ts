/**
 * 卡片/反馈条样式：一次注入一段 <style data-plugin>（与 dsh tsdown.client.ts
 * 预设对 CSS Modules 的处理同构——工厂执行时注入、loader 卸载时按 data-plugin
 * 回收；spike §3.1「CSS」行）。
 *
 * 【为什么不用 x.module.css】dsh 预设经 lightningcss 编译 module.css，而本仓
 * 不带 lightningcss 依赖、build.mjs 的等价 esbuild 路径也刻意不引入它——
 * 手写类名 + 运行时注入是把构建面收敛到「零额外工具链」的降级友好选择。
 */

/** 插件 id（style 标签的 data-plugin 值，loader 卸载凭它回收）。 */
const PLUGIN_ID = '@ybkk/plugin-rq-card'

/**
 * 样式表文本（全部类名以 rq- 前缀隔离，避免与宿主/其他插件冲突）。
 *
 * 【视觉基线】「轻科技工业」设计语言（2026-09 UI 重构，与 plugin-panel-core
 * public/css/panel.css :root 令牌同源）：浅色面板 + 钢灰描边 #dde3ea、
 * 主色工业青 #0e7490（deep #155e75）、错误红 #dc2626（文字 #b91c1c）、
 * 硬边小圆角、短锐阴影、等宽参数块（终端质感）、状态芯片带 LED 点
 * （颜色+形状双编码）、按钮按压下沉、动效 ≤160ms 直线曲线。
 * 本表自包含（宿主页面读不到面板令牌），色值与面板令牌人工对齐。
 */
const SHEET = `
.rq-ecard{border:1px solid var(--rq-ecard-edge,#dde3ea);border-radius:10px;padding:9px 12px;
  margin:4px 0;font-size:13px;line-height:1.55;background:var(--rq-ecard-bg,#fff);max-width:640px;
  box-shadow:0 1px 2px rgba(27,39,51,.06)}
.rq-ecard-head{display:flex;align-items:center;gap:8px;font-weight:600;color:#1b2733}
.rq-ecard-chip{font-weight:500;font-size:11px;padding:2px 9px;border-radius:999px;
  background:#eef2f6;color:#5b6a79;display:inline-flex;align-items:center;gap:5px}
.rq-ecard-chip::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;
  opacity:.85;flex-shrink:0}
.rq-ecard[data-state="calling"] .rq-ecard-chip{background:#d9eef5;color:#0e7490}
.rq-ecard[data-state="executing"] .rq-ecard-chip{background:#ddf2e7;color:#0b7a43}
.rq-ecard[data-state="done"] .rq-ecard-chip{background:#ddf2e7;color:#0b7a43}
.rq-ecard[data-state="blocked"]{border-color:#f0b6b6;box-shadow:inset 4px 0 0 #dc2626}
.rq-ecard[data-state="blocked"] .rq-ecard-chip{background:#fdeaea;color:#b91c1c}
.rq-ecard-skel{margin-top:8px}
.rq-ecard-skel-line{height:10px;border-radius:5px;background:#edf1f5;margin:6px 0;
  animation:rq-pulse 1.4s ease-in-out infinite}
.rq-ecard-skel-line:nth-child(2){width:70%}
.rq-ecard-skel-line:nth-child(3){width:45%}
.rq-ecard-pulse{margin-top:8px;height:6px;border-radius:3px;overflow:hidden;background:#edf1f5}
.rq-ecard-pulse::before{content:"";display:block;height:100%;width:38%;border-radius:3px;
  background:#0e7490;opacity:.6;animation:rq-sweep 1.6s ease-in-out infinite}
.rq-ecard-degraded{margin-top:6px;font-size:12px;color:#9a6700}
.rq-ecard-args{margin-top:8px;color:#5b6a79;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
  font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:72px;overflow:hidden;
  background:#f6f8fa;border:1px solid #e8edf2;border-radius:6px;padding:6px 8px}
.rq-ecard-result{margin-top:8px;white-space:pre-wrap;word-break:break-word;color:#22303f}
.rq-ecard-foot{margin-top:8px;display:flex;align-items:center;gap:10px}
.rq-ecard-link{color:#0e7490;text-decoration:none;font-size:12px;font-weight:500}
.rq-ecard-link:hover{text-decoration:underline;color:#155e75}
.rq-ecard-action{display:inline-block;padding:6px 14px;border-radius:8px;border:1px solid #dc2626;
  color:#b91c1c;background:#fff;font-size:12px;font-weight:500;text-decoration:none;cursor:pointer;
  transition:background-color .14s ease-out}
.rq-ecard-action:hover{background:#fdeaea}
.rq-ecard-action:active{transform:translateY(1px)}
.rq-ecard-cancel{margin-left:auto;padding:4px 12px;border-radius:8px;border:1px solid #c5cfd9;
  background:#fff;color:#5b6a79;font-size:12px;cursor:not-allowed}
.rq-ecard-reason{margin-top:6px;color:#b91c1c;font-weight:500}
@keyframes rq-pulse{0%,100%{opacity:.55}50%{opacity:1}}
@keyframes rq-sweep{0%{transform:translateX(-100%)}100%{transform:translateX(280%)}}

.rq-fb{display:inline-flex;align-items:center;gap:4px;margin-left:8px}
.rq-fb-btn{border:none;background:transparent;cursor:pointer;font-size:14px;line-height:1;
  padding:4px 8px;border-radius:6px;opacity:.5;transition:background-color .14s ease-out,opacity .14s ease-out}
.rq-fb-btn:hover{background:#edf1f5;opacity:1}
.rq-fb-btn:active{transform:translateY(1px)}
.rq-fb-btn[data-active="true"]{opacity:1;background:#d9eef5}
.rq-fb-done{font-size:11px;color:#8a97a5}

.rq-badge{position:fixed;right:12px;bottom:12px;z-index:2147483000;padding:4px 10px;border-radius:999px;
  background:#46586a;color:#fff;font-size:11px;opacity:.78;pointer-events:none}

.rq-set{display:flex;flex-direction:column;gap:8px;font-size:13px}
.rq-set-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.rq-set-mode{font-size:12px;padding:2px 10px;border-radius:999px;background:#eef2f6;color:#5b6a79;
  display:inline-flex;align-items:center;gap:5px}
.rq-set-mode::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.85}
.rq-set-mode-local{background:#ddf2e7;color:#0b7a43}
.rq-set-mode-remote{background:#d9eef5;color:#0e7490}
.rq-set-mode-none{background:#fdeaea;color:#b91c1c}
.rq-set-hub{color:#5b6a79;font-size:12px}
.rq-set-btn{padding:6px 14px;min-height:34px;border-radius:8px;border:1px solid #c5cfd9;background:#fff;
  color:#22303f;font-size:12px;cursor:pointer;transition:background-color .14s ease-out}
.rq-set-btn:hover{background:#f3f6f9}
.rq-set-btn:active{transform:translateY(1px)}
.rq-set-primary{border-color:#0e7490;color:#0e7490;font-weight:500}
.rq-set-primary:hover{background:#d9eef5}
.rq-set-hint{color:#8a97a5;font-size:12px;line-height:1.6;margin:0}

.rq-wb{display:flex;flex-direction:column;height:100%;min-height:0;background:#fff}
.rq-wb-bar{display:flex;align-items:center;justify-content:space-between;padding:7px 12px;
  border-bottom:1px solid #e6ebf1;font-size:12px;color:#5b6a79;background:#f7f9fb}
.rq-wb-title{font-weight:600;color:#1b2733}
.rq-wb-link{color:#0e7490;text-decoration:none;font-weight:500}
.rq-wb-link:hover{text-decoration:underline;color:#155e75}
.rq-wb-frame{flex:1;min-height:0;width:100%;border:none;background:#eef1f5}

.rq-unlinked{position:fixed;right:12px;bottom:12px;z-index:2147483000;padding:6px 14px;border-radius:999px;
  background:#b91c1c;color:#fff;font-size:12px;cursor:pointer;border:none;
  box-shadow:0 3px 10px rgba(185,28,28,.3);transition:filter .14s ease-out}
.rq-unlinked:hover{filter:brightness(1.08)}
.rq-unlinked:active{transform:translateY(1px)}

.rq-ecard-action:focus-visible,.rq-ecard-link:focus-visible,.rq-fb-btn:focus-visible,
.rq-set-btn:focus-visible,.rq-wb-link:focus-visible,.rq-unlinked:focus-visible{
  outline:2px solid #0e7490;outline-offset:2px}
`

/** 已注入标记（幂等：重复调用不重复插入）。 */
let injected = false

/**
 * 幂等注入插件样式表（apply 早期调用一次即可；SSR/无 document 环境安全跳过）。
 */
export function ensureStyles(): void {
  if (injected || typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin="${PLUGIN_ID}"]`) !== null) {
    injected = true
    return
  }
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.textContent = SHEET
  document.head.appendChild(tag)
  injected = true
}
