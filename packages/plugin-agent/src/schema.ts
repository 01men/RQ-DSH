/**
 * Agent 本体属性表与生命周期声明（方案 §5.1 / §5.6）。
 * schema 同时驱动：控制台注册表单（分「基本/技术/治理」三组）、属性校验、详情页展示。
 */
import type { ResourceTypeSpec } from '../../platform-core/src/index.ts'

export const AGENT_TYPE_SPEC: ResourceTypeSpec = {
  type: 'agent',
  label: 'Agent',
  plugin: 'agent',
  idPrefix: 'agt',
  schema: {
    groups: [
      { key: 'basic', label: '基本属性', description: '身份与归属信息' },
      { key: 'tech', label: '技术属性', description: '模型、提示词与能力依赖' },
      { key: 'governance', label: '治理属性', description: '风险与数据密级（上线审批依据）' },
    ],
    fields: [
      { key: 'description', label: '描述', type: 'text', group: 'basic', required: true, placeholder: '这个 Agent 做什么、适用什么场景', hint: '展示在市场与详情页' },
      { key: 'avatar', label: '头像', type: 'string', group: 'basic', defaultValue: '🤖', hint: '一个 emoji 即可' },
      { key: 'tags', label: '标签', type: 'tags', group: 'basic', defaultValue: [] },
      { key: 'model', label: '底层模型', type: 'enum', group: 'tech', required: true, options: [
        { value: 'deepseek-chat', label: 'DeepSeek Chat', hint: '通用对话' },
        { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner', hint: '深度推理' },
        { value: 'deepseek-coder', label: 'DeepSeek Coder', hint: '代码任务' },
      ] },
      { key: 'systemPromptVersion', label: '系统提示词版本', type: 'string', group: 'tech', requiredForOnline: true, placeholder: '如 prompt-v3.2', hint: '上线前必须登记' },
      { key: 'skills', label: '关联 Skill', type: 'tags', group: 'tech', defaultValue: [], hint: '从市场安装后自动回填' },
      { key: 'mcpPermGroupIds', label: 'MCP 权限组', type: 'tags', group: 'tech', defaultValue: [], hint: '授予该 Agent 的工具访问范围' },
      { key: 'env', label: '运行环境', type: 'enum', group: 'tech', defaultValue: 'sandbox', options: [
        { value: 'sandbox', label: '平台沙箱' },
        { value: 'shared', label: '共享运行时' },
        { value: 'dedicated', label: '独占实例' },
      ] },
      { key: 'riskLevel', label: '风险等级', type: 'enum', group: 'governance', required: true, options: [
        { value: 'low', label: '低', hint: '只读检索类' },
        { value: 'medium', label: '中', hint: '可写业务数据' },
        { value: 'high', label: '高', hint: '外联或资金相关' },
      ] },
      { key: 'dataClass', label: '数据密级', type: 'enum', group: 'governance', requiredForOnline: true, options: [
        { value: 'public', label: '公开', hint: '可对外展示' },
        { value: 'internal', label: '内部', hint: '仅限员工可见' },
        { value: 'confidential', label: '机密', hint: '调用需额外审批' },
        { value: 'secret', label: '绝密', hint: '禁止 Agent 直接处理' },
      ], hint: '高密级资源的调用需额外审批（方案 §七）' },
      { key: 'trialGroups', label: '试运行用户组', type: 'tags', group: 'governance', hint: '试运行阶段限定可用的用户组' },
    ],
  },
  lifecycle: {
    initial: 'draft',
    states: [
      { key: 'draft', label: '开发中', tone: 'muted' },
      { key: 'trial', label: '试运行', tone: 'info' },
      { key: 'online', label: '已上线', tone: 'ok' },
      { key: 'offline', label: '已下线', tone: 'warn' },
      { key: 'archived', label: '已归档', tone: 'muted', terminal: true },
    ],
    transitions: [
      {
        action: 'submit_trial', label: '进入试运行', from: ['draft'], to: 'trial',
        guard: (entity) => {
          const groups = entity.attrs['trialGroups']
          if (!Array.isArray(groups) || groups.length === 0) return '试运行需指定限定用户组（trialGroups）'
          return undefined
        },
      },
      { action: 'online', label: '上线', from: ['draft', 'trial'], to: 'online', approval: true },
      { action: 'offline', label: '下线', from: ['trial', 'online'], to: 'offline', approval: true },
      { action: 'retrial', label: '恢复试运行', from: ['offline'], to: 'trial' },
      { action: 'archive', label: '归档', from: ['offline'], to: 'archived' },
    ],
  },
}
