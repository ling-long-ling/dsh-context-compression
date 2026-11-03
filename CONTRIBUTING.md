# 贡献指南

谢谢愿意帮忙。这个项目最需要的是**真实世界的样本**与**行为基线**，而不是更多功能。

2.0 起本项目是 **DSH（DeepSeek Harness）Cordis 插件**：纯 ESM JavaScript、零运行时依赖、
无构建步骤、配置走插件配置而不是环境变量。算法契约见 [docs/ENGINE-SPEC.md](docs/ENGINE-SPEC.md)，
改判定逻辑前请先读它。

## 最欢迎的三类贡献

### 1. 误判样本（最有价值）

某一类行被分错层了，比如：

- 明明是错误，却被当普通行丢掉
- 明明是噪音，却占着 strong 名额
- 骨架行判定过宽（正常代码被当关键值保留）

提交时请附上**最小可复现载荷**（一段文本 + 期望分类 + 实际分类 + 为什么）。
可以直接用 `node --test` 写一个一次性断言，或贴出 `trimToolText` 的输入与输出。

### 2. 压缩效果与性能数据

在真实会话里用 `shadow: true` 跑一两天，把
`<statsDir>/saves-YYYY-MM.jsonl` 里的统计（或 `last-trim.json` 的 `totals`）贴到 issue 里。
我们现在的默认值（Bash 预算 4000、门槛 3000）来自 1.x 的独立语料，需要更多机器与会话形态的样本。

### 3. 跨工具形态

现在支持 `bash` / `pwsh` / `grep` / `glob` / `read` / `web_fetch` / `web_search` 的输出。
如果你常用的工具输出形态是新的（结构化 JSON、CI 日志格式……），欢迎提出来——但请先确认
**现有机制真的处理不了**，而不是加一个特例。新增工具映射只需要改 `lib/mapping.js` 与
`test`，不需要动算法。

## 跑测试

```bash
node --test tests/                # 全部：引擎 golden + 服务契约 + 真加载冒烟
node --test tests/engine/         # 只跑引擎单测与夹具
```

CI 在 `ubuntu-latest` 与 `windows-latest`（Node 22）上跑同一套 `node --test tests/`。
CI 不需要 Python —— golden 夹具已经提交在仓库里。

### 差分对拍（改引擎判定逻辑时必跑）

算法是从 1.x 的 Python 参考实现逐条移植来的，开发期靠**差分对拍**保证行为一致：

```bash
node scripts/differential.mjs --random 200
```

- 需要本机有 Python 参考实现（开发期材料，**不随仓库发布**，由维护者提供路径）；
- 脚本对随机载荷分别跑 JS 引擎与参考实现，逐字节比较结果，打印差异摘要；
- **退出码非 0 = 有不一致**，先修到 0 差异再提 PR；
- 对拍时落盘关闭（`spillEnabled` / Python 侧 `WB_OPS_SPILL=0`），避免临时文件干扰比较。

落盘本身（内容寻址文件名、7 天清理）另有单测覆盖，不靠对拍。

## 写作用域

| 路径 | 内容 | 注意 |
|---|---|---|
| `lib/engine/` | 算法实现（分类、预算分层、填充、标记、落盘） | 改判定/常量必须同步 `docs/ENGINE-SPEC.md`，并跑差分对拍 |
| `lib/index.js` | Cordis 插件入口与 `toolResultPruner` 服务 | 改动要过 `tests/prune-session.test.js` / `tests/load.test.js` |
| `lib/config.js` | 插件配置解析（未知键抛错、数值夹紧） | 新字段要同步 README 配置表与 CHANGELOG |
| `lib/mapping.js` | DSH 工具名 ↔ 引擎工具类、内容块提取/重建 | 新增工具只需映射 + 测试 |
| `tests/engine/` | 引擎单测 + golden 夹具 | 夹具是行为基线，改夹具要说明原因 |
| `tests/*.test.js` | 服务契约、replay-safe 写回、真加载冒烟 | 不要用 mock 绕过 Cordis 加载那条 |
| `docs/` | 契约文档 | 与代码同 PR 更新 |
| `scripts/` | `install-profile.mjs`、`differential.mjs` | 安装脚本必须保持幂等与 `--dry-run` |

## 不要破坏这些不变量

- **标记结构冻结**：行首 needle `… [dsh-ctx `（13 字节）+ en dash 行号区间
  （`第 a–b 行`），幂等检测依赖它们；改品牌前缀 = major 版本。
- **所有长度/预算按 UTF-8 字节计**：`Buffer.byteLength`，禁止 `String.prototype.length`；
  前缀/后缀/截断必须落在 UTF-8 字符边界。
- **分类谓词用显式字符扫描，不用正则**；`A-Z` 只按 ASCII 折叠，不用 `toLowerCase()` 处理非 ASCII。
- **整数除法方向固定**（向零/向下取整按 SPEC），改之前先看 `docs/ENGINE-SPEC.md` 对应小节。
- **零运行时依赖**：只 import `node:` 内置模块与仓库内相对路径；不引入构建步骤，
  不新增 Python / C++ / 原生二进制实现。
- **插件不读 stdin、不写 hook 输出、不读环境变量**；配置只来自 `cordis.patch.yml` 的 `config:`。
- **失败现场透传**：`isError` 的工具结果、Bash 非 0 退出、引擎异常，一律原样透传。
- **任何异常都不能抛到压缩流程之外**：单个工具结果失败只跳过它。
- **默认预算/门槛的改动会改变所有用户的成本**：改默认值要在 CHANGELOG 里单独说明理由。

## 提 PR 前自查

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"  # 清单合法
node --test tests/                         # 全绿
node scripts/differential.mjs --random 200 # 改过引擎才需要，要求 0 差异
```

- 改判定逻辑 = 同时更新 `docs/ENGINE-SPEC.md` 对应小节；
- 新增配置字段 = 同步 README 配置表 + `lib/config.js` + 测试；
- 改动用户可见行为 = CHANGELOG 里写清楚（含「为什么」）。

## 提交信息

用中文或英文都行，但请说清楚**改了什么、为什么**。格式不强制。

## 行为准则

- 讨论对事不对人。
- 不接受「为了功能更多」而牺牲「不丢信息」的改动。
- 性能优化必须给出测量数据，不接受「感觉更快」。

## 许可

你的贡献会以 [MIT](LICENSE) 许可发布。
