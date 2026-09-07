/**
 * 落地分诊（统一入口 · 角色路由）：一个入口按身份落地——管理/治理身份进控制台，纯业务身份进部门面板。
 *
 * 规则（见 docs/entry-switching.md）：
 *   resolveLanding(user) === 'panel'   仅当「纯业务身份 + 面板可达」；
 *   其余一律 'console'（含平台管理员/组织管理员/资源管理员/开发者/审计员与自定义管理角色）。
 * 判据是权限点而非角色名：BuiltinRoles 的 member 角色不含任何管理域标记，
 * 其余内置角色经 userPermissions 通配展开后必持有至少一项（iam.user.read / approval.read / audit.read / usage.read）。
 *
 * 本模块保持纯函数 + 常量：Node 可直接导入（selftest 经 landing.test.mjs 直测），不触碰 DOM/localStorage。
 */

/** 管理域标记权限点：持有任一即视为管理/治理身份，落地控制台 */
export const MGMT_MARKERS = Object.freeze([
  'iam.user.read',
  'approval.read',
  'audit.read',
  'usage.read',
])

/** 跨工作台切换偏好键：面板/控制台的显式切换入口写入，分诊尊重既有偏好 */
export const LANDING_PREF_KEY = 'heng_ops_landing'

/** 部门面板可达：panel.read（'*' 全量亦可达） */
export function canPanel(user) {
  const permissions = user?.permissions ?? []
  return permissions.includes('*') || permissions.includes('panel.read')
}

/** 纯业务身份：无任何管理域标记（'*' 全量恒为管理域） */
export function isBusinessOnly(user) {
  const permissions = user?.permissions ?? []
  if (permissions.includes('*')) return false
  return !MGMT_MARKERS.some((point) => permissions.includes(point))
}

/** 分诊决议：'panel' | 'console' */
export function resolveLanding(user) {
  return isBusinessOnly(user) && canPanel(user) ? 'panel' : 'console'
}

/** 裸落地判定：仅「无 hash / #/ / #/dashboard」时分诊，深链刷新与页内导航不受影响 */
export function isBareLanding(hash) {
  const value = String(hash ?? '')
  return value === '' || value === '#/' || value === '#/dashboard'
}

/** 登录回跳地址白名单：仅同源绝对路径（/ 开头且非 //），防 open redirect */
export function sanitizeNext(raw) {
  const value = String(raw ?? '')
  if (!value.startsWith('/') || value.startsWith('//')) return ''
  return value
}
