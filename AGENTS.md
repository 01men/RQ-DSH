# AGENTS.md —— 新会话/新开发者必读：本仓库工作方式与同步铁律

> 每个新会话（agent 窗口）、每位新开发者在做任何 git 操作前，先完整读完本文件。
> 本文件是定制化分支的**最高行为约束**，与 `PROJECT.md`（项目背景）配套；
> 冲突时以本文件为准。设计全文见 `docs/dev-plan-agent-host-unification.md`。

## 这个仓库是什么

`D:\DSH-RQ` 是围绕上游平台 `01men/ybkk-AIOS`（榕器 · 企业AI资源管理平台）的**定制化项目工作区**，
在定制分支 `custom/dsh-rq` 上开发，永不合并回上游主分支。

## 仓库同步铁律（违反任何一条即为事故）

1. **唯一开发分支是 `custom/dsh-rq`**。一切开发、提交都在它上面；不要在本地 `main` 上开发
   （本地 `main` 只是上游镜像，只快进、不开发）。
2. **上游 `01men/ybkk-AIOS` 只读**：只 `fetch`，绝不 `push`。定制代码回流上游 main = 主分支污染，
   是本项目最严重的事故。
3. **`01men/RQ-DSH` 是唯一推送目标（备份仓库）**：`custom/dsh-rq` 的全部提交（含合并提交）
   都要推送到它的 `main`。推送即备份，交付未推送 = 未交付。
4. **方向唯一**：同步永远是 `上游 main → custom/dsh-rq`（merge 进定制分支），
   绝不存在反向（`custom/dsh-rq → 上游 main`）。
5. **冲突以主分支为准**：合并上游时，同一处双方都改过的代码以上游实现为准吸收；
   定制分支**独有特性**（单进程挂载 dsh-bridge / OIDC-agent 门禁 / 身份绑定免登 /
   register-dsh-agent 登记脚本等，见 `docs/dev-plan-agent-host-unification.md`）必须保留。
6. **合并必须全量回归**：每次合并上游后跑 `npm run selftest`（当前 737+ 项）与
   `npm run lint:manifests`，全绿才能推送备份。

## 标准同步节奏（上游有更新时）

```bash
git fetch origin main                      # 拉上游（origin fetch 指向 ybkk-AIOS）
git log --oneline custom/dsh-rq..origin/main   # 看上游新增了什么
git merge origin/main                      # 合并进定制分支（冲突按铁律 5 解决）
npm run selftest && npm run lint:manifests # 全量回归，必须全绿
git push                                   # 备份（origin push 指向 RQ-DSH，自动推到其 main）
```

## 远程配置（已固化，不要改动）

```
origin  fetch → https://github.com/01men/ybkk-AIOS.git   # 上游，只进不出
origin  push  → https://github.com/01men/RQ-DSH.git      # 备份，push 即备份到其 main
```

- 默认 `git push` 经 `remote.origin.push = refs/heads/custom/dsh-rq:refs/heads/main`
  自动把定制分支推到 RQ-DSH 的 main——不要改这个 refspec。
- 已知无害怪象：`origin/main` 追踪引用在「push 后=备份仓库的 main」与「fetch 后=上游 main」
  之间摇摆（fetch/push 分离的副作用）。判断同步状态永远以 `git ls-remote` 两仓库实测为准。
- 本地已装 `.git/hooks/pre-push` 钩子（脚本版本化在 `scripts/hooks/pre-push`）：
  任何指向 ybkk-AIOS 的推送会被**直接拦截**。换机器/重克隆后需重装：
  `cp scripts/hooks/pre-push .git/hooks/pre-push && chmod +x .git/hooks/pre-push`

## 网络说明

本机访问 GitHub 需走本地代理 `127.0.0.1:7890`，已配置 git 仅对 github.com 生效：

```bash
git config --global http.https://github.com.proxy http://127.0.0.1:7890
```
