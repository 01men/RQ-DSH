/**
 * 面板种子（review-dsh-agent-panel-v2 Phase 1 第 5-10 条）：
 * - 基线（首次启动，panel:deptConfigs 为空时）：五部门骨架配置（一套骨架五种皮肤的数据底座，
 *   DEPT_META 来自设计原型剥离）+ 内置行业激活（QB01/GCJX 图谱包随平台分发 → 默认授权根组织）。
 * - 演示（DEMO_SEED=1）：追加五部门 KPI/widget（来源徽标 mock/手工）/频道/样例会话/任务/部门知识——
 *   全部来自 demo-content.json（原型 APPLIANCE 数据，scripts/extract-panel-seed.mjs 确定性剥离）。
 * 演示会话中的 Agent 卡片不预绑 agentRef（面板阵容的 agentRef 由管理员经 PUT /api/panel/:dept/agents
 * 绑定到真实 Agent 资产——运行时未绑定则诚实降级转人工，不造假回复）。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { newId } from '../../../platform-core/src/ids.ts'
import type { DeptAgent, DeptKpi, DeptWidget, MessageCardOp } from '../service.ts'

/** 五部门骨架（原型 DEPT_META 一比一：主题色即部门身份）。 */
const DEPT_META: Array<Pick<import('../service.ts').DeptConfigRecord, 'id' | 'label' | 'icon' | 'theme' | 'collab' | 'acts' | 'colors'>> = [
  { id: 'rd', label: '研发部', icon: '🔬', theme: '深空蓝 · 项目工程风', collab: '任务驱动 · 评审协同', acts: ['rd'], colors: { accent: '#4f46e5', soft: '#e0e7ff', deep: '#3730a3' } },
  { id: 'mfg', label: '制造部', icon: '🏭', theme: '工业青 · 产线实时风', collab: '异常驱动 · 工单闭环', acts: ['mfg', 'scm'], colors: { accent: '#0f766e', soft: '#ccfbf1', deep: '#115e59' } },
  { id: 'sales', label: '销售部', icon: '💼', theme: '暖阳橙 · 赢单作战风', collab: '客户驱动 · 服务一体', acts: ['svc', 'mkt'], colors: { accent: '#ea580c', soft: '#ffedd5', deep: '#9a3412' } },
  { id: 'strategy', label: '战略部', icon: '🧭', theme: '深紫 · 洞察研判风', collab: '情报驱动 · 研判共创', acts: ['mgmt'], colors: { accent: '#7c3aed', soft: '#ede9fe', deep: '#5b21b6' } },
  { id: 'fin', label: '财务部', icon: '💳', theme: '墨绿金 · 严谨合规风', collab: '流程驱动 · 审批留痕', acts: ['fin'], colors: { accent: '#047857', soft: '#d1fae5', deep: '#064e3b' } },
]

/** 卡片按钮 → 平台链动作映射（演示卡片按语义落纯平台链；推送钉钉类走 dd.push）。 */
function mapOps(labels: string[]): MessageCardOp[] {
  return labels.map((label, index) => {
    const style: MessageCardOp['style'] = label.includes('钉钉') ? 'dd' : 'primary'
    let action: MessageCardOp['action'] = 'ack'
    if (/生成任务卡|确认派单|确认返修|拉评审会|生成申报方案|生成专项报告|查看进度|发起调整流程|生成诊断/.test(label)) action = 'task.create'
    else if (/提交审批|推送钉钉卡片审批|推送客户钉钉|推送钉钉给/.test(label)) action = 'approval.request'
    else if (/推送钉钉卡片$/.test(label)) action = 'dd.push'
    return { id: `op${index + 1}`, label, style, action, ...(action === 'approval.request' ? { risk: 'high' as const } : {}) }
  })
}

/** 演示组织主键（01门 装态无组织目录时的激活/计量归属，与 index.ts orgIdOf 兜底同值）。 */
export const DEMO_ORG_ID = 'demo-org'

