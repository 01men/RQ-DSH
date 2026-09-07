/**
 * @dsh-ops/plugin-rq-card —— dsh 会话侧注入插件，宿主半（WP-06）。
 *
 * 纯 UI 表面插件：宿主半不做任何行为注册（模式照抄 dsh ui-message-feedback
 * 的宿主半——空 apply 只为让插件出现在宿主 loader 图里）；浏览器半经
 * exports['./client']（lib/client.js）与 package.json 的 dsh.client 声明下发，
 * 由 client-modules 伺服于 /plugins/@dsh-ops/plugin-rq-card/client.js 并入
 * cordis 启动图（spike §2.1 证据 A1/A3）。
 *
 * 【构建门禁（spike §4.4，硬约束）】激活期缺 bundle 会响亮抛错
 * （MissingClientBundleError → ClientPackageCompositionError → 宿主启动失败）。
 * 因此 `dsh web` 启动前必须先执行：
 *
 *     node packages/plugin-rq-card/build.mjs     # 产出 lib/client.js
 *
 * cordis.yml / cordis.patch.yml 的 loader 条目 name 必须是包名
 * '@dsh-ops/plugin-rq-card'（client-modules 用 require.resolve 解析包元数据，
 * 源码文件路径会被负判为「非 client 包」且永久缓存，spike §4.2）。
 *
 * 【markdown 兜底契约（spike §5 降级预案第 5 条，宿主工具侧义务）】
 * 榕器工具的 tool/result 文本内容必须始终携带纯 markdown 摘要 + /rq 控制台链接：
 * 客户端富卡片只是把同一信息「升级」呈现；上游升级导致注入面失效时，用户
 * 体验自动回落为该文本，无需发版。summarizeForToolResult() 是该契约的参考
 * 实现，供工具侧（platform-core / plugin-mcp 等）在组织工具结果时复用——
 * 建议把摘要文本放在结果首块，富卡片与纯文本两个世界读同一份信息。
 */

import { CONSOLE_BASE } from './wire.ts'

/** summarizeForToolResult 的输入。 */
export interface ToolResultSummaryInput {
  /** 工具名（如 mcp_invoke），首行加粗呈现。 */
  toolName: string
  /** 一句话业务摘要（用户最关心的那件事）。 */
  summary: string
  /** /rq 控制台对应资源页 hash 路由（如 #/mcp）；缺省不生成链接。 */
  consoleHash?: string
  /** 关键明细（键值对，逐行渲染；保持精炼，摘要不是日志）。 */
  details?: Readonly<Record<string, string | number>>
  /** 是否异常结果：异常时首行加「⚠」前缀，提示用户进控制台处理。 */
  isError?: boolean
}

/**
 * 组装工具结果的 markdown 兜底摘要（宿主工具侧契约的参考实现）。
 *
 * 形态示例：
 *
 *   **mcp_invoke** ⚠ 执行受阻 —— 无访问权限
 *   - 服务：inventory（online）
 *   - 原因：nas-authz deny
 *   👉 [到榕器控制台处理](/rq#/nas-authz)
 *
 * 返回值直接作为 tool/result 文本内容的一部分（不依赖任何客户端插件）。
 */
export function summarizeForToolResult(input: ToolResultSummaryInput): string {
  const lines: string[] = []
  const flag = input.isError ? '⚠ ' : ''
  lines.push(`**${input.toolName}** ${flag}${input.summary}`)
  for (const [key, value] of Object.entries(input.details ?? {})) {
    lines.push(`- ${key}：${String(value)}`)
  }
  if (input.consoleHash !== undefined) {
    lines.push(`👉 [到榕器控制台处理](${CONSOLE_BASE}${input.consoleHash})`)
  }
  return lines.join('\n')
}

/** 宿主插件体 —— 本表面插件无宿主侧行为（浏览器半承担全部注入）。 */
export function apply(): void {}
