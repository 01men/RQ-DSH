/**
 * @dsh-ops/platform-core —— 卡片包（card pack）模型与加载（action-plan-dsh-frontend WP-05）。
 *
 * 目标 3（多平台差异化交互）的配置底座：新增/调整卡片零前端代码改动——
 * 卡片包是纯 JSON 配置（默认目录 packages/platform-core/cardpacks/*.json，可经 CARDPACK_DIR 覆盖），
 * 服务端按「角色 × 平台」过滤下发，首页上限 6 张；资产 ref 存活性由端点侧注入的解析器裁决
 * （platform-core 不反向依赖业务插件，见下方 setRefAliveResolver）。
 *
 * 契约（WP-05/B1）：
 *   CardPack { platform, roles, cards[] }；Card { id, title, description, badge, href, ref?, order? }
 *   —— badge 为类型徽标（skill/app/mcp/nas/kb/data/model）；ref 为资产引用（type:idOrSlug），
 *   失效 ref 在下发时被静默过滤并告警一次；首页卡片上限 HOME_CARD_LIMIT=6。
 * 端点归属说明（对计划 D6 惯例条款的留痕）：过滤核心在本文件；REST 端点按仓库惯例由
 * console 聚合注册（console 持有 iam 角色与各资产注册表，才能做角色×平台×存活性三维过滤）。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'

export const CARDPACK_HOME_LIMIT = 6

/** 五平台差异化（WP-05/B3 主题色一一对应）：战略/营销/智造/研发/质量。 */
export const CARD_PLATFORMS = ['strategy', 'marketing', 'manufacturing', 'rd', 'quality'] as const
export type CardPlatform = (typeof CARD_PLATFORMS)[number]

/** 类型徽标（与登记引导页磁贴一致的目标 1 资产全覆盖；agent 为宿主数字员工入口卡）。 */
export const CARD_BADGES = ['skill', 'app', 'mcp', 'nas', 'kb', 'data', 'model', 'agent'] as const
export type CardBadge = (typeof CARD_BADGES)[number]

export interface CardpackCard {
  id: string
  title: string
  /** 一句话说明（≤40 字）。 */
  description: string
  badge: CardBadge
  /** 跳转目标（控制台 hash 路由或外链）。 */
  href: string
  /** 资产引用（type:idOrSlug，如 mcp:datawise / agent:dev-coder / kb:<orgId>）；失效即过滤。 */
  ref?: string
  /** 展示顺序（小者靠前，缺省按声明序）。 */
  order?: number
}

export interface CardPack {
  platform: CardPlatform
  /** 可见角色代码；'*'=全员。 */
  roles: string[]
  label?: string
  cards: CardpackCard[]
}

/** 校验单包：非法即抛错（列出全部问题，供 lint:manifests 与装载期共用）。 */
export function validateCardpack(input: unknown, source = 'cardpack'): string[] {
  const errors: string[] = []
  const pack = input as CardPack
  if (pack === null || typeof pack !== 'object') return [`${source}: 不是 JSON 对象`]
  if (!CARD_PLATFORMS.includes(pack.platform)) {
    errors.push(`${source}: platform 非法（应为 ${CARD_PLATFORMS.join('/')}，收到 ${String(pack.platform)}）`)
  }
  if (!Array.isArray(pack.roles) || pack.roles.length === 0) errors.push(`${source}: roles 必填且非空（'*' 表示全员）`)
  if (!Array.isArray(pack.cards) || pack.cards.length === 0) {
    errors.push(`${source}: cards 必填且非空`)
    return errors
  }
  const seen = new Set<string>()
  pack.cards.forEach((card, index) => {
    const at = `${source}: cards[${index}]`
    if (!card?.id || typeof card.id !== 'string') errors.push(`${at}.id 必填`)
    else if (seen.has(card.id)) errors.push(`${at}.id 重复：${card.id}`)
    else seen.add(card.id)
    if (!card?.title || typeof card.title !== 'string') errors.push(`${at}.title 必填`)
    if (!card?.description || typeof card.description !== 'string' || card.description.length > 60) {
      errors.push(`${at}.description 必填且 ≤60 字（一句话说明）`)
    }
    if (!CARD_BADGES.includes(card?.badge)) errors.push(`${at}.badge 非法（应为 ${CARD_BADGES.join('/')}）`)
    if (!card?.href || typeof card.href !== 'string') errors.push(`${at}.href 必填`)
    if (card?.ref !== undefined && !/^[a-z][a-z0-9]*:[A-Za-z0-9._\p{L}-]+$/u.test(String(card.ref))) {
      errors.push(`${at}.ref 格式非法（应为 type:idOrSlug，收到 ${String(card.ref)}）`)
    }
  })
  return errors
}