export function seedPanel(ctx: Context, autoDemo = false): void {
  const logger = ctx.logger('panel-seed')
  // 幂等双入口：首启（集合空）播基线+演示；demoAuth 装态下 loader 热重载会以空 config
  // 重放 apply——先播了基线骨架、后到的 autoDemo 需要能补齐演示内容（真机 gate01-npm 实证）
  if (ctx.panel.deptConfigs().count() > 0) {
    if (autoDemo) seedDemoContent(ctx, logger)
    return
  }

  // -- 基线：五部门骨架 + 内置行业激活 + 组织名自动绑定（账号组织打通） ------------
  // 组织目录缺席（01门演示态）→ 部门不绑组织（范围权限全开放）+ 跳过内置激活登记，
  // 骨架与演示内容照常播种（plan-gate01 决策 2：未连接宿主时内置演示看板）
  const iam = ctx.reflect.get('iam', false) as any | undefined
  for (const meta of DEPT_META) {
    // 组织名与部门名一致时自动绑定（真实部署按企业组织树命名即可零配置打通）；
    // 不一致时由管理员经 PUT /api/panel/:dept/config 手工绑定
    const matchedOrg = iam?.orgs().findOne((org: { name: string }) => org.name === meta.label)
    ctx.panel.deptConfigs().insert({ id: meta.id, ...meta, agents: [], kpis: [], widgets: [], ...(matchedOrg ? { orgId: matchedOrg.id } : {}) })
  }
  // 内置图谱资产（packages/platform-core/scenegraphs/ 随平台分发）默认授权根组织；
  // 其余组织/行业走「申请 → 审批（industry.activation，high）→ 激活」链路
  const rootOrg = iam?.orgs().find((org: { parentId: string | null }) => org.parentId === null).at(0) ?? (autoDemo ? { id: DEMO_ORG_ID } : undefined)
  if (rootOrg) seedActivations(ctx, rootOrg.id)
  logger.info('面板基线：五部门骨架 + 内置行业激活（QB01/YB01/JB01）完成')

  // 演示内容门控：DEMO_SEED=1（全量形态显式演示）或 autoDemo（01门 demoAuth 装态自动演示）
  if (process.env.DEMO_SEED !== '1' && !autoDemo) return
  seedDemoContent(ctx, logger)
}

/**
 * 演示内容幂等补齐（plan-gate01 决策 2）：对「仍是空骨架」的部门补播 KPI/Agent 阵容/widget/
 * 频道/会话/任务/知识。以「部门是否已有频道」为该部门演示内容已播标记（频道不空即跳过该
 * 部门全量演示），agents/kpis/widgets 单独按空判——重复 apply / 热重载 / 部分失败重放全部安全。
 */
/** 内置行业激活幂等登记（QB01 家电 / YB01 钢铁 / JB01 工程机械 默认授权；其余 11 行业走申请审批）：
 *  demoAuth 装态下 demo-org 兜底，重放安全。 */
function seedActivations(ctx: Context, orgId: string): void {
  for (const code of ['QB01', 'YB01', 'JB01']) {
    if (ctx.panel.activations().findOne((item) => item.orgId === orgId && item.code === code)) continue
    ctx.panel.activations().insert({
      id: newId('act'), code, orgId, status: 'active',
      activatedAt: new Date().toISOString(), activatedBy: 'seed（内置资产包默认授权）',
    })
  }
}

