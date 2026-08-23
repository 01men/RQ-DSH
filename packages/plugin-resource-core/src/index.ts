/**
 * @dsh-ops/plugin-resource-core —— 资源本体通用底座。
 *
 * Agent 与 AI 应用模块的属性模型、权限、生命周期逻辑高度一致（方案 §八），
 * 本插件把它们抽象为「资源本体」引擎：
 *   - 属性表引擎：声明式 schema（分组 + 字段），创建/更新时统一校验，
 *     同一份 schema 驱动控制台表单与 dshctl/工具参数。
 *   - 生命周期状态机：draft → trial → online → offline → archived，
 *     迁移带 guard、审批标记、历史留痕，并发布平台事件。
 *   - 依赖图：应用 → Agent → MCP/Skill 的依赖拓扑与影响面分析。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { newId, slugify, type Collection, type RecordBase } from '@dsh-ops/platform-core'

// ---------------------------------------------------------------------------
// 属性表 schema DSL
// ---------------------------------------------------------------------------

export type FieldType = 'string' | 'text' | 'number' | 'boolean' | 'enum' | 'tags' | 'url' | 'model'

export interface FieldSpec {
  key: string
  label: string
  type: FieldType
  group: string
  required?: boolean
  options?: Array<{ value: string; label: string; hint?: string }>
  hint?: string
  placeholder?: string
  defaultValue?: unknown
  /** 创建后不可修改（如 slug）。 */
  immutable?: boolean
  /** 上线（online）前必须补全。 */
  requiredForOnline?: boolean
}

export interface AttributeSchema {
  groups: Array<{ key: string; label: string; description?: string }>
  fields: FieldSpec[]
}

// ---------------------------------------------------------------------------
// 生命周期状态机
// ---------------------------------------------------------------------------

export interface LifecycleState {
  key: string
  label: string
  /** 状态徽章色调：ok | info | warn | danger | muted */
  tone: 'ok' | 'info' | 'warn' | 'danger' | 'muted'
  terminal?: boolean
}

export interface LifecycleTransition {
  action: string
  label: string
  from: string[]
  to: string
  /** 迁移前守卫：返回文案则拒绝。 */
  guard?: (entity: ResourceEntity, ctx: Context) => string | undefined
  /** 高危迁移需走审批中心（L4）。 */
  approval?: boolean
  /** 迁移完成后发布的平台事件名（如 agent.offlined）。 */
  event?: string
}

export interface LifecycleSpec {
  initial: string
  states: LifecycleState[]
  transitions: LifecycleTransition[]
}

// ---------------------------------------------------------------------------
// 资源类型声明
// ---------------------------------------------------------------------------

export interface ResourceTypeSpec {
  type: string
  label: string
  plugin: string
  idPrefix: string
  schema: AttributeSchema
  lifecycle: LifecycleSpec
}

export interface LifecycleHistoryEntry {
  at: string
  from: string
  to: string
  action: string
  actor: string
  note?: string
}

export interface ResourceEntity extends RecordBase {
  type: string
  slug: string
  name: string
  attrs: Record<string, unknown>
  status: string
  ownerId: string
  orgId: string
  lifecycleHistory: LifecycleHistoryEntry[]
}

export interface DependencyRecord extends RecordBase {
  fromType: string
  fromId: string
  toType: string
  toId: string
  kind: string
}

export interface TransitionResult {
  entity: ResourceEntity
  event?: string
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class ResourceCoreService extends Service {
  static readonly provide = 'resourceCore'

  private types = new Map<string, ResourceTypeSpec>()

  constructor(ctx: Context) {
    super(ctx, 'resourceCore')
  }

  /** 插件注册资源类型（幂等：重复注册覆盖，供开发期热载）。 */
  registerType(spec: ResourceTypeSpec): () => void {
    this.types.set(spec.type, spec)
    return () => this.types.delete(spec.type)
  }

  typeSpec(type: string): ResourceTypeSpec | undefined {
    return this.types.get(type)
  }

  typesSpecs(): ResourceTypeSpec[] {
    return [...this.types.values()]
  }

  collection(type: string): Collection<ResourceEntity> {
    const spec = this.requireSpec(type)
    return this.ctx.storage.collection<ResourceEntity>(`entity:${spec.type}`)
  }

  private requireSpec(type: string): ResourceTypeSpec {
    const spec = this.types.get(type)
    if (!spec) throw new Error(`未注册的资源类型：${type}`)
    return spec
  }

  // -- 属性校验 -----------------------------------------------------------

  validateAttrs(type: string, attrs: Record<string, unknown>, mode: 'create' | 'update' | 'online'): string[] {
    const spec = this.requireSpec(type)
    const errors: string[] = []
    for (const field of spec.schema.fields) {
      const value = attrs[field.key]
      const present = value !== undefined && value !== null && value !== ''
      if (mode === 'create' && field.required && !present) {
        errors.push(`缺少必填字段「${field.label}」(${field.key})`)
      }
      if (mode === 'online' && field.requiredForOnline && !present) {
        errors.push(`上线前必须补全「${field.label}」(${field.key})`)
      }
      if (!present) continue
      switch (field.type) {
        case 'number':
          if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`「${field.label}」必须是数字`)
          break
        case 'boolean':
          if (typeof value !== 'boolean') errors.push(`「${field.label}」必须是布尔值`)
          break
        case 'enum':
          if (!field.options?.some((option) => option.value === value)) {
            errors.push(`「${field.label}」的取值必须是：${field.options?.map((o) => o.value).join(' / ')}`)
          }
          break
        case 'tags':
          if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
            errors.push(`「${field.label}」必须是字符串数组`)
          }
          break
        case 'url':
          if (typeof value !== 'string' || !/^https?:\/\//.test(value)) errors.push(`「${field.label}」必须是 http(s) 地址`)
          break
        default:
          if (typeof value !== 'string') errors.push(`「${field.label}」必须是字符串`)
      }
    }
    return errors
  }