/** 角色匹配：包声明 '*' 或与主体角色有交集。 */
export function packVisibleForRoles(pack: CardPack, roles: string[]): boolean {
  return pack.roles.includes('*') || pack.roles.some((role) => roles.includes(role))
}

/**
 * 纯过滤：平台内可见包 → 卡片展平（order 升序、同 id 去重、失效 ref 过滤）→ 截取首页上限。
 * refAlive 缺省视为存活（无解析器的最小树不误伤）。
 */
export function filterCards(input: {
  packs: CardPack[]
  roles: string[]
  refAlive?: (ref: string) => boolean
  limit?: number
}): { cards: CardpackCard[]; droppedDeadRefs: string[] } {
  const refAlive = input.refAlive ?? (() => true)
  const limit = input.limit ?? CARDPACK_HOME_LIMIT
  const droppedDeadRefs: string[] = []
  const byId = new Map<string, CardpackCard & { order: number }>()
  for (const pack of input.packs.filter((pack) => packVisibleForRoles(pack, input.roles))) {
    for (const card of pack.cards) {
      if (card.ref !== undefined && !refAlive(card.ref)) {
        droppedDeadRefs.push(card.ref)
        continue
      }
      if (!byId.has(card.id)) byId.set(card.id, { ...card, order: card.order ?? 9999 })
    }
  }
  const cards = [...byId.values()].sort((a, b) => a.order - b.order).slice(0, limit)
  return { cards, droppedDeadRefs }
}

/** 默认卡片包目录：本包同级 cardpacks/（源码形态与安装形态均成立）。 */
export function defaultCardpackDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'cardpacks')
}

export class CardpackService extends Service {
  static readonly provide = 'cardpacks'

  private packs: CardPack[] = []
  private loadErrors: string[] = []
  private refAliveResolver: ((ref: string) => boolean) | undefined

  constructor(ctx: Context, config: { dir?: string } = {}) {
    super(ctx, 'cardpacks')
    void this.loadFromDir(config.dir ?? process.env.CARDPACK_DIR ?? defaultCardpackDir())
  }

  /** 装载目录内全部 *.json：单文件非法跳过并记录（不阻断启动），lint:manifests 负责红线。 */
  async loadFromDir(dir: string): Promise<void> {
    const errors: string[] = []
    const packs: CardPack[] = []
    let entries: Array<{ name: string }> = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      this.loadErrors = [`${dir} 不可读（无卡片包）`]
      return
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(await readFile(join(dir, entry.name), 'utf8'))
        const packErrors = validateCardpack(parsed, entry.name)
        if (packErrors.length > 0) {
          errors.push(...packErrors)
          continue
        }
        packs.push(parsed as CardPack)
      } catch (error) {
        errors.push(`${entry.name}: JSON 解析失败（${error instanceof Error ? error.message : String(error)}）`)
      }
    }
    this.packs = packs
    this.loadErrors = errors
    if (errors.length > 0) this.ctx.logger('cardpacks').warn(`卡片包装载存在被跳过的文件：${errors.join('；')}`)
  }

  all(): CardPack[] {
    return this.packs
  }

  forPlatform(platform: CardPlatform): CardPack[] {
    return this.packs.filter((pack) => pack.platform === platform)
  }

  /** 注入资产 ref 存活性解析器（console 装配时用 iam/resourceCore/skillhub/mcp 构建）。 */
  setRefAliveResolver(resolver: (ref: string) => boolean): void {
    this.refAliveResolver = resolver
  }

  refAlive(ref: string): boolean {
    return this.refAliveResolver ? this.refAliveResolver(ref) : true
  }

  /** 装载期被跳过文件的问题清单（坏 JSON / schema 违规），观测用。 */
  loadProblems(): string[] {
    return this.loadErrors
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    cardpacks: CardpackService
  }
}
