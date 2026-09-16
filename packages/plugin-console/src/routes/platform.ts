/**
 * 平台级路由（M2 筑基，按 routes/market.ts 拆分模式新建）：
 * 首启 bootstrap 状态——部署 checklist 与登录页「初始口令待接管」提示的数据源。
 *
 * 信息泄露评估（公开端点设计依据）：initialPasswordPending 只回答「初始口令文件是否仍在服务器」
 * 这一个布尔，不含口令本身、不含组织结构；其价值是让部署者在任何机器上确认收尾动作是否完成
 * （改密 + 删除 data/admin-initial-password.txt），风险远低于提示缺失导致初始口令长期滞留。
 */
import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { HttpExchange } from '../../../platform-core/src/index.ts'

/** 首启种子登记（seedAll 写入；空库判定的每次首启只发生一次）。 */
export interface BootstrapRecord {
  id: 'singleton'
  seededAt: string
  mode: 'baseline' | 'demo'
  orgName: string
  /** 初始口令文件绝对路径（ADMIN_PASSWORD 显式指定时不落盘、无此字段）。 */
  initialPasswordFile?: string
}

export function bootstrapCollection(ctx: Context) {
  return ctx.opsStorage.collection<BootstrapRecord>('platform:bootstrap')
}

/** 首启种子登记（seed.ts 调用；幂等——已有记录不覆盖，保留最初一次的真实状态）。 */
export function recordBootstrap(ctx: Context, record: Omit<BootstrapRecord, 'id' | 'seededAt'>): void {
  const collection = bootstrapCollection(ctx)
  if (collection.get('singleton')) return
  collection.insert({ id: 'singleton', seededAt: new Date().toISOString(), ...record })
}

/** 初始口令是否仍待接管：登记了口令文件且文件还在磁盘（改密后按文档指引删除文件即解除提示）。 */
export function initialPasswordPending(ctx: Context): boolean {
  const record = bootstrapCollection(ctx).get('singleton')
  return Boolean(record?.initialPasswordFile && existsSync(record.initialPasswordFile))
}

export interface PlatformRouteDeps {
  http: { register: (method: string, path: string, handler: (exchange: HttpExchange) => unknown | Promise<unknown>, options?: Record<string, unknown>) => void }
}

export function registerPlatformRoutes(ctx: Context, deps: PlatformRouteDeps): void {
  const { http } = deps

  // 公开（登录页部署提示用）：只回一个布尔，不泄露任何结构信息
  http.register('GET', '/api/platform/bootstrap', (exchange) => {
    exchange.ok({ initialPasswordPending: initialPasswordPending(ctx) })
  }, { access: 'public' })

  // 已登录全量：部署 checklist 验证步与「平台」页可读完整首启状态
  // （非 guarded 路由无 JSON 包装：必须手动 exchange.ok，只 return 值会让连接永久挂起）
  http.register('GET', '/api/platform/bootstrap/detail', (exchange) => {
    const record = bootstrapCollection(ctx).get('singleton')
    if (!record) {
      exchange.ok({ initialized: false, mode: null, orgName: null, seededAt: null, initialPasswordPending: false })
      return
    }
    exchange.ok({
      initialized: true,
      mode: record.mode,
      orgName: record.orgName,
      seededAt: record.seededAt,
      initialPasswordPending: initialPasswordPending(ctx),
      ...(record.initialPasswordFile ? { initialPasswordFile: record.initialPasswordFile } : {}),
    })
  }, { access: 'authenticated' })
}
