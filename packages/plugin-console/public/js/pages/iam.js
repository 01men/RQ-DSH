/** 组织与账号：左树右表 + 角色/用户组/三方集成/冲突工单。 */
import { api, session } from '../api.js'
import { icon } from '../icons.js'
import {
  h, $, $$, esc, toast, openDrawer, openModal, confirmDialog,
  renderTable, statusBadge, collectForm, field, inputField, selectField, textareaField,
  attachDropdown, timeAgo, emptyState,
} from '../ui.js'

/** 复制到剪贴板（clipboard API 不可用时降级全选提示）。 */
function copyText(text) {
  return navigator.clipboard?.writeText(text)
    .then(() => toast('已复制到剪贴板'))
    .catch(() => toast('复制失败，请手动选择复制', 'error'))
}

/**
 * 账号凭据展示弹窗：用户名/口令标红突出、逐项与整体一键复制；
 * 口令支持传达过程中二次修改（指定新口令或重新随机）。
 */
function showUserCredentials({ userId, username, displayName, password, onDone }) {
  let current = password
  const modal = openModal({
    title: `账号凭据（${esc(displayName)}）`,
    body: `
      <div class="form-hint" style="margin-bottom:12px">请立即复制并安全传达给本人；口令仅本次展示，传达前可在下方直接二次修改。</div>
      <div class="muted-box mb-8" style="display:flex;align-items:center;gap:10px;justify-content:space-between">
        <span style="min-width:64px" class="fs-12 text-4">用户名</span>
        <code id="cred-username" style="flex:1;font-size:15px;font-weight:700;color:var(--danger);word-break:break-all">${esc(username)}</code>
        <button class="btn btn-default btn-sm" id="cred-copy-user">复制</button>
      </div>
      <div class="muted-box mb-8" style="display:flex;align-items:center;gap:10px;justify-content:space-between">
        <span style="min-width:64px" class="fs-12 text-4">口令</span>
        <code id="cred-password" style="flex:1;font-size:15px;font-weight:700;color:var(--danger);word-break:break-all">${esc(current)}</code>
        <button class="btn btn-default btn-sm" id="cred-copy-pw">复制</button>
      </div>
      <button class="btn btn-default btn-sm mb-8" id="cred-copy-all">${icon('check', 12)}一键复制完整凭据（用户名 + 口令）</button>
      <div class="card-title mb-8 mt-14">二次修改口令（可选）</div>
      <div style="display:flex;gap:8px;align-items:center">
        <input class="input" id="cred-newpw" placeholder="新口令（至少 8 位，不含中文）" autocomplete="off" style="flex:1">
        <button class="btn btn-default" id="cred-setpw">设为该口令</button>
        <button class="btn btn-default" id="cred-randpw">重新随机</button>
      </div>
      <div class="form-hint mt-8">修改后原口令立即失效，请以弹窗内最新口令为准传达。</div>`,
    foot: '<button class="btn btn-primary" data-cancel>我已妥善传达</button>',
  })
  const pwEl = modal.body.querySelector('#cred-password')
  const applyPassword = (next, note) => {
    current = next
    pwEl.textContent = current
    modal.body.querySelector('#cred-newpw').value = ''
    toast(note)
  }
  const resetTo = async (payload, note) => {
    try {
      const result = await api.post(`/api/iam/users/${userId}/reset-password`, payload)
      applyPassword(result.initialPassword, note)
    } catch (error) { toast(error.message, 'error') }
  }
  modal.body.querySelector('#cred-copy-user').onclick = () => void copyText(username)
  modal.body.querySelector('#cred-copy-pw').onclick = () => void copyText(current)
  modal.body.querySelector('#cred-copy-all').onclick = () => void copyText(`用户名：${username}\n口令：${current}`)
  modal.body.querySelector('#cred-setpw').onclick = () => {
    const next = modal.body.querySelector('#cred-newpw').value.trim()
    if (next.length < 8) return toast('口令长度不得少于 8 位', 'error')
    void resetTo({ password: next }, '口令已更新为指定值，请重新复制传达')
  }
  modal.body.querySelector('#cred-randpw').onclick = () => void resetTo({}, '已重新生成随机口令，请重新复制传达')
  modal.el.querySelector('[data-cancel]').onclick = () => { modal.close(); onDone?.() }
}

