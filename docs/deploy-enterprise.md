# 企业部署与 Agent 一键接入指引

> 适用对象：基于 **DeepSeek Harness（dsh）** 为企业部署本仓库（衡 · 企业 AI 资源统一管理平台）的工程师，
> 以及希望把部署/接入工作**直接下达给 dsh 自带 Agent 自动完成**的使用者。
> 日常运维（非部署）的 Agent 指引见 `skills/dsh-ops-admin/SKILL.md`（总控索引）。

---

## 一、部署形态与拓扑

| 形态 | 进程 | 说明 | 适用 |
|---|---|---|---|
| A. 独立宿主（默认） | `node src/main.ts` | 一个进程提供 REST 网关 + 控制台 SPA + 37 运维工具桥 | 企业生产最小形态，控制台人工使用 |
| B. 独立宿主 + dsh 运行时 | A 的进程 + `dsh web --patch cordis.yml` | dsh 侧插件树对模型暴露 37 个运维工具，Agent 可用自然语言运维平台；两进程**共享同一 `data/` 目录** | 需要 Agent 驱动运维的企业 |

> 关键事实：`cordis.yml` 不挂载 console 插件——控制台 SPA 与 REST 始终由独立宿主进程提供；
> dsh 侧只挂业务插件（`provideToolRuntime: false`，使用 dsh 原生 ToolRuntime）。
> 因此**形态 B 也必须先完成形态 A**。

环境要求：Node ≥ 22.6（原生 TypeScript 运行，无构建步骤）；数据落盘在 `--data` 指定目录
（JSON 集合 + SQLite `txnstore.db`）。

---

## 二、人工部署 runbook（形态 A）

```bash
# 1. 获取代码
git clone <仓库地址> ops-platform && cd ops-platform

# 2. 安装依赖
npm install

# 3. 生产初始化（关键：绝不在生产设置 DEMO_SEED=1）
#    admin 口令必须显式指定，否则随机生成一次性写入 data/admin-initial-password.txt
export ADMIN_PASSWORD='<强口令>'          # Windows PowerShell: $env:ADMIN_PASSWORD='...'
npm start -- --port 7300 --data ./data    # 首次启动执行基线初始化（内置角色+根组织+admin，零演示数据）

# 4. 验证
curl -X POST localhost:7300/api/auth/login -H 'content-type: application/json' \
     -d '{"username":"admin","password":"<口令>"}'        # 应返回 token
npm run selftest                                          # 207 项断言（隔离实例，不碰生产数据）
npm run lint:manifests                                    # 50 项清单校验
```

进程守护（Linux systemd 示例）：

```ini
# /etc/systemd/system/ops-platform.service
[Service]
WorkingDirectory=/opt/ops-platform
Environment=ADMIN_PASSWORD=<强口令>
ExecStart=/usr/bin/node src/main.ts --port 7300 --data /opt/ops-platform/data
Restart=always
```

运维要点：

- **备份**：冷备整个 `--data` 目录即可（JSON 原子落盘 + SQLite WAL）。资金/计量数据在 `txnstore.db`。
- **升级**：`git pull && npm install && systemctl restart ops-platform`；先跑 `npm run selftest` 再切换流量。
- **对外发布**：用 Nginx 等反代 7300 并做 TLS；平台自身按 Bearer 令牌鉴权。
- **企业定制**（按需）：钉钉真实连接器（`mode: real` + `apiBase`，控制台「组织与账号 → 三方集成」配置）；
  OIDC 对外声明 `OIDC_ISSUER` 环境变量；OIDC 私钥生产建议迁 KMS。
- **资金边界**：支付/对公/开票通道为手工过渡态，接入前请阅读 README「三A 资金红线」。

## 三、dsh 运行时接入（形态 B，启用 Agent 运维）

前提：deepseek-harness 源码检出可用（`pnpm dsh web`）。

