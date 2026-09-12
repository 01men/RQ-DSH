# handoff-doc-fixes-to-main —— 2026-09-13 系统性测试发现的宿主面问题交接

> 来源：2026-09-13 定制分支（custom/dsh-rq）全链路系统性测试（质量门回归 + 全量形态 API 扫描 +
> fresh-install 实装 + 场景脚本套件 + 浏览器 GUI 走查）。以下条目均属**宿主面**（README.md /
> plugin-console），按仓库铁律 2 不在本分支直接修改，登记本清单由主分支侧评估采纳。
> 证据均为真机实测，附复现路径。

## 1. README 的 CLI 路径引用失效：`cli/dshctl.mjs` 实际不存在

| 项 | 内容 |
|---|---|
| 现象 | README 快速开始与 CLI 章节引用 `node cli/dshctl.mjs`，但仓库根 `cli/` 目录为**空目录**，脚本实际位于 `examples/dshctl.mjs`（功能完好，B 线实测 `help`/`mcp list`/`agent list` 全通，含错误口令诚实报错） |
| 位置 | `README.md:73`（快速开始）、`README.md:467`（仓库结构说明）、`README.md:513-529`（CLI 示例全集，共 18 处 `cli/dshctl.mjs`） |
| 影响 | 新用户按 README 首次使用 CLI 即报「模块不存在」 |
| 建议 | 主分支侧统一替换 `cli/dshctl.mjs` → `examples/dshctl.mjs`（或把脚本落位到 `cli/`，二选一）；若选择移动脚本，注意 `examples/` 路径已被本分支测试报告与维护记录引用 |
| 复现 | `ls cli/`（空）；`ls examples/dshctl.mjs`（存在）；`node cli/dshctl.mjs help`（ERR_MODULE_NOT_FOUND） |

## 2. 【观察项】全量形态下控制台 SPA 兜底路由遮蔽 `/gate01/*` 命名空间

| 项 | 内容 |
|---|---|
| 现象 | 源码全量形态（`node src/main.ts`，22-entry）下，`/gate01/*` 下任意路径（含 `/gate01/panel/`、`/gate01/api/panel/board`、甚至任意未匹配路径）一律返回**控制台 index.html**（200 text/html），01门面板 SPA 在该形态下不可达 |
| 位置 | `packages/plugin-console/src/index.ts:3937`——`http.serveStatic('/', publicDir, '/index.html')` 的根级 SPA 兜底先于/覆盖 dsh-bridge 的 `/gate01` 挂载面 |
| 影响评估 | **不阻断产品**：01门交付形态是 dsh 插件装态（无 console 插件，`/gate01/panel/` 实测正常，fresh-install 演练全过）；全量形态的面板数据面走顶层 `/api/panel/*`（实测干净 401 严格鉴权）。仅影响「源码全量形态下想直接打开面板 SPA」的路径 |
| 建议 | 主分支侧二选一：(a) 接受现状并在文档标注「面板 SPA 仅 dsh 插件装态提供」；(b) `serveStatic` 兜底前对已注册插件挂载前缀（如 `/gate01`）做排除，避免吞掉兄弟插件命名空间 |
| 复现 | 全量形态实例：`curl -i http://127.0.0.1:<port>/gate01/panel/` → 200 但 body 为控制台 HTML（对照 dsh 装态同路径返回面板 HTML）；`curl http://127.0.0.1:<port>/gate01/api/panel/board` → 200 text/html（应答 JSON 的端点被兜底吞掉） |

## 登记纪律

- 本清单只登记、不隐含承诺；采纳与否由主分支侧自行评估。
- 定制分支侧已完成的本轮本地优化（与本清单无交叉修改）：见提交记录 `fix(panel-core)` OPT-02、
  `test(walkthrough)` OPT-03（均为定制面/测试文件，不触碰宿主面）。