export async function renderIam(content, params, ctx) {
  const tab = params.get('tab') ?? 'members'
  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">组织与账号</div>
        <div class="page-desc">组织架构、账号生命周期、角色权限与三方同步——人是一切授权的主体。</div>
      </div>
      <div class="page-actions" id="iam-actions"></div>
    </div>
    <div class="tabs" id="iam-tabs">
      <div class="tab ${tab === 'members' ? 'active' : ''}" data-tab="members">组织成员</div>
      <div class="tab ${tab === 'roles' ? 'active' : ''}" data-tab="roles">角色权限</div>
      <div class="tab ${tab === 'groups' ? 'active' : ''}" data-tab="groups">用户组</div>
      <div class="tab ${tab === 'connectors' ? 'active' : ''}" data-tab="connectors">三方集成</div>
      <div class="tab ${tab === 'conflicts' ? 'active' : ''}" data-tab="conflicts">同步冲突 <span class="tab-count" id="conflict-count"></span></div>
    </div>
    <div id="iam-body"></div>`

  $$('#iam-tabs .tab').forEach((el) => {
    el.onclick = () => { location.hash = `#/iam?tab=${el.dataset.tab}` }
  })

  if (tab === 'members') await renderMembers()
  if (tab === 'roles') await renderRoles()
  if (tab === 'groups') await renderGroups()
  if (tab === 'connectors') await renderConnectors(params, ctx)
  if (tab === 'conflicts') await renderConflicts()

  // ------------------------------------------------------------------
  async function renderMembers() {
    const [treeData, usersData] = await Promise.all([
      api.get('/api/iam/orgs/tree'),
      api.get('/api/iam/users'),
    ])
    $('#iam-actions').innerHTML = `
      <button class="btn btn-default" id="org-add">${icon('plus', 14)}新建组织</button>
      <button class="btn btn-default" id="user-import">${icon('download', 14)}批量导入</button>
      <button class="btn btn-primary" id="user-add">${icon('plus', 14)}创建账号</button>`
    $('#user-add').onclick = () => openUserCreate(treeData, usersData)
    $('#org-add').onclick = () => openOrgCreate(treeData)
    $('#user-import').onclick = () => openUserImport(treeData)

    const body = $('#iam-body')
    body.innerHTML = `
      <div style="display:grid;grid-template-columns:280px 1fr;gap:14px;align-items:start">
        <div class="card" style="padding:10px 8px">
          <div class="flex" style="padding:4px 8px 8px;justify-content:space-between">
            <span class="fs-12 text-3" style="font-weight:600">组织架构</span>
            <span class="fs-11 text-4">${usersData.total} 人</span>
          </div>
          <div class="tree" id="org-tree"></div>
        </div>
        <div>
          <div class="filter-bar">
            <div class="search-input">${icon('search')}<input class="input" id="member-q" placeholder="搜索姓名 / 用户名 / 邮箱"></div>
            <select class="select" id="member-status" style="width:130px">
              <option value="">全部状态</option><option value="active">正常</option><option value="pending">待激活</option>
              <option value="frozen">已冻结</option><option value="deactivated">已注销</option>
            </select>
            <span class="fs-12 text-3" id="member-count"></span>
          </div>
          <div id="member-table"></div>
        </div>
      </div>`

    let selectedOrgId = null
    const treeEl = $('#org-tree')

    function renderTree() {
      treeEl.innerHTML = ''
      const allNode = treeNode({ id: '', name: '全部成员', count: usersData.total }, true)
      treeEl.appendChild(allNode)
      for (const node of treeData) treeEl.appendChild(treeNode(node))
    }
    function treeNode(node, isAll) {
      const el = h(`
        <div class="tree-node">
          <div class="tree-row ${selectedOrgId === node.id ? 'active' : ''}" data-org="${esc(node.id)}">
            <span class="tree-caret ${hasChildren(node) || isAll ? 'open' : ''}" style="${!hasChildren(node) && !isAll ? 'visibility:hidden' : ''}">${icon('chevronRight', 12)}</span>
            ${icon(isAll ? 'users' : 'building', 14)}
            <span class="ellipsis">${esc(node.name)}</span>
            <span class="tree-count">${countOf(node, isAll)}</span>
          </div>
          <div class="tree-children ${hasChildren(node) ? 'open' : ''}"></div>
        </div>`)
      const childrenEl = el.querySelector('.tree-children')
      for (const child of (node.children ?? [])) childrenEl.appendChild(treeNode(child))
      const row = el.querySelector('.tree-row')
      row.onclick = () => {
        selectedOrgId = node.id
        $$('.tree-row', treeEl).forEach((r) => r.classList.remove('active'))
        row.classList.add('active')
        void refreshMembers()
      }
      el.querySelector('.tree-caret').onclick = (e) => {
        e.stopPropagation()
        childrenEl.classList.toggle('open')
        el.querySelector('.tree-caret').classList.toggle('open')
      }
      if (node.id) {
        row.oncontextmenu = (e) => {
          e.preventDefault()
          openOrgMenu(e, node)
        }
      }
      return el
    }
    function hasChildren(node) { return (node.children ?? []).length > 0 }
    function countOf(node, isAll) {
      if (isAll) return usersData.total
      return usersData.users.filter((u) => u.orgId === node.id).length
    }
    function openOrgMenu(e, node) {
      const anchor = h(`<button class="btn btn-ghost btn-sm" style="position:fixed;left:${e.clientX}px;top:${e.clientY}px;opacity:0;pointer-events:none">${icon('more')}</button>`)
      document.body.appendChild(anchor)
      attachDropdown(anchor, (menu) => {
        menu.innerHTML = `
          <button class="dropdown-item" data-act="add-child">${icon('plus')}新建子组织</button>
          <button class="dropdown-item" data-act="rename">${icon('edit')}重命名</button>
          <button class="dropdown-item danger" data-act="delete">${icon('trash')}删除组织</button>`
        menu.querySelector('[data-act="add-child"]').onclick = () => { anchor.remove(); openOrgCreate(treeData, node.id) }
        menu.querySelector('[data-act="rename"]').onclick = async () => {
          anchor.remove()
          const modal = openModal({
            title: '重命名组织',
            body: field('组织名称', inputField('name', { value: node.name }), { required: true }),
            foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>',
          })
          modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
          modal.el.querySelector('[data-ok]').onclick = async () => {
            const data = collectForm(modal.body)
            if (!data.name) return toast('名称不能为空', 'error')
            await api.patch(`/api/iam/orgs/${node.id}`, { name: data.name })
            toast('已重命名'); modal.close(); location.hash = '#/iam'; ctx.rerender()
          }
        }
        menu.querySelector('[data-act="delete"]').onclick = async () => {
          anchor.remove()
          const result = await confirmDialog({ title: '删除组织', message: `确定删除「${esc(node.name)}」？仅当组织下无子组织且无账号时可删除。`, danger: true })
          if (!result) return
          try {
            await api.delete(`/api/iam/orgs/${node.id}`)
            toast('组织已删除'); location.hash = '#/iam'; ctx.rerender()
          } catch (error) { toast(error.message, 'error') }
        }
      })
      anchor.click()
    }

    async function refreshMembers() {
      const q = $('#member-q').value.trim()
      const status = $('#member-status').value
      const search = api.qs({ orgId: selectedOrgId || undefined, q: q || undefined, status: status || undefined })
      const data = await api.get('/api/iam/users' + search)
      $('#member-count').textContent = `共 ${data.total} 人`
      const table = renderTable({
        columns: [
          {
            title: '姓名', width: '22%',
            render: (u) => `
              <div class="flex" style="gap:10px">
                <div class="avatar sm">${esc(u.displayName.slice(0, 1))}</div>
                <div>
                  <div class="col-strong">${esc(u.displayName)}</div>
                  <div class="col-sub">@${esc(u.username)}</div>
                </div>
              </div>`,
          },
          { title: '部门 / 职位', render: (u) => `<div>${esc(u.orgName || '—')}</div><div class="col-sub">${esc(u.title || '—')}</div>` },
          { title: '角色', render: (u) => (u.roles?.length ? u.roles.map((r) => `<span class="badge badge-brand no-dot" style="margin-right:4px">${esc(r.name)}</span>`).join('') : '<span class="text-4">未分配</span>') },
          { title: '三方绑定', render: (u) => u.bindings?.length ? u.bindings.map((b) => `<span class="badge badge-purple no-dot">${esc(providerName(b.provider))}</span>`).join(' ') : '<span class="text-4">—</span>' },
          { title: '状态', width: 90, render: (u) => statusBadge(u.status) },
          { title: '最近登录', width: 130, render: (u) => `<span class="fs-12 text-3">${timeAgo(u.lastLoginAt)}</span>` },
        ],
        rows: data.users,
        onRowClick: (id) => openUserDetail(id),
      })
      const holder = $('#member-table')
      holder.innerHTML = ''
      holder.appendChild(table)
    }
    $('#member-q').oninput = debounce(() => void refreshMembers(), 250)
    $('#member-status').onchange = () => void refreshMembers()

    renderTree()
    await refreshMembers()

    function openUserCreate(tree, users) {
      const modal = openModal({
        title: '创建账号', wide: true,
        body: `
          <div class="form-grid">
            ${field('姓名', inputField('displayName'), { required: true })}
            ${field('用户名', inputField('username', { placeholder: '字母数字，如 zhangsan' }), { required: true })}
            ${field('所属组织', selectField('orgId', flattenTree(tree).map((o) => ({ value: o.id, label: '　'.repeat(o.depth) + o.name }))), { required: true })}
            ${field('职位', inputField('title'))}
            ${field('邮箱', inputField('email', { placeholder: '选填，默认 username@yuanbingke.com' }), { full: true })}
          </div>
          <div class="form-hint">创建后将生成随机初始口令（仅展示一次），账号状态为「正常」。</div>`,
        foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>创建</button>',
      })
      modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
      modal.el.querySelector('[data-ok]').onclick = async () => {
        const data = collectForm(modal.body)
        try {
          const result = await api.post('/api/iam/users', data)
          modal.close()
          if (result.initialPassword) {
            showUserCredentials({
              userId: result.id,
              username: result.username,
              displayName: result.displayName,
              password: result.initialPassword,
              onDone: () => ctx.rerender(),
            })
          } else {
            toast('账号已创建'); ctx.rerender()
          }
        } catch (error) { toast(error.message, 'error') }
      }
    }

    function openOrgCreate(tree, parentId) {
      const modal = openModal({
        title: '新建组织',
        body: `
          ${field('上级组织', selectField('parentId', [{ value: '', label: '（作为顶级组织）' }, ...flattenTree(tree).map((o) => ({ value: o.id, label: '　'.repeat(o.depth) + o.name }))], { value: parentId ?? '' }))}
          ${field('组织名称', inputField('name'), { required: true })}`,
        foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>创建</button>',
      })
      modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
      modal.el.querySelector('[data-ok]').onclick = async () => {
        const data = collectForm(modal.body)
        try {
          await api.post('/api/iam/orgs', { name: data.name, parentId: data.parentId || null })
          toast('组织已创建'); modal.close(); ctx.rerender()
        } catch (error) { toast(error.message, 'error') }
      }
    }

    function openUserImport(tree) {
      const modal = openModal({
        title: '批量导入账号',
        body: `
          <div class="form-hint" style="margin-bottom:10px">每行一个账号，格式：<code>用户名,姓名,组织ID,职位</code>（支持 Excel/CSV 导出后粘贴）</div>
          ${field('导入数据', textareaField('raw', { placeholder: 'wangwu,王五,org_xxx,算法工程师\nzhaoliu,赵六,org_xxx,产品经理', rows: 6 }), { full: true })}
          <div class="muted-box" id="import-preview"></div>`,
        foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>导入</button>',
      })
      modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
      modal.el.querySelector('[data-ok]').onclick = async () => {
        const raw = collectForm(modal.body).raw
        const items = raw.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
          const [username, displayName, orgId, title] = line.split(',').map((s) => s?.trim())
          return { username, displayName, orgId, title }
        }).filter((item) => item.username && item.displayName && item.orgId)
        if (!items.length) return toast('没有可导入的数据（检查格式）', 'error')
        try {
          const result = await api.post('/api/iam/users/import', { items })
          toast(`导入完成：新建 ${result.created.length}，跳过 ${result.skipped.length}`)
          modal.close(); ctx.rerender()
        } catch (error) { toast(error.message, 'error') }
      }
    }

    async function openUserDetail(id) {
      const [usersData2, rolesData, tree2] = await Promise.all([
        api.get('/api/iam/users'), api.get('/api/iam/roles'), api.get('/api/iam/orgs/tree'),
      ])
      const user = usersData2.users.find((u) => u.id === id)
      if (!user) return
      const drawer = openDrawer({
        title: user.displayName,
        sub: `@${user.username} · ${user.orgName ?? ''}`,
        body: `
          <div class="flex mb-14" style="gap:14px">
            <div class="avatar lg">${esc(user.displayName.slice(0, 1))}</div>
            <div class="grow">
              <div class="flex" style="gap:8px">${statusBadge(user.status)} <span class="fs-12 text-3">${esc(user.title || '未设置职位')}</span></div>
              <div class="fs-12 text-3 mt-8">${esc(user.email)}${user.phone ? ' · ' + esc(user.phone) : ''}</div>
            </div>
          </div>
          <div class="desc-grid mb-14">
            <div class="desc-item"><span class="k">组织</span><span class="v">${esc(user.orgName ?? '—')}</span></div>
            <div class="desc-item"><span class="k">创建时间</span><span class="v">${timeAgo(user.createdAt)}</span></div>
            <div class="desc-item"><span class="k">最近登录</span><span class="v">${timeAgo(user.lastLoginAt)}</span></div>
            <div class="desc-item"><span class="k">工号</span><span class="v">${esc(user.jobNumber ?? '—')}</span></div>
          </div>
          <div class="card-title mb-8">角色</div>
          <div class="mb-14" id="ud-roles">${user.roles?.map((r) => `<span class="badge badge-brand no-dot" style="margin:0 6px 6px 0">${esc(r.name)}</span>`).join('') || '<span class="text-4 fs-12">未分配角色</span>'}</div>
          <div class="card-title mb-8">三方身份绑定</div>
          <div class="mb-14">${user.bindings?.length ? user.bindings.map((b) => `
            <div class="flex" style="padding:8px 0;border-bottom:1px solid var(--border)">
              <span class="badge badge-purple no-dot">${esc(providerName(b.provider))}</span>
              <span class="fs-12 grow">${esc(b.displayName)}（${esc(b.unionId)}）</span>
              <span class="fs-11 text-4">${timeAgo(b.boundAt)}</span>
            </div>`).join('') : '<span class="text-4 fs-12">未绑定三方身份</span>'}
          </div>`,
        foot: `
          <button class="btn btn-default" id="ud-edit">${icon('edit', 14)}编辑</button>
          <button class="btn btn-default" id="ud-assign">${icon('shield', 14)}分配角色</button>
          <button class="btn btn-default" id="ud-bind">${icon('link', 14)}绑定三方</button>
          <button class="btn btn-default" id="ud-resetpw">${icon('key', 14)}重置口令</button>
          ${user.status === 'active' ? `<button class="btn btn-danger-ghost" id="ud-freeze">${icon('alert', 14)}冻结</button>` : ''}
          ${user.status === 'frozen' ? `<button class="btn btn-primary" id="ud-unfreeze">解除冻结</button>` : ''}
          ${user.status === 'pending' ? `<button class="btn btn-primary" id="ud-activate">激活账号</button>` : ''}`,
      })

      drawer.el.querySelector('#ud-edit').onclick = () => {
        const modal = openModal({
          title: '编辑账号', wide: true,
          body: `
            <div class="form-grid">
              ${field('姓名', inputField('displayName', { value: user.displayName }), { required: true })}
              ${field('职位', inputField('title', { value: user.title }))}
              ${field('邮箱', inputField('email', { value: user.email }))}
              ${field('手机号', inputField('phone', { value: user.phone }))}
              ${field('所属组织', selectField('orgId', flattenTree(tree2).map((o) => ({ value: o.id, label: '　'.repeat(o.depth) + o.name })), { value: user.orgId }), { full: true })}
            </div>`,
          foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>',
        })
        modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
        modal.el.querySelector('[data-ok]').onclick = async () => {
          try {
            await api.patch(`/api/iam/users/${user.id}`, collectForm(modal.body))
            toast('已保存'); modal.close(); drawer.close(); ctx.rerender()
          } catch (error) { toast(error.message, 'error') }
        }
      }
      drawer.el.querySelector('#ud-assign').onclick = () => {
        const modal = openModal({
          title: '分配角色',
          body: rolesData.roles.map((role) => `
            <label class="flex" style="padding:10px 4px;border-bottom:1px solid var(--border);cursor:pointer">
              <input type="checkbox" name="role" value="${esc(role.id)}" ${user.roleIds.includes(role.id) ? 'checked' : ''} ${role.builtin && user.roleIds.includes(role.id) ? '' : ''} style="accent-color:var(--brand-500)">
              <div class="grow">
                <div class="fs-13" style="font-weight:500">${esc(role.name)} ${role.builtin ? '<span class="badge badge-muted no-dot">内置</span>' : ''}</div>
                <div class="fs-12 text-3">${esc(role.description)}</div>
              </div>
            </label>`).join(''),
          foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>',
        })
        modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
        modal.el.querySelector('[data-ok]').onclick = async () => {
          const roleIds = [...modal.body.querySelectorAll('input[name=role]:checked')].map((el) => el.value)
          try {
            await api.patch(`/api/iam/users/${user.id}`, { roleIds })
            toast('角色已更新（权限点实时生效）'); modal.close(); drawer.close(); ctx.rerender()
          } catch (error) { toast(error.message, 'error') }
        }
      }
      drawer.el.querySelector('#ud-bind').onclick = async () => {
        // 钉钉 real 模式下优先扫码授权绑定（自动识别身份，不手工输入 unionId）；
        // 手工录入降级为备用（mock/演示/其他平台）。
        let dingtalkReal = false
        try {
          const data = await api.get('/api/iam/connectors')
          dingtalkReal = Boolean((data?.configs ?? []).find((c) => c.provider === 'dingtalk' && c.enabled && c.mode === 'real'))
        } catch { /* 查询失败时仅提供手工录入 */ }
        const modal = openModal({
          title: '绑定三方身份',
          body: `
            ${field('三方平台', selectField('provider', [{ value: 'dingtalk', label: '钉钉' }, { value: 'feishu', label: '飞书' }, { value: 'wecom', label: '企业微信' }]))}
            <div id="bind-oauth" ${dingtalkReal ? '' : 'style="display:none"'}>
              <div class="muted-box mb-14" style="display:flex;gap:8px;border-color:var(--brand-200);background:var(--brand-50)">
                ${icon('info', 15)}<span>无需填写任何 ID：点击按钮跳转钉钉授权，本机已登录钉钉将自动识别身份，未登录则扫码确认，授权后自动完成绑定。</span>
              </div>
              <button class="btn btn-primary btn-block" id="bind-oauth-go">${icon('link', 14)}钉钉扫码授权绑定</button>
            </div>
            <details id="bind-manual-wrap" ${dingtalkReal ? '' : 'open'} style="margin-top:${dingtalkReal ? '14px' : '0'}">
              <summary class="fs-12 text-3" style="cursor:pointer;margin-bottom:10px">管理员手动绑定（备用）</summary>
              ${field('三方 unionId', inputField('unionId', { placeholder: '如 dd_u002' }), { required: !dingtalkReal })}
              ${field('三方昵称', inputField('displayName'))}
              ${field('二次验证码', inputField('verifyCode', { placeholder: '演示环境任意 6 位数字' }), { hint: '一人一号原则：同一三方身份只能绑定一个平台账号' })}
              <button class="btn btn-default btn-block" id="bind-manual-go">手动绑定</button>
            </details>`,
          foot: '<button class="btn btn-default" data-cancel>关闭</button>',
        })
        modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
        const providerValue = () => modal.body.querySelector('[name="provider"]')?.value ?? 'dingtalk'
        modal.el.querySelector('#bind-oauth-go')?.addEventListener('click', async (e) => {
          const btn = e.currentTarget
          btn.classList.add('btn-loading')
          try {
            if (providerValue() !== 'dingtalk') throw new Error('扫码授权绑定当前仅支持钉钉')
            const auth = await api.post('/api/auth/sso/bind/authorize', { provider: 'dingtalk', targetUserId: user.id })
            if (!auth.authorizeUrl) throw new Error('身份源未返回授权地址（可能为 mock 模式），请改用手动绑定')
            // 必须整页跳转：弹窗/iframe 会被第三方 Cookie 策略拦截导致授权失败
            window.location.href = auth.authorizeUrl
          } catch (error) {
            toast(error.message, 'error')
            btn.classList.remove('btn-loading')
          }
        })
        modal.el.querySelector('#bind-manual-go')?.addEventListener('click', async () => {
          try {
            await api.post(`/api/iam/users/${user.id}/bindings`, { ...collectForm(modal.body), verifyCode: collectForm(modal.body).verifyCode || '123456' })
            toast('绑定成功'); modal.close(); drawer.close(); ctx.rerender()
          } catch (error) { toast(error.message, 'error') }
        })
      }
      drawer.el.querySelector('#ud-resetpw').onclick = async () => {
        const confirmed = await confirmDialog({
          title: '重置口令', danger: true, confirmText: '确认重置',
          message: `将为 <b>${esc(user.displayName)}</b> 生成新的随机口令，原口令立即失效。新口令仅展示一次，请准备传达给本人。`,
        })
        if (!confirmed) return
        try {
          const result = await api.post(`/api/iam/users/${user.id}/reset-password`)
          showUserCredentials({
            userId: user.id,
            username: result.username ?? user.username,
            displayName: user.displayName,
            password: result.initialPassword,
          })
        } catch (error) { toast(error.message, 'error') }
      }
      const freezeBtn = drawer.el.querySelector('#ud-freeze')
      if (freezeBtn) freezeBtn.onclick = async () => {
        const result = await confirmDialog({
          title: '冻结账号', danger: true, requireReason: true, confirmText: '确认冻结',
          message: `冻结 <b>${esc(user.displayName)}</b> 后：其名下全部访问令牌将被立即吊销，无法登录任何入口。`,
        })
        if (!result) return
        try {
          await api.post(`/api/iam/users/${user.id}/freeze`, { reason: result.reason })
          toast('已冻结并吊销全部令牌'); drawer.close(); ctx.rerender()
        } catch (error) { toast(error.message, 'error') }
      }
      const unfreezeBtn = drawer.el.querySelector('#ud-unfreeze')
      if (unfreezeBtn) unfreezeBtn.onclick = async () => {
        await api.post(`/api/iam/users/${user.id}/unfreeze`, {})
        toast('已解除冻结'); drawer.close(); ctx.rerender()
      }
      const activateBtn = drawer.el.querySelector('#ud-activate')
      if (activateBtn) activateBtn.onclick = async () => {
        await api.post(`/api/iam/users/${user.id}/activate`, {})
        toast('账号已激活'); drawer.close(); ctx.rerender()
      }
    }
  }

  // ------------------------------------------------------------------
  async function renderRoles() {
    $('#iam-actions').innerHTML = `<button class="btn btn-primary" id="role-add">${icon('plus', 14)}新建角色</button>`
    const data = await api.get('/api/iam/roles')
    const groups = new Map()
    for (const perm of data.catalog) {
      if (!groups.has(perm.group)) groups.set(perm.group, [])
      groups.get(perm.group).push(perm)
    }
    const body = $('#iam-body')
    body.innerHTML = `
      <div class="grid-2" style="grid-template-columns:1fr 1.2fr;align-items:start">
        <div class="card table-wrap">
          <table class="tbl">
            <thead><tr><th>角色</th><th>类型</th><th>权限数</th></tr></thead>
            <tbody id="role-rows"></tbody>
          </table>
        </div>
        <div class="card card-pad" id="perm-panel"><span class="text-4 fs-13">← 点击左侧角色查看权限点矩阵</span></div>
      </div>`
    const rowsEl = $('#role-rows')
    data.roles.forEach((role) => {
      const tr = h(`<tr>
        <td><div class="col-strong">${esc(role.name)}</div><div class="col-sub mono">${esc(role.code)}</div></td>
        <td>${role.builtin ? '<span class="badge badge-muted no-dot">内置</span>' : '<span class="badge badge-brand no-dot">自定义</span>'}</td>
        <td class="col-num">${role.permissions.includes('*') ? '全部' : role.permissions.length}</td>
      </tr>`)
      tr.onclick = () => renderPermPanel(role)
      rowsEl.appendChild(tr)
    })
    /** 角色表单弹窗：role 为空为新建，传入 role 为编辑（code 不可改，预填并回显权限勾选）。 */
    const openRoleModal = (role) => {
      const isEdit = !!role
      const has = (point) => role && (role.permissions.includes('*') || role.permissions.includes(point) || role.permissions.some((p) => p.endsWith('.*') && point.startsWith(p.slice(0, -1))))
      const modal = openModal({
        title: isEdit ? `编辑角色：${esc(role.name)}` : '新建角色', wide: true,
        body: `
          <div class="form-grid">
            ${field('角色名称', inputField('name', { value: role?.name ?? '' }), { required: true })}
            ${isEdit ? field('角色 code', `<code class="mono" style="line-height:32px">${esc(role.code)}</code>`, { hint: 'code 创建后不可修改' }) : field('角色 code', inputField('code', { placeholder: '小写字母，如 data_steward' }), { required: true })}
            ${field('描述', inputField('description', { value: role?.description ?? '' }), { full: true })}
          </div>
          <div class="card-title mb-8">权限点（菜单 + API + 数据范围）</div>
          <div style="max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px" id="new-role-perms">
            ${[...groups.entries()].map(([group, perms]) => `
              <div style="padding:6px 4px">
                <div class="fs-12" style="font-weight:600;color:var(--text-2)">${esc(group)}</div>
                ${perms.map((p) => `<label class="flex" style="padding:3px 0;font-size:12.5px;cursor:pointer">
                  <input type="checkbox" name="perm" value="${esc(p.point)}" ${has(p.point) ? 'checked' : ''} style="accent-color:var(--brand-500)">
                  <span>${esc(p.label)}</span><span class="mono text-4" style="margin-left:auto">${esc(p.point)}</span>
                </label>`).join('')}
              </div>`).join('')}
          </div>`,
        foot: `<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>${isEdit ? '保存' : '创建'}</button>`,
      })
      modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
      modal.el.querySelector('[data-ok]').onclick = async () => {
        const data2 = collectForm(modal.body)
        const permissions = [...modal.body.querySelectorAll('input[name=perm]:checked')].map((el) => el.value)
        try {
          if (isEdit) {
            await api.patch(`/api/iam/roles/${role.id}`, { name: data2.name, description: data2.description, permissions })
            toast('角色已更新（权限实时生效）')
          } else {
            await api.post('/api/iam/roles', { name: data2.name, code: data2.code, description: data2.description, permissions })
            toast('角色已创建')
          }
          modal.close(); ctx.rerender()
        } catch (error) { toast(error.message, 'error') }
      }
    }
    $('#role-add').onclick = () => openRoleModal(null)

    function renderPermPanel(role) {
      const panel = $('#perm-panel')
      const has = (point) => role.permissions.includes('*') || role.permissions.includes(point) || role.permissions.some((p) => p.endsWith('.*') && point.startsWith(p.slice(0, -1)))
      panel.innerHTML = `
        <div class="flex-between mb-14">
          <div>
            <div class="card-title">${esc(role.name)} ${role.builtin ? '<span class="badge badge-muted no-dot">内置</span>' : ''}</div>
            <div class="fs-12 text-3 mt-8">${esc(role.description)}</div>
          </div>
          ${role.builtin ? '' : `<button class="btn btn-default btn-sm" id="role-edit">${icon('edit', 13)}编辑角色</button>`}
        </div>
        ${[...groups.entries()].map(([group, perms]) => `
          <div style="margin-bottom:12px">
            <div class="fs-12" style="font-weight:600;color:var(--text-2);margin-bottom:4px">${esc(group)}</div>
            ${perms.map((p) => `
              <div class="flex" style="padding:4px 0;font-size:12.5px">
                <span style="color:${has(p.point) ? 'var(--ok)' : 'var(--text-4)'}">${icon(has(p.point) ? 'check' : 'x', 13)}</span>
                <span class="${has(p.point) ? '' : 'text-4'}">${esc(p.label)}</span>
                <span class="mono text-4" style="margin-left:auto">${esc(p.point)}</span>
              </div>`).join('')}
          </div>`).join('')}`
      const editBtn = panel.querySelector('#role-edit')
      if (editBtn) editBtn.onclick = () => openRoleModal(role)
    }
  }

  // ------------------------------------------------------------------
  async function renderGroups() {
    $('#iam-actions').innerHTML = `<button class="btn btn-primary" id="group-add">${icon('plus', 14)}新建用户组</button>`
    const [data, treeData] = await Promise.all([api.get('/api/iam/groups'), api.get('/api/iam/orgs/tree')])
    const body = $('#iam-body')
    if (!data.groups.length) {
      body.innerHTML = ''
      body.appendChild(emptyState({ title: '还没有用户组', desc: '用户组是授权的最小单位——静态组手工圈人，动态组按规则自动圈人', actionText: '新建用户组', onAction: () => $('#group-add').click() }))
    } else {
      body.innerHTML = `<div id="group-list"></div>`
      const list = $('#group-list')
      for (const group of data.groups) {
        const card = h(`
          <div class="card card-pad mb-14">
            <div class="flex-between mb-8">
              <div class="flex">
                <span class="badge ${group.type === 'dynamic' ? 'badge-purple' : 'badge-brand'} no-dot">${group.type === 'dynamic' ? '动态组' : '静态组'}</span>
                <span style="font-weight:600">${esc(group.name)}</span>
                <span class="fs-12 text-3">${esc(group.description || '')}</span>
              </div>
              <div class="flex">
                <button class="btn btn-ghost btn-sm" data-edit>${icon('edit', 13)}编辑</button>
                <button class="btn btn-ghost btn-sm" style="color:var(--danger)" data-del>${icon('trash', 13)}</button>
              </div>
            </div>
            <div class="flex" style="flex-wrap:wrap;gap:6px">
              ${group.resolvedMembers.slice(0, 12).map((m) => `<span class="badge badge-muted no-dot">${icon('user', 12)}${esc(m.displayName)}</span>`).join('')}
              ${group.resolvedMembers.length > 12 ? `<span class="fs-12 text-4">等 ${group.resolvedMembers.length} 人</span>` : ''}
              ${group.resolvedMembers.length === 0 ? '<span class="fs-12 text-4">暂无成员（动态组按规则实时圈人）</span>' : ''}
            </div>
          </div>`)
        card.querySelector('[data-edit]').onclick = () => openGroupEditor(group, treeData)
        card.querySelector('[data-del]').onclick = async () => {
          const result = await confirmDialog({ title: '删除用户组', message: `删除「${esc(group.name)}」后，基于该组的授权（MCP 权限组等）将同步失效。`, danger: true })
          if (!result) return
          await api.delete(`/api/iam/groups/${group.id}`)
          toast('已删除'); ctx.rerender()
        }
        list.appendChild(card)
      }
    }
    $('#group-add').onclick = () => openGroupEditor(null, treeData)

    function openGroupEditor(group, tree) {
      const modal = openModal({
        title: group ? '编辑用户组' : '新建用户组', wide: true,
        body: `
          <div class="form-grid">
            ${field('名称', inputField('name', { value: group?.name }), { required: true })}
            ${field('类型', selectField('type', [{ value: 'static', label: '静态组（手工维护）' }, { value: 'dynamic', label: '动态组（按规则自动圈人）' }], { value: group?.type ?? 'static' }), { required: true })}
            ${field('描述', inputField('description', { value: group?.description }), { full: true })}
          </div>
          <div class="form-hint" style="margin:0 0 10px">动态组规则：按部门子树 + 职位过滤，实时生效</div>
          <div class="form-grid">
            ${field('圈人部门（动态组）', selectField('ruleOrgId', [{ value: '', label: '（不限）' }, ...flattenTree(tree).map((o) => ({ value: o.id, label: '　'.repeat(o.depth) + o.name }))], { value: group?.rule?.orgIds?.[0] ?? '' }))}
            ${field('职位过滤（动态组）', inputField('ruleTitle', { value: group?.rule?.title, placeholder: '如：算法工程师' }))}
          </div>`,
        foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>',
      })
      modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
      modal.el.querySelector('[data-ok]').onclick = async () => {
        const data2 = collectForm(modal.body)
        const payload = {
          name: data2.name,
          type: data2.type,
          description: data2.description,
          ...(data2.type === 'dynamic' ? { rule: { ...(data2.ruleOrgId ? { orgIds: [data2.ruleOrgId] } : {}), ...(data2.ruleTitle ? { title: data2.ruleTitle } : {}) } } : {}),
        }
        try {
          if (group) await api.patch(`/api/iam/groups/${group.id}`, payload)
          else await api.post('/api/iam/groups', payload)
          toast('已保存'); modal.close(); ctx.rerender()
        } catch (error) { toast(error.message, 'error') }
      }
    }
  }

  // ------------------------------------------------------------------
  async function renderConnectors(params2, ctx2) {
    $('#iam-actions').innerHTML = ''
    const [data] = await Promise.all([api.get('/api/iam/connectors')])
    const body = $('#iam-body')
    const config = data.configs.find((c) => c.provider === 'dingtalk')
    // 回调地址按当前访问地址自动生成（与后端发起授权时按 Host 头拼接的 redirect_uri 一致），
    // 直接复制到钉钉开发者后台的登录重定向地址即可，无需手填。
    const callbackUrl = `${location.origin.replace(/\/+$/, '')}/api/auth/sso`
    body.innerHTML = `
      <div class="card mb-20">
        <div class="card-head">
          <span class="card-title">${icon('link', 15)} 钉钉通讯录同步</span>
          ${config?.enabled ? '<span class="badge badge-ok">已启用</span>' : '<span class="badge badge-muted">未启用</span>'}
          <div class="card-head-actions">
            <button class="btn btn-default btn-sm" id="conn-test">${icon('wifi', 13)}连通性自检</button>
            <button class="btn btn-primary btn-sm" id="conn-sync">${icon('refresh', 13)}立即同步</button>
          </div>
        </div>
        <div class="card-body">
          <div class="grid-3 mb-14">
            ${syncStatCard('最近同步', config?.lastSyncAt ? timeAgo(config.lastSyncAt) : '从未同步', config?.lastSyncResult?.ok ? 'var(--ok)' : 'var(--text-3)')}
            ${syncStatCard('同步结果', config?.lastSyncResult ? config.lastSyncResult.message : '—', 'var(--text-1)')}
            ${syncStatCard('同步频率', config ? `每 ${config.intervalMinutes} 分钟` : '—', 'var(--text-1)')}
          </div>
          <div class="desc-grid">
            <div class="desc-item"><span class="k">CorpID</span><span class="v mono">${esc(config?.corpId ?? '未配置')}</span></div>
            <div class="desc-item"><span class="k">AppKey</span><span class="v mono">${esc(config?.appKey ?? '未配置')}</span></div>
            <div class="desc-item"><span class="k">AppSecret</span><span class="v mono">${esc(config?.secretMasked ?? '—')} <span class="text-4">（KMS 加密存储）</span></span></div>
            <div class="desc-item"><span class="k">扫码登录</span><span class="v">${config?.loginEnabled ? '已开启' : '未开启'}</span></div>
            <div class="desc-item"><span class="k">回调地址</span><span class="v mono">${esc(callbackUrl)}</span></div>
            <div class="desc-item"><span class="k">冲突策略</span><span class="v">${strategyName(config?.conflictStrategy)}</span></div>
          </div>
          <div class="flex mt-14">
            <button class="btn btn-default btn-sm" id="conn-edit">${icon('settings', 13)}接入配置</button>
          </div>
        </div>
      </div>`

    $('#conn-test').onclick = async (e) => {
      const btn = e.currentTarget
      btn.classList.add('btn-loading')
      try {
        const result = await api.post('/api/iam/connectors/dingtalk/test')
        toast(`${result.message}（${result.latencyMs}ms）`)
      } catch (error) { toast(error.message, 'error') } finally { btn.classList.remove('btn-loading') }
    }
    $('#conn-sync').onclick = async (e) => {
      const btn = e.currentTarget
      btn.classList.add('btn-loading')
      try {
        const result = await api.post('/api/iam/connectors/dingtalk/sync')
        toast(result.message)
        setTimeout(() => ctx2.rerender(), 600)
      } catch (error) { toast(error.message, 'error') } finally { btn.classList.remove('btn-loading') }
    }
    $('#conn-edit').onclick = () => {
      const modal = openModal({
        title: '钉钉接入配置', wide: true,
        body: `
          <div class="form-grid">
            ${field('CorpID', inputField('corpId', { value: config?.corpId }), { required: true })}
            ${field('AppKey', inputField('appKey', { value: config?.appKey }), { required: true })}
            ${field('AppSecret', inputField('appSecret', { value: '', placeholder: '留空保持不变（加密存储）' }), { hint: '通过 KMS 托管加密，禁止明文落库' })}
            ${field('同步频率（分钟）', inputField('intervalMinutes', { value: config?.intervalMinutes ?? 60 }))}
            ${field('回调地址（自动生成）', `
              <div class="flex" style="gap:8px">
                <input class="input" name="callbackUrl" readonly value="${esc(callbackUrl)}" style="flex:1">
                <button class="btn btn-default" id="conn-copy-callback">${icon('copy', 13)}复制</button>
              </div>`, { full: true, hint: '按当前访问地址生成，请将其配置到钉钉开发者后台对应应用的登录重定向地址（redirect URI）' })}
            ${field('冲突处理策略', selectField('conflictStrategy', [
              { value: 'manual', label: '人工确认（推荐）' },
              { value: 'third_party_wins', label: '以三方为准' },
              { value: 'platform_wins', label: '以平台为准' },
            ], { value: config?.conflictStrategy ?? 'manual' }))}
            ${field(' ', `<label class="flex"><input type="checkbox" name="loginEnabled" ${config?.loginEnabled ? 'checked' : ''} style="accent-color:var(--brand-500)"> 允许钉钉扫码登录控制台</label>`)}
          </div>`,
        foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>',
      })
      modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
      modal.el.querySelector('#conn-copy-callback').onclick = () => {
        void navigator.clipboard?.writeText(callbackUrl).then(() => toast('已复制'))
      }
      modal.el.querySelector('[data-ok]').onclick = async () => {
        const data2 = collectForm(modal.body)
        try {
          await api.put('/api/iam/connectors/dingtalk', { ...data2, intervalMinutes: Number(data2.intervalMinutes) || 60 })
          toast('配置已更新（变更已审计）'); modal.close(); ctx2.rerender()
        } catch (error) { toast(error.message, 'error') }
      }
    }

    if (params2.get('action') === 'sync') {
      void api.post('/api/iam/connectors/dingtalk/sync').then((r) => toast(r.message)).catch((e) => toast(e.message, 'error'))
      location.hash = '#/iam?tab=connectors'
    }
  }

  // ------------------------------------------------------------------
  async function renderConflicts() {
    const data = await api.get('/api/iam/conflicts')
    const pending = data.conflicts
    $('#conflict-count').textContent = String(pending.length)
    $('#iam-actions').innerHTML = ''
    const body = $('#iam-body')
    if (!pending.length) {
      body.innerHTML = ''
      body.appendChild(emptyState({ title: '没有待处理的同步冲突', desc: '三方通讯录与平台数据一致，或冲突均已处理', icon: 'shieldCheck' }))
      return
    }
    for (const conflict of pending) {
      const card = h(`
        <div class="card card-pad mb-14">
          <div class="flex-between mb-14">
            <div class="flex">
              <span class="badge badge-warn">${esc(conflict.kind === 'user_attr' ? '属性差异' : conflict.kind)}</span>
              <span class="fs-12 text-3">来源：${esc(providerName(conflict.provider))} · ${timeAgo(conflict.createdAt)}</span>
            </div>
          </div>
          <div class="grid-2">
            <div style="border:1px solid var(--warn-border);background:var(--warn-bg);border-radius:10px;padding:14px">
              <div class="fs-12" style="font-weight:600;color:#b45309;margin-bottom:8px">三方数据（钉钉）</div>
              ${diffRows(conflict.thirdPartyData)}
            </div>
            <div style="border:1px solid var(--border);background:var(--surface-2);border-radius:10px;padding:14px">
              <div class="fs-12" style="font-weight:600;margin-bottom:8px">平台数据</div>
              ${diffRows(conflict.platformData)}
            </div>
          </div>
          <div class="flex mt-14" style="justify-content:flex-end">
            <button class="btn btn-default" data-keep="platform">保留平台</button>
            <button class="btn btn-primary" data-keep="third_party">以三方为准</button>
          </div>
        </div>`)
      card.querySelectorAll('[data-keep]').forEach((btn) => {
        btn.onclick = async () => {
          await api.post(`/api/iam/conflicts/${conflict.id}/resolve`, { keep: btn.dataset.keep })
          toast('冲突已处理')
          ctx.rerender()
        }
      })
      body.appendChild(card)
    }
    function diffRows(data) {
      return Object.entries(data ?? {}).filter(([k]) => k !== 'jobNumber').map(([k, v]) => `
        <div class="flex" style="padding:3px 0;font-size:12.5px">
          <span class="text-4" style="width:64px">${fieldName(k)}</span><span>${esc(String(v ?? '—'))}</span>
        </div>`).join('')
    }
  }
}

// ---------- helpers ----------
function providerName(provider) {
  return { dingtalk: '钉钉', feishu: '飞书', wecom: '企业微信' }[provider] ?? provider
}
function strategyName(strategy) {
  return { manual: '人工确认', third_party_wins: '以三方为准', platform_wins: '以平台为准' }[strategy] ?? strategy
}
function fieldName(key) {
  return { displayName: '姓名', title: '职位', orgId: '部门', orgName: '部门', unionId: '三方ID' }[key] ?? key
}
function syncStatCard(label, value, color) {
  return `
    <div style="background:var(--surface-2);border-radius:10px;padding:14px 16px">
      <div class="fs-12 text-3">${esc(label)}</div>
      <div style="font-size:16px;font-weight:600;color:${color};margin-top:4px">${esc(value)}</div>
    </div>`
}
function flattenTree(nodes, depth = 0, out = []) {
  for (const node of nodes ?? []) {
    out.push({ id: node.id, name: node.name, depth })
    flattenTree(node.children ?? [], depth + 1, out)
  }
  return out
}
function debounce(fn, ms) {
  let timer
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms) }
}
