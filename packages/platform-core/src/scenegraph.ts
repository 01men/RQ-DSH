/**
 * @dsh-ops/platform-core —— 行业场景图谱（scenegraph）模型与加载（review-dsh-agent-panel-v2 Phase 2）。
 *
 * 「一图四清单」数据底座（工信部《场景化、图谱化推进重点行业数字化转型的参考指引（2025版）》映射）：
 *   1 条主线（chains 行业链条）+ 5 类业务活动（activities，研发设计/生产制造/供应链/运维服务/数字营销/
 *   经营管理/法财税与成本）+ N 个场景（scene 卡：编号/现状评级/价值标签/痛点）+ 4 类数字化要素
 *   （工具软件 tools / 知识模型 models / 数据要素 data / 人才技能 talent）。
 *
 * 与 cardpacks 同款裁决（评审 D5/D6）：v1 走内置资产通道（默认目录 packages/platform-core/scenegraphs/，
 * 可经 SCENEGRAPH_DIR 覆盖），市场上架（content.scenegraph 契约扩展）留待 Phase 4；校验器 lint 与
 * 运行时双端共用；热刷新 = reloadFromDir + PlatformEvents.ScenegraphUpdated。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'

/** 价值标签（工信部口径五类）。 */
export const SCENE_TAGS = ['提质', '降本', '增效', '节能', '新模式'] as const
export type SceneTag = (typeof SCENE_TAGS)[number]

/** 业务活动键（ACT 映射：研发设计 rd / 生产制造 mfg / 供应链 scm / 运维服务 svc / 数字营销 mkt / 经营管理 mgmt / 法财税 fin）。 */
export const SCENE_ACTIVITIES = ['rd', 'mfg', 'scm', 'svc', 'mkt', 'mgmt', 'fin'] as const
export type SceneActivity = (typeof SCENE_ACTIVITIES)[number]

export const ACTIVITY_LABELS: Record<SceneActivity, string> = {
  rd: '研发设计',
  mfg: '生产制造',
  scm: '供应链管理',
  svc: '运维服务',
  mkt: '数字营销',
  mgmt: '经营管理',
  fin: '法财税与成本',
}

export interface ScenegraphScene {
  /** 场景编号（如 QB01-A-2-5），全图唯一。 */
  code: string
  name: string
  type: '主场景' | '细分场景'
  /** 现状评级 1-5 星（企业自评，改造优先级依据：低于 3 星建议优先改造）。 */
  s: number
  tags: SceneTag[]
  pain: string
  tools: string[]
  models: string[]
  data: string[]
  talent: string[]
}

export interface ScenegraphPack {
  /** 行业代码（工信部图谱编码，如 QB01 家电 / GCJX 工程机械）。 */
  code: string
  name: string
  icon: string
  /** 图谱包版本（数据更新经 reloadFromDir + scenegraph.updated 热刷新）。 */
  version: string
  /** 行业主线链条（一条主线）。 */
  chains: string
  /** 业务活动 → 场景清单（5 类业务活动到 N 个场景的挂载）。 */
  activities: Partial<Record<SceneActivity, ScenegraphScene[]>>
}

/** 校验单包：返回全部问题（不抛错），lint:manifests 与装载期共用。 */
export function validateScenegraph(input: unknown, source = 'scenegraph'): string[] {
  const errors: string[] = []
  const pack = input as ScenegraphPack
  if (pack === null || typeof pack !== 'object') return [`${source}: 不是 JSON 对象`]
  if (!pack.code || typeof pack.code !== 'string' || !/^[A-Z][A-Z0-9]{2,9}$/.test(pack.code)) {
    errors.push(`${source}: code 必填（行业图谱编码，大写字母开头 3-10 位，收到 ${String(pack.code)}）`)
  }
  if (!pack.name || typeof pack.name !== 'string') errors.push(`${source}: name 必填`)
  if (!pack.icon || typeof pack.icon !== 'string') errors.push(`${source}: icon 必填`)
  if (!pack.version || typeof pack.version !== 'string') errors.push(`${source}: version 必填`)
  if (!pack.chains || typeof pack.chains !== 'string') errors.push(`${source}: chains（行业链条主线）必填`)
  if (!pack.activities || typeof pack.activities !== 'object' || Array.isArray(pack.activities)) {
    errors.push(`${source}: activities 必填（业务活动 → 场景清单）`)
    return errors
  }
  const seen = new Set<string>()
  let total = 0
  for (const [activity, scenes] of Object.entries(pack.activities)) {
    if (!SCENE_ACTIVITIES.includes(activity as SceneActivity)) {
      errors.push(`${source}: activities.${activity} 非法（应为 ${SCENE_ACTIVITIES.join('/')}）`)
      continue
    }
    if (!Array.isArray(scenes) || scenes.length === 0) {
      errors.push(`${source}: activities.${activity} 必须是非空场景数组`)
      continue
    }
    scenes.forEach((scene, index) => {
      total++
      const at = `${source}: activities.${activity}[${index}]`
      if (!scene?.code || typeof scene.code !== 'string') errors.push(`${at}.code 必填`)
      else if (seen.has(scene.code)) errors.push(`${at}.code 全图重复：${scene.code}`)
      else seen.add(scene.code)
      if (!scene?.name || typeof scene.name !== 'string') errors.push(`${at}.name 必填`)
      if (scene?.type !== '主场景' && scene?.type !== '细分场景') errors.push(`${at}.type 非法（主场景/细分场景）`)
      if (!Number.isInteger(scene?.s) || scene.s < 1 || scene.s > 5) errors.push(`${at}.s 现状评级须为 1-5 整数`)
      if (!Array.isArray(scene?.tags) || scene.tags.length === 0 || scene.tags.some((tag) => !SCENE_TAGS.includes(tag))) {
        errors.push(`${at}.tags 非法（应为 ${SCENE_TAGS.join('/')} 的非空子集）`)
      }
      if (!scene?.pain || typeof scene.pain !== 'string') errors.push(`${at}.pain 必填`)
      for (const list of ['tools', 'models', 'data', 'talent'] as const) {
        if (!Array.isArray(scene?.[list]) || scene[list].length === 0) {
          errors.push(`${at}.${list} 必填且非空（四清单缺一不可）`)
        }
      }
    })
  }
  if (total === 0) errors.push(`${source}: 图谱至少要有一个场景`)
  return errors
}