```bash
# 1. 生成接入 overlay（替换 <PROJECT_ROOT> 为本仓库绝对路径）
sed 's|<PROJECT_ROOT>|/opt/ops-platform|g' cordis.yml > /tmp/ops-overlay.yml

# 2. 在 deepseek-harness 检出中启动（与独立宿主共享 data/，两进程同时在线）
pnpm dsh web --patch /tmp/ops-overlay.yml
```

Agent 运维凭据（环境变量）：`DSHCTL_URL`（默认 `http://127.0.0.1:7300`）、
`DSHCTL_USER` / `DSHCTL_PASS`（建议 ops 类账号，勿用 admin 常驻）、或 `DSHCTL_TOKEN`。
日常运维让 Agent 读 `skills/dsh-ops-admin/SKILL.md` 即可（诊断→取证→dry-run 预演→执行→验证闭环，L4 高危操作自动走双人审批）。

---

## 四、Agent 一键下达指引（可直接整段粘贴给 dsh 自带 Agent）

> 使用方法：把下面整段指令发给 dsh Agent，替换 `<...>` 占位符；Agent 将自行完成部署与验证并回报结果。
> 生产环境请先人工确认占位符与口令强度；指令内置护栏（禁演示数据、不覆盖已有数据目录、高危操作走审批）。

```text
【任务】在 <目标服务器，如 10.0.0.5 或本机> 上部署「衡 · 企业 AI 资源统一管理平台」并完成验证。
仓库：<git 克隆地址，如 git@github.com:01men/ybkk-AIOS.git>；部署目录：<如 /opt/ops-platform>；
监听端口：<7300>；管理员口令：<ADMIN_PASSWORD 强口令>；部署后是否接入 dsh 运行时：<是/否>。

【执行步骤】
1. 环境检查：确认 Node ≥ 22.6（node -v）。不满足则停止并回报，不要自行升级系统 Node。
2. 获取代码：克隆（或若目录已存在则 git pull）到部署目录；记录当前 commit hash。
3. 安装依赖：npm install。
4. 生产初始化：设置 ADMIN_PASSWORD 环境变量；以 --port <端口> --data <部署目录>/data 启动
   （优先用 systemd/PM2 守护）。铁律：绝不设置 DEMO_SEED=1；若 data/ 目录已存在且非空，
   视为已有实例——停止并请求人工确认，不得覆盖。
5. 健康验证（全部通过才算成功）：
   a. GET / 返回 200；
   b. POST /api/auth/login（admin + 口令）返回 token；
   c. GET /api/overview（Bearer token）返回 200；
   d. npm run selftest 207/207 通过；npm run lint:manifests 50/50 通过。
6.（可选，仅当"接入 dsh"=是）按仓库 docs/deploy-enterprise.md 第三节生成 overlay 并以
   pnpm dsh web --patch 启动，验证两进程共享同一 data/。
7. 回报：commit hash、服务地址、admin 首登是否成功、自测结果、初始口令交付方式（不得明文贴在公开渠道）。

【护栏】
- 一切高危操作（下线/吊销/删除）必须走平台审批单并留痕，不得绕过；
- 只读命令可自由执行；任何变更前先 --dry-run 预演；
- 部署完成后建议立即改掉 admin 初始口令并创建企业自有账号（参考 skills/dsh-ops-iam）。
```

## 五、验收清单

- [ ] `GET /` 200，控制台可登录（admin + `ADMIN_PASSWORD`）
- [ ] `npm run selftest` 207/207、`npm run lint:manifests` 50/50
- [ ] 生产数据目录**不含**演示数据（`data/iam~users.json` 无 ops/hr/dev 等演示账号）
- [ ] （形态 B）dsh web 启动且 Agent 能回答 `dshctl mcp list` 类问题
- [ ] 备份策略就位（data/ 目录定时冷备）
- [ ] admin 初始口令已更换，演示口令 `Ybk@2026` 无法登录