  // -- 实体 CRUD ----------------------------------------------------------

  create(type: string, input: {
    name: string
    slug?: string
    attrs?: Record<string, unknown>
    ownerId: string
    orgId: string
  }): ResourceEntity {
    const spec = this.requireSpec(type)
    if (!input.name || !String(input.name).trim()) throw new Error(`${spec.label}名称不能为空`)
    const attrs: Record<string, unknown> = {}
    for (const field of spec.schema.fields) {
      const provided = input.attrs?.[field.key]
      if (provided !== undefined) attrs[field.key] = provided
      else if (field.defaultValue !== undefined) attrs[field.key] = field.defaultValue
    }
    const errors = this.validateAttrs(type, attrs, 'create')
    if (errors.length > 0) throw new Error(`属性校验失败：${errors.join('；')}`)
    const slug = input.slug || slugify(input.name)
    const collection = this.collection(type)
    if (collection.findOne((entity) => entity.slug === slug)) {
      throw new Error(`${spec.label}标识 ${slug} 已存在`)
    }
    const now = new Date().toISOString()
    return collection.insert({
      id: newId(spec.idPrefix),
      type: spec.type,
      slug,
      name: input.name,
      attrs,
      status: spec.lifecycle.initial,
      ownerId: input.ownerId,
      orgId: input.orgId,
      lifecycleHistory: [{ at: now, from: '', to: spec.lifecycle.initial, action: 'create', actor: input.ownerId }],
    })
  }

  update(type: string, id: string, patch: { name?: string; attrs?: Record<string, unknown> }): ResourceEntity {
    const spec = this.requireSpec(type)
    const collection = this.collection(type)
    const entity = collection.get(id)
    if (!entity) throw new Error(`${spec.label}不存在：${id}`)
    const mergedAttrs = { ...entity.attrs }
    if (patch.attrs) {
      for (const field of spec.schema.fields) {
        if (patch.attrs[field.key] === undefined) continue
        if (field.immutable && entity.attrs[field.key] !== patch.attrs[field.key]) {
          throw new Error(`字段「${field.label}」创建后不可修改`)
        }
        mergedAttrs[field.key] = patch.attrs[field.key]
      }
    }
    const errors = this.validateAttrs(type, mergedAttrs, 'update')
    if (errors.length > 0) throw new Error(`属性校验失败：${errors.join('；')}`)
    return collection.update(id, {
      attrs: mergedAttrs,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
    })
  }

  get(type: string, id: string): ResourceEntity | undefined {
    return this.collection(type).get(id)
  }

  bySlug(type: string, slug: string): ResourceEntity | undefined {
    return this.collection(type).findOne((entity) => entity.slug === slug)
  }