function seedDemoContent(ctx: Context, logger: { info(msg: string): void; warn(msg: string): void }): void {
  type DemoMsg = { t: string; n?: string; icon?: string; x: string; dd?: boolean | string; card?: { t: string; ops: string[] } }
  type DemoDept = {
    kpis: Array<[string, string]>
    agents: Array<{ n: string; d: string; icon: string; busy?: boolean }>
    chans: Array<[string, number, boolean]>
    widgets: Array<{ t: string; title: string; live?: boolean; rows: unknown[][] }>
    msgs: DemoMsg[]
  }
  const demoPath = join(dirname(fileURLToPath(import.meta.url)), 'demo-content.json')
  const demo = JSON.parse(readFileSync(demoPath, 'utf8')) as { depts: Record<string, DemoDept> }

  // 行业激活面幂等补齐（「有骨架无激活」中间态——如宿主强杀丢失部分持久层——也能恢复）
  const iam = ctx.reflect.get('iam', false) as any | undefined
  const demoOrgId = iam?.orgs().find((org: { parentId: string | null }) => org.parentId === null).at(0)?.id ?? DEMO_ORG_ID
  seedActivations(ctx, demoOrgId)

  for (const [deptId, content] of Object.entries(demo.depts)) {
    const config = ctx.panel.deptConfigs().get(deptId)
    if (!config) continue
    // 幂等标记：该部门已有频道 = 演示内容（频道/会话/任务/知识）已播过，只补配置面
    const alreadySeeded = ctx.panel.channels().find((item) => item.dept === deptId).length > 0

    if (config.agents.length === 0 && config.kpis.length === 0) {
      const agents: DeptAgent[] = content.agents.map((agent) => ({
        name: agent.n, desc: agent.d, icon: agent.icon, ...(agent.busy ? { busy: true } : {}),
      }))
      const kpis: DeptKpi[] = content.kpis.map(([label, value]) => ({ label, value, source: 'mock' }))
      const widgets: DeptWidget[] = content.widgets.map((widget, index) => ({
        id: `w${index + 1}`,
        type: widget.t as DeptWidget['type'],
        title: widget.title,
        ...(widget.live ? { live: true } : {}),
        // 治理硬性 DoD：演示看板全部带「模拟数据」来源徽标，绝不冒充真实业务面
        source: 'mock',
        rows: widget.rows,
      }))
      ctx.panel.deptConfigs().update(config.id, { agents, kpis, widgets })
    }

    if (alreadySeeded) continue
    for (const [name] of content.chans) {
      ctx.panel.channels().insert({ id: newId('pchan'), dept: deptId, name, createdBy: 'seed' })
    }
    const channels = ctx.panel.channels().find((item) => item.dept === deptId)
    const mainChannel = channels.at(0)

    for (const msg of content.msgs) {
      if (!mainChannel) break
      const ddSync = msg.dd === 'origin' ? 'origin' as const : msg.dd === true ? 'sent' as const : 'none' as const
      const senderType = msg.t === 'sys' ? 'system' as const : msg.t === 'agent' ? 'agent' as const : 'human' as const
      try {
        ctx.panel.messages().insert({
          id: newId('pmsg'), channelId: mainChannel.id, dept: deptId,
          senderType,
          ...(msg.n ? { senderName: msg.n } : {}),
          ...(msg.icon ? { senderIcon: msg.icon } : {}),
          text: msg.x,
          mentions: [...msg.x.matchAll(/@([\p{L}\p{N}·]{2,20})/gu)].map((m) => m[1]!),
          ...(msg.card ? { card: { title: msg.card.t, ops: mapOps(msg.card.ops), done: [] } } : {}),
          ddSync, agentName: senderType === 'agent' ? msg.n : undefined,
        })
      } catch (error) {
        logger.warn(`演示消息播种跳过（${deptId}）：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // 任务看板演示（泳道状态机 todo/doing/review/done；场景编号引用沉淀回图谱）
    const demoTasks: Array<[string, string, 'todo' | 'doing' | 'review' | 'done', string?]> = [
      ['rd', '低温启动需求拆解（V2.5-REQ-018）', 'doing', 'QB01-B-1-1'],
      ['rd', '!482 电机驱动过流保护评审', 'review'],
      ['mfg', 'WO-2611 风扇组件 ×3200', 'doing'],
      ['mfg', '3# 冲床油温异常维修工单（WX-0912）', 'todo', 'QB01-A-2-5'],
      ['mfg', 'M-2207 物料缺口补齐', 'todo', 'QB01-G-4-1'],
      ['sales', 'QT-2689 延保打包版报价审批', 'review'],
      ['sales', 'SV-3318 冰箱异响工单闭环', 'doing', 'QB01-F-3-1'],
      ['strategy', '设备联网率 52%→60% Q4 专项立项', 'todo', 'QB01-B-2-1'],
      ['strategy', '试点申报一页纸简报（周五经营会）', 'doing'],
      ['fin', '制造费用摊销调整流程', 'review', 'QB01-H-5-3'],
      ['fin', '8 张单据预审退回复核', 'todo'],
    ]
    for (const [dept, title, lane, sceneCode] of demoTasks) {
      if (dept !== deptId) continue
      ctx.panel.tasks().insert({
        id: newId('ptask'), dept: deptId, title, lane, assigneeType: 'human',
        ...(sceneCode ? { sceneCode } : {}), createdBy: 'seed',
      })
    }

    // 部门知识演示（Agent 产出物沉淀）
    const demoArtifacts: Array<[string, string, string, string?]> = [
      ['rd', 'diagnosis', 'V2.5 低温启动需求拆解纪要', '6 任务 / 34 人日 / 关键路径可靠性试验 10 天'],
      ['mfg', 'order', '维修工单 WX-0912', '3# 冲床液压油温超阈值；对应 QB01-A-2-5 建议列入改造清单'],
      ['sales', 'quote', '报价单 QT-2688 / QT-2689', '标准版 ¥118万（毛利 31.2%）· 延保打包版 ¥128万（毛利 33.5%）'],
      ['strategy', 'report', '政策申报可行性初判', '匹配度 92%；缺口：设备联网率 52%→60%；投入产出比 1:2.4'],
      ['fin', 'report', '预算偏差分析 · 制造费用', '78% 执行领先进度 10pp；主因 8 月设备大修一次性计入 ¥56 万'],
    ]
    for (const [dept, kind, title, contentText] of demoArtifacts) {
      if (dept !== deptId) continue
      ctx.panel.artifacts().insert({
        id: newId('part'), dept: deptId, kind: kind as 'report' | 'order' | 'quote' | 'diagnosis' | 'other',
        title, content: contentText ?? '', createdBy: 'seed',
      })
    }
  }
  logger.info('面板演示数据初始化完成（五部门频道/会话/任务/知识/看板）')
}
