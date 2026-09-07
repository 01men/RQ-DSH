/**
 * 一次性提取脚本（review-dsh-agent-panel-v2 Phase 2 第 11 条）：
 * 从设计原型 index.html 的内嵌数据（DEPT_META / APPLIANCE / MACHINERY / INDUSTRIES）确定性剥离——
 *   1) packages/platform-core/scenegraphs/{qb01,gcjx}.json   行业场景图谱包（一图四清单）
 *   2) packages/plugin-panel-core/src/seed/demo-content.json 面板演示种子（五部门 Agent 阵容/频道/widget/样例会话）
 * 原型即「一套骨架五种皮肤」的数据驱动结构，剥离后以 JSON 为唯一事实源（原型变更可重跑本脚本）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync('D:/软件/WorkBuddy/2026-09-07-12-09-05/dsh-agent-panel-design/index.html', 'utf8')

// 提取 <script> 内从 DEPT_META 定义到「状态」注释之前的纯数据段（无 DOM 依赖，可安全求值）
const start = html.indexOf('const DEPT_META')
const end = html.indexOf('/* ================= 状态')
if (start < 0 || end < 0 || end <= start) throw new Error('原型数据段定位失败')
const dataScript = html.slice(start, end).replace(/^const /gm, 'var ')
const sandbox = new Function(`${dataScript}; return { DEPT_META, ACT_NAME, TAG_CLS, APPLIANCE, MACHINERY, INDUSTRIES }`)()
const { DEPT_META, ACT_NAME, APPLIANCE, MACHINERY, INDUSTRIES } = sandbox

// 1) 场景图谱包（scenes → activities；版本锚定工信部 2025 版参考指引）
const toPack = (ind) => ({
  code: ind.code,
  name: ind.name,
  icon: ind.icon,
  version: '2025.1',
  chains: ind.chains,
  activities: ind.scenes,
})
const sgDir = join(ROOT, 'packages', 'platform-core', 'scenegraphs')
mkdirSync(sgDir, { recursive: true })
writeFileSync(join(sgDir, 'qb01.json'), JSON.stringify(toPack(APPLIANCE), null, 2) + '\n', 'utf8')
writeFileSync(join(sgDir, 'gcjx.json'), JSON.stringify(toPack(MACHINERY), null, 2) + '\n', 'utf8')

// 2) 面板演示种子（QB01 家电为标杆行业；五部门阵容/频道/widget/样例会话 + 原型其余行业登记）
const demo = {
  industry: 'appliance',
  depts: APPLIANCE.depts,
  industries: Object.entries(INDUSTRIES)
    .filter(([, ind]) => !ind.activated)
    .map(([key, ind]) => ({ key, code: ind.code, name: ind.name, icon: ind.icon, sub: ind.sub })),
}
const seedDir = join(ROOT, 'packages', 'plugin-panel-core', 'src', 'seed')
mkdirSync(seedDir, { recursive: true })
writeFileSync(join(seedDir, 'demo-content.json'), JSON.stringify(demo, null, 2) + '\n', 'utf8')

// 摘要
const sceneCount = (pack) => Object.values(pack.activities).reduce((sum, list) => sum + list.length, 0)
console.log(`qb01.json: ${sceneCount(toPack(APPLIANCE))} 场景；gcjx.json: ${sceneCount(toPack(MACHINERY))} 场景`)
console.log(`demo-content.json: 5 部门（${Object.keys(APPLIANCE.depts).join('/')}），锁定行业 ${demo.industries.map((i) => i.code).join('/')}，DEPT_META 部门=${Object.keys(DEPT_META).length}，ACT_NAME 活动=${Object.keys(ACT_NAME).length}`)
