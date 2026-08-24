/**
 * NAS 存储资产属性表与生命周期声明（FS 文件存储类资产）。
 *
 * 访问模型：NAS 资产通过「MCP 文件网关」访问（参考 synology-filestation-mcp）——
 * 网关地址 + Bearer 令牌 + X-NAS-IP 设备路由，全部文件操作经网关 tools/call 完成。
 * schema 同时驱动：控制台注册表单（基本/接入/治理三组）、属性校验、详情页展示。
 */
import type { ResourceTypeSpec } from '../../plugin-resource-core/src/index.ts'

export const NAS_TYPE_SPEC: ResourceTypeSpec = {
  type: 'nas',
  label: 'NAS 存储',
  plugin: 'nas',
  idPrefix: 'nas',
  schema: {
    groups: [
      { key: 'basic', label: '基本属性', description: '设备身份与归属信息' },
      { key: 'access', label: '接入属性', description: 'MCP 文件网关与设备路由（上线必须补全）' },
      { key: 'governance', label: '治理属性', description: '数据密级（访问审批依据）' },
    ],
    fields: [
      { key: 'description', label: '描述', type: 'text', group: 'basic', required: true, placeholder: '这台 NAS 存什么、服务哪些业务', hint: '展示在资产台账与详情页' },
      { key: 'vendor', label: '厂商/型号', type: 'string', group: 'basic', placeholder: '如 Synology DS920+', hint: '选填' },
      { key: 'capacity', label: '容量', type: 'string', group: 'basic', placeholder: '如 4×4TB' },
      { key: 'tags', label: '标签', type: 'tags', group: 'basic', defaultValue: [] },
      { key: 'gatewayUrl', label: 'MCP 网关地址', type: 'url', group: 'access', required: true, requiredForOnline: true, placeholder: 'http://192.168.0.7:3000/mcp', hint: 'synology-filestation-mcp 等 MCP 文件网关的 streamable HTTP 端点' },
      { key: 'accessToken', label: '网关访问令牌', type: 'string', group: 'access', required: true, requiredForOnline: true, placeholder: 'Bearer 令牌（回显脱敏）', hint: '网关侧签发的访问凭证，存储保留原文、展示层掩码' },
      { key: 'nasIp', label: 'NAS 设备 IP', type: 'string', group: 'access', required: true, requiredForOnline: true, placeholder: '192.168.0.196', hint: '经 X-NAS-IP 头路由到网关背后的具体设备' },
      { key: 'rootPath', label: '授权根路径', type: 'string', group: 'access', defaultValue: '/', placeholder: '/（默认全部）', hint: '纳管范围收敛到该子树（展示与审计口径）' },
      { key: 'stagingDir', label: '上传中转目录', type: 'string', group: 'access', placeholder: '（默认 <dataDir>/nas-staging）', hint: 'fs_upload 在网关侧读取本地路径：网关与平台需同机部署，或把此目录配置为共享挂载点' },
      { key: 'dataClass', label: '数据密级', type: 'enum', group: 'governance', required: true, defaultValue: 'internal', options: [
        { value: 'public', label: '公开' },
        { value: 'internal', label: '内部', hint: '仅限员工可见' },
        { value: 'confidential', label: '机密', hint: '访问需额外审批' },
      ] },
    ],
  },
  lifecycle: {
    initial: 'draft',
    states: [
      { key: 'draft', label: '草稿', tone: 'muted' },
      { key: 'online', label: '已上线', tone: 'ok' },
      { key: 'offline', label: '已下线', tone: 'warn' },
      { key: 'archived', label: '已归档', tone: 'muted', terminal: true },
    ],
    transitions: [
      { action: 'online', label: '上线', from: ['draft', 'offline'], to: 'online' },
      { action: 'offline', label: '下线', from: ['online'], to: 'offline' },
      { action: 'archive', label: '归档', from: ['offline'], to: 'archived' },
    ],
  },
}
