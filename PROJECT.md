# DSH-RQ 定制化项目说明

1. 本目录要围绕仓库 https://github.com/01men/ybkk-AIOS.git 开发一条子分支，该分支为定制化项目，无需合并到主分支
2. 本工作区备份推送仓库：01men/RQ-DSH

## ⛔ 仓库同步铁律（最高约束）

**新会话/新开发者第一步：读完根目录 [AGENTS.md](AGENTS.md)。**
铁律摘要（全文以 AGENTS.md 为准）：唯一开发分支 `custom/dsh-rq`；上游 ybkk-AIOS 只读不推
（定制代码回流 main = 最严重事故，pre-push 钩子已硬拦截）；RQ-DSH 是唯一推送目标（push 即备份）；
同步方向唯一（上游 main → 定制分支），冲突以主分支为准、定制特性必须保留；合并后 selftest
全绿才能推送备份。

## 环境布局（初始化于 2026-09-02）

| 项 | 值 |
|---|---|
| 工作区 | `D:\DSH-RQ`（即本仓库检出根目录） |
| 源仓库（fetch/pull） | `https://github.com/01men/ybkk-AIOS.git`（remote `origin` fetch） |
| 备份推送仓库（push） | `https://github.com/01men/RQ-DSH.git`（remote `origin` push，仅 `main` 一个分支） |
| 定制化子分支 | `custom/dsh-rq`（基于 `main` 创建，只在本分支开发，不合并回 `main`） |

远程配置方式（push 地址与 fetch 地址分离 + 默认推送目标映射到备份仓库 main）：

```bash
git remote set-url --push origin https://github.com/01men/RQ-DSH.git
git config remote.origin.push refs/heads/custom/dsh-rq:refs/heads/main
```

日常操作约定：

- 同步上游：`git pull origin main`（仅用于拉取上游更新，定制改动始终留在 `custom/dsh-rq`）
- 备份推送：直接 `git push`（自动把本地 `custom/dsh-rq` 推到 01men/RQ-DSH 的 `main`）
- RQ-DSH 原有主分支已于 2026-09-02 删除，其 `main` 即本分支的完整备份，无需合并回 ybkk-AIOS

## 网络说明

本机访问 GitHub 需要走本地代理（`127.0.0.1:7890`），已配置 git 仅对 github.com 生效的代理，不影响其他 git 源：

```bash
git config --global http.https://github.com.proxy http://127.0.0.1:7890
```