  list(type: string, filter?: { status?: string; orgId?: string; q?: string }): ResourceEntity[] {
    const q = filter?.q?.toLowerCase()
    return this.collection(type).find((entity) => {
      if (filter?.status && entity.status !== filter.status) return false
      if (filter?.orgId && entity.orgId !== filter.orgId) return false
      if (q) {
        const haystack = `${entity.name} ${entity.slug} ${JSON.stringify(entity.attrs)}`.toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }

  remove(type: string, id: string): boolean {
    const spec = this.requireSpec(type)
    const entity = this.collection(type).get(id)
    if (!entity) return false
    if (!spec.lifecycle.states.find((state) => state.key === entity.status)?.terminal) {
      throw new Error(`仅终态资源可删除，当前状态 ${entity.status} 需先下线/归档`)
    }
    return this.collection(type).remove(id)
  }

  // -- 生命周期 -----------------------------------------------------------

  stateLabel(type: string, status: string): { label: string; tone: string } {
    const spec = this.requireSpec(type)
    const state = spec.lifecycle.states.find((item) => item.key === status)
    return { label: state?.label ?? status, tone: state?.tone ?? 'muted' }
  }

  availableTransitions(type: string, id: string): Array<{ action: string; label: string; to: string; approval?: boolean }> {
    const spec = this.requireSpec(type)
    const entity = this.collection(type).get(id)
    if (!entity) return []
    return spec.lifecycle.transitions
      .filter((transition) => transition.from.includes(entity.status))
      .map(({ action, label, to, approval }) => ({ action, label, to, approval }))
  }

  /** 执行状态迁移：guard → 状态更新 → 历史留痕 → 平台事件。 */
  transition(type: string, id: string, action: string, actor: string, note?: string): TransitionResult {
    const spec = this.requireSpec(type)
    const collection = this.collection(type)
    const entity = collection.get(id)
    if (!entity) throw new Error(`${spec.label}不存在：${id}`)
    const transition = spec.lifecycle.transitions.find((item) => item.action === action)
    if (!transition) throw new Error(`未知操作：${action}`)
    if (!transition.from.includes(entity.status)) {
      const fromState = this.stateLabel(type, entity.status).label
      throw new Error(`当前状态「${fromState}」不允许执行「${transition.label}」`)
    }
    if (transition.to === 'online') {
      const errors = this.validateAttrs(type, entity.attrs, 'online')
      if (errors.length > 0) throw new Error(errors.join('；'))
    }
    if (transition.guard) {
      const reason = transition.guard(entity, this.ctx)
      if (reason) throw new Error(reason)
    }
    const entry: LifecycleHistoryEntry = {
      at: new Date().toISOString(),
      from: entity.status,
      to: transition.to,
      action,
      actor,
      ...(note !== undefined ? { note } : {}),
    }
    const updated = collection.update(id, {
      status: transition.to,
      lifecycleHistory: [...entity.lifecycleHistory, entry],
    })
    const event = transition.event
    if (event) {
      this.ctx.platformBus.emit(event, { type, id, slug: updated.slug, name: updated.name, from: entry.from, to: entry.to, actor })
    }
    return { entity: updated, event }
  }

  // -- 依赖图 -------------------------------------------------------------

  dependencies(): Collection<DependencyRecord> {
    return this.ctx.storage.collection<DependencyRecord>('resource:dependencies')
  }

  addDependency(input: { fromType: string; fromId: string; toType: string; toId: string; kind: string }): DependencyRecord {
    const existing = this.dependencies().findOne((record) =>
      record.fromType === input.fromType && record.fromId === input.fromId
      && record.toType === input.toType && record.toId === input.toId)
    if (existing) return existing
    return this.dependencies().insert({
      id: newId('dep'),
      fromType: input.fromType,
      fromId: input.fromId,
      toType: input.toType,
      toId: input.toId,
      kind: input.kind,
    })
  }

  removeDependency(input: { fromType: string; fromId: string; toType: string; toId: string }): void {
    const record = this.dependencies().findOne((item) =>
      item.fromType === input.fromType && item.fromId === input.fromId
      && item.toType === input.toType && item.toId === input.toId)
    if (record) this.dependencies().remove(record.id)
  }

  /** 拓扑：从某资源向下展开依赖树（应用 → Agent → MCP/Skill）。未注册类型按叶节点呈现。 */
  topology(type: string, id: string, depth = 4): TopologyNode {
    const spec = this.types.get(type)
    const entity = spec ? this.collection(type).get(id) : undefined
    const node: TopologyNode = {
      type,
      id,
      name: entity?.name ?? id,
      status: entity?.status ?? 'unknown',
      statusLabel: entity && spec ? this.stateLabel(type, entity.status).label : '外部节点',
      children: [],
    }
    if (depth <= 0) return node
    for (const record of this.dependencies().find((item) => item.fromType === type && item.fromId === id)) {
      node.children.push(this.topology(record.toType, record.toId, depth - 1))
    }
    return node
  }

  /** 影响面：谁直接/间接依赖了该资源（下线前预览）。未注册类型仅登记 id。 */
  impact(type: string, id: string): Array<{ type: string; id: string; name: string; status: string; depth: number }> {
    const result: Array<{ type: string; id: string; name: string; status: string; depth: number }> = []
    const visit = (t: string, i: string, depth: number): void => {
      if (depth > 4) return
      for (const record of this.dependencies().find((item) => item.toType === t && item.toId === i)) {
        const spec = this.types.get(record.fromType)
        const entity = spec ? this.collection(record.fromType).get(record.fromId) : undefined
        if (result.some((item) => item.id === record.fromId)) continue
        result.push({ type: record.fromType, id: record.fromId, name: entity?.name ?? record.fromId, status: entity?.status ?? 'unknown', depth })
        visit(record.fromType, record.fromId, depth + 1)
      }
    }
    visit(type, id, 1)
    return result.sort((a, b) => a.depth - b.depth)
  }
}

export interface TopologyNode {
  type: string
  id: string
  name: string
  status: string
  statusLabel: string
  children: TopologyNode[]
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    resourceCore: ResourceCoreService
  }
}

export const name = 'resource-core'
export const inject = ['storage', 'platformBus']

export function apply(ctx: Context) {
  ctx.plugin(ResourceCoreService)
}