/** 默认图谱目录：本包同级 scenegraphs/（源码形态与安装形态均成立）。 */
export function defaultScenegraphDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'scenegraphs')
}

export class ScenegraphService extends Service {
  static readonly provide = 'scenegraphs'

  private packs: ScenegraphPack[] = []
  private loadErrors: string[] = []

  constructor(ctx: Context, config: { dir?: string } = {}) {
    super(ctx, 'scenegraphs')
    void this.loadFromDir(config.dir ?? process.env.SCENEGRAPH_DIR ?? defaultScenegraphDir())
  }

  /** 装载目录内全部 *.json：单文件非法跳过并记录（不阻断启动），lint:manifests 负责红线。 */
  async loadFromDir(dir: string): Promise<void> {
    const errors: string[] = []
    const packs: ScenegraphPack[] = []
    let entries: Array<{ name: string }> = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      this.loadErrors = [`${dir} 不可读（无场景图谱包）`]
      return
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(await readFile(join(dir, entry.name), 'utf8'))
        const packErrors = validateScenegraph(parsed, entry.name)
        if (packErrors.length > 0) {
          errors.push(...packErrors)
          continue
        }
        packs.push(parsed as ScenegraphPack)
      } catch (error) {
        errors.push(`${entry.name}: JSON 解析失败（${error instanceof Error ? error.message : String(error)}）`)
      }
    }
    this.packs = packs
    this.loadErrors = errors
    if (errors.length > 0) this.ctx.logger('scenegraphs').warn(`场景图谱装载存在被跳过的文件：${errors.join('；')}`)
  }

  /** 热刷新：重载目录后发 scenegraph.updated（面板据此刷新场景页；review Phase 2 第 11 条）。 */
  async reloadFromDir(dir?: string): Promise<{ packs: number; problems: string[] }> {
    await this.loadFromDir(dir ?? process.env.SCENEGRAPH_DIR ?? defaultScenegraphDir())
    this.ctx.platformBus.emit(PlatformEvents_ScenegraphUpdated, { packs: this.packs.length, problems: this.loadErrors.length })
    return { packs: this.packs.length, problems: this.loadErrors }
  }

  all(): ScenegraphPack[] {
    return this.packs
  }

  get(code: string): ScenegraphPack | undefined {
    return this.packs.find((pack) => pack.code === code)
  }

  /** 场景编号反查（会话引用沉淀回图谱：如 QB01-A-2-5）。 */
  findScene(code: string): { pack: ScenegraphPack; activity: SceneActivity; scene: ScenegraphScene } | undefined {
    for (const pack of this.packs) {
      for (const [activity, scenes] of Object.entries(pack.activities)) {
        const hit = (scenes ?? []).find((scene) => scene.code === code)
        if (hit) return { pack, activity: activity as SceneActivity, scene: hit }
      }
    }
    return undefined
  }

  /** 装载期被跳过文件的问题清单，观测用。 */
  loadProblems(): string[] {
    return this.loadErrors
  }
}

/** 独立常量避免与 index.ts 导出顺序耦合（值与 PlatformEvents.ScenegraphUpdated 一致）。 */
const PlatformEvents_ScenegraphUpdated = 'scenegraph.updated'

declare module '@deepseek-ai/cordis' {
  interface Context {
    scenegraphs: ScenegraphService
  }
}
