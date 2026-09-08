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
const PLUGIN_ID = '@dsh-ops/plugin-rq-card'

/** 样式表文本（全部类名以 rq- 前缀隔离，避免与宿主/其他插件冲突）。 */
const SHEET = `
.rq-ecard{border:1px solid var(--rq-ecard-edge,#e2e6ee);border-radius:10px;padding:8px 12px;
  margin:4px 0;font-size:13px;line-height:1.5;background:var(--rq-ecard-bg,#fff);max-width:640px}
.rq-ecard-head{display:flex;align-items:center;gap:8px;font-weight:600}
.rq-ecard-chip{font-weight:400;font-size:11px;padding:1px 8px;border-radius:999px;
  background:#eef1f6;color:#5b6472}
.rq-ecard[data-state="calling"] .rq-ecard-chip{background:#e8f1fd;color:#2563c4}
.rq-ecard[data-state="executing"] .rq-ecard-chip{background:#e6f5ee;color:#177a4c}
.rq-ecard[data-state="done"] .rq-ecard-chip{background:#e6f5ee;color:#177a4c}
.rq-ecard[data-state="blocked"]{border-color:#e5484d;box-shadow:inset 3px 0 0 #e5484d}
.rq-ecard[data-state="blocked"] .rq-ecard-chip{background:#fdebec;color:#c62a2f}
.rq-ecard-skel{margin-top:8px}
.rq-ecard-skel-line{height:10px;border-radius:5px;background:#eef1f6;margin:6px 0;
  animation:rq-pulse 1.4s ease-in-out infinite}
.rq-ecard-skel-line:nth-child(2){width:70%}
.rq-ecard-skel-line:nth-child(3){width:45%}
.rq-ecard-pulse{margin-top:8px;height:6px;border-radius:3px;overflow:hidden;background:#eef1f6}
.rq-ecard-pulse::before{content:"";display:block;height:100%;width:38%;border-radius:3px;
  background:#2563c4;opacity:.55;animation:rq-sweep 1.6s ease-in-out infinite}
.rq-ecard-degraded{margin-top:6px;font-size:12px;color:#9a6700}
.rq-ecard-args{margin-top:8px;color:#5b6472;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
  font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:72px;overflow:hidden}
.rq-ecard-result{margin-top:8px;white-space:pre-wrap;word-break:break-word;color:#252b35}
.rq-ecard-foot{margin-top:8px;display:flex;align-items:center;gap:10px}
.rq-ecard-link{color:#2563c4;text-decoration:none;font-size:12px}
.rq-ecard-link:hover{text-decoration:underline}
.rq-ecard-action{display:inline-block;padding:3px 12px;border-radius:6px;border:1px solid #e5484d;
  color:#c62a2f;background:#fff;font-size:12px;text-decoration:none;cursor:pointer}
.rq-ecard-action:hover{background:#fdebec}
.rq-ecard-cancel{margin-left:auto;padding:2px 10px;border-radius:6px;border:1px solid #c9cfda;
  background:#fff;color:#5b6472;font-size:12px;cursor:not-allowed}
.rq-ecard-reason{margin-top:6px;color:#c62a2f}
@keyframes rq-pulse{0%,100%{opacity:.55}50%{opacity:1}}
@keyframes rq-sweep{0%{transform:translateX(-100%)}100%{transform:translateX(280%)}}

.rq-fb{display:inline-flex;align-items:center;gap:4px;margin-left:8px}
.rq-fb-btn{border:none;background:transparent;cursor:pointer;font-size:13px;line-height:1;
  padding:3px 6px;border-radius:6px;opacity:.55}
.rq-fb-btn:hover{background:#eef1f6;opacity:1}
.rq-fb-btn[data-active="true"]{opacity:1;background:#e8f1fd}
.rq-fb-done{font-size:11px;color:#8a92a0}

.rq-badge{position:fixed;right:12px;bottom:12px;z-index:2147483000;padding:4px 10px;border-radius:999px;
  background:#5b6472;color:#fff;font-size:11px;opacity:.75;pointer-events:none}

.rq-set{display:flex;flex-direction:column;gap:8px;font-size:13px}
.rq-set-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.rq-set-mode{font-size:12px;padding:2px 10px;border-radius:999px;background:#eef1f6;color:#5b6472}
.rq-set-mode-local{background:#e6f5ee;color:#177a4c}
.rq-set-mode-remote{background:#e8f1fd;color:#2563c4}
.rq-set-mode-none{background:#fdebec;color:#c62a2f}
.rq-set-hub{color:#5b6472;font-size:12px}
.rq-set-btn{padding:5px 14px;border-radius:8px;border:1px solid #c9cfda;background:#fff;
  color:#252b35;font-size:12px;cursor:pointer}
.rq-set-btn:hover{background:#f3f5f9}
.rq-set-primary{border-color:#2563c4;color:#2563c4}
.rq-set-hint{color:#8a92a0;font-size:12px;line-height:1.6;margin:0}

.rq-wb{display:flex;flex-direction:column;height:100%;min-height:0;background:#fff}
.rq-wb-bar{display:flex;align-items:center;justify-content:space-between;padding:6px 12px;
  border-bottom:1px solid #eef1f6;font-size:12px;color:#5b6472}
.rq-wb-title{font-weight:600}
.rq-wb-link{color:#2563c4;text-decoration:none}
.rq-wb-link:hover{text-decoration:underline}
.rq-wb-frame{flex:1;min-height:0;width:100%;border:none;background:#f3f4f6}

.rq-unlinked{position:fixed;right:12px;bottom:12px;z-index:2147483000;padding:5px 12px;border-radius:999px;
  background:#c62a2f;color:#fff;font-size:11px;cursor:pointer;border:none;box-shadow:0 4px 12px rgba(198,42,47,.3)}
.rq-unlinked:hover{filter:brightness(.94)}
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
