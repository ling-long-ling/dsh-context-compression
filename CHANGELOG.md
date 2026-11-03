# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 2.0.0 是**插件形态的重构**：同一套裁剪算法，从 hook 插件改造成 DSH Cordis 插件。
> 下面 1.x 的段落全部属于 **WorkBuddy / CodeBuddy 时代**，保留原样以便对照历史行为。

## [2.0.0] - 2026-11-03

### 版本号为什么是 2.0.0

1.x 是 WorkBuddy/CodeBuddy hook 插件（读 stdin、写 hook 输出、配置走 `WB_OPS_*` 环境变量）；
2.0 换成 **DSH（DeepSeek Harness）Cordis 插件**：注册 `toolResultPruner` 服务、接入 compaction 管线，
  配置、标记前缀、宿主交互全部改变，**与 1.x 不兼容**——按语义化版本只能抬 major。
算法内核（STRONG / SKELETON / WEAK 分层、预算分层、原文落盘回查）不变，
所以不是「算法 2.0」，而是「插件形态 2.0」。

### 重大变更

- **插件形态**：从 hook 改成 Cordis 插件。注册 **`toolResultPruner`** 服务（与官方
  `@deepseek-ai/dsh-compaction-tool-result-pruner` 同名同协议），挂进 agent preset 的
  `compaction` 组，`compaction-basic` 里 `ctx.get('toolResultPruner')` 直接拿到本插件，可 drop-in 替换。
- **replay-safe 写回**：替换工具结果前先 append `compaction/prune` 事件，再以
  `surfaceOp: replace` 追加新的 `tool/result` 事件；不原地改历史事件，回放可从日志恢复替换输入。
- **配置**：由环境变量（`WB_OPS_*`）改为插件配置（`cordis.patch.yml` 的 `config:`）：
  `enabled` / `budgets` / `minBytes` / `readTrim` / `spill` / `shadow` /
  `minSaveBytes` / `minSavePercent` / `statsDir` / `debug`。未知键直接抛错、数值收敛到合法区间。
- **标记前缀**：`… [wb-ops ` → `… [dsh-ctx `（行首结构与 en dash 行号区间不变，幂等检测依赖它）。
  v2 只识别新标记——旧会话里没有 v2 写入，不构成误判。
- **统计文件**：仍写 `saves-YYYY-MM.jsonl` 与 `last-trim.json`，改写到配置的 `statsDir`；
  `last-trim.json` 字段改为 camelCase（`at` / `session` / `reason` / `bytesBefore` / `bytesAfter` /
  `saved` / `shadow` / `totals` / `version`），原因取值对齐 DSH 工具结果语义。
- **双实现退场**：删除 Python（`hooks/trim.py`）与 C++（`src/trim.cpp`、`bin/*.exe`）双实现，
  以及逐字节 parity 要求；只保留纯 ESM JS 引擎（`lib/engine`），无 Python、无 g++、无构建步骤、
  零运行时依赖，Node ≥ 22。

### 新增

- `scripts/install-profile.mjs`：本机 profile 安装器，自动加 `link:` 依赖、替换各 preset 的
  `tool-result-pruner` 行、建 `node_modules` junction；幂等，支持 `--dry-run` / `--uninstall`，
  改动前写 `.bak-dsh-ctx-*` 备份。
- `lib/config.js`：插件配置解析（未知键抛错、数值夹紧、不读环境变量）。
- `lib/mapping.js`：DSH 工具名（`bash` / `pwsh` / `read` / `grep` / `glob` / `web_fetch` / `web_search`）
  → 引擎工具类的映射，以及文本块提取/重建。
- `docs/ENGINE-SPEC.md`：引擎契约（由 1.1.1 的 `SPEC-1.1.1.md` 迁入改写，只针对 JS 实现）。
- `node --test` 测试与双平台 CI（ubuntu-latest + windows-latest，Node 22）。

### 移除

- WorkBuddy/CodeBuddy hook 运行时与配套文件：`.codebuddy-plugin/`、`hooks/`（含 `trim.py`、
  `ctx-guard.mjs`、`precompact.mjs`、`memory-guard.mjs`、`status.mjs`、`hooks.json`）、
  `commands/`（`/wb-ops:status`、`/wb-ops:report`）、`bin/`、`src/`、`install.ps1`、
  `report.py`、`push-to-github.ps1`。
- Python 测试脚本（`tests/*.py`）、`tests/iso*` 临时夹具、`UPGRADE-1.0.1.md`、`UPGRADE-1.1.1.md`
  （升级说明由本 CHANGELOG 承担）。
- 环境变量配置、`WB_OPS_*` 渠道、以及 hook 时代的 `shadow-YYYYMM.jsonl` / `last-guard.json`。

### 保留

- `LICENSE`、`.gitattributes`；算法常量、分类谓词、标记文案结构、幂等判定、少行截断、
  失败现场透传、原文落盘与 7 天清理逻辑全部保留（行为见 `docs/ENGINE-SPEC.md`）。

## [1.1.1] - 2026-11-01

WorkBuddy / CodeBuddy 时代（hook 插件形态，Python / C++ 双实现）。

修掉 1.0.1 实测报告里的 4 个设计缺口 + 1 处诊断误导（报告编号 F1 / F2 / F3 / F6）。
配置项与输出标记格式不变，只改「保留多少、先保谁」。

### 修复

- **F1 预算非单调（调大预算反而压得更狠）**：触发门槛与裁剪目标彻底分离（O2）。
  此前 `eff = min(预算, 门槛)`，跨过「字节数 > 预算」分支时行为突变——22,452 B 输入、
  预算 20000 → 5,940 B，预算 24000 → **2,735 B**。现在一旦触发 `eff` 恒等于预算，
  `>8 KB` 输出默认更激进（Bash 预算 4000），预算轴/输入轴都变成单调。
- **F3 根因被级联错误淹没**：同签名 strong 行「**超上限才**归并」（O1b）——每组按配额保留
  （首条 + 等距取样），上限内完全不动；组首条（首个出现 = 根因）排到填充候选末尾，
  `fill_recent` 从后往前挑，于是**首因优先**（O3）。
  621 行「根因第 151 行 + 120 条同签名级联」根因 **0/1 → 1/1**；
  8 条不同 `step=` 的真错误仍 **8/8**（签名不同，不会被归并）。
- **F2 `MAX_SKEL_LINES=24` 天花板**：条数上限改为「基线 + 预算自适应」
  （`adaptive_count()`，`//32`，硬顶 128）；关键行候选改为**全区间等距取样**（`pick_spread()`），
  不再只取最近的 24 条。200 行 `KEY=VALUE` 在预算 8000 下保留 **> 24** 条且分散在全区间；
  df 满盘告警、docker ps 表格的关键信息 **2/2、2/2**。
- **F6 幂等判定过宽 + 诊断顺序**：幂等判定锚定**行首标记结构**（`has_wb_ops_marker`），
  正文里偶然打印的裸 `[wb-ops ` 不再误判；`read_off` 上报提到 `idem` 之前。
  Read 未开裁剪且正文含标记时如实报 `read_off`，Bash 日志里打印该字样仍照常裁剪。
- 删除已不参与逻辑的 `MAX_FILL_ROUNDS` 常量（1.0.1 起就只是兼容保留，容易误读）。

### 变更

- **默认预算按工具分级**：Bash **4000**（更激进），其余 8000；
  `WB_OPS_BUDGET` 显式设置时对所有工具生效（含 Bash）。
- **`WB_OPS_MIN_BYTES=0` 语义收窄**：只关闭「按门槛触发」（退回只按预算/行数触发），
  不再把裁剪目标压小。
- `last-trim.json` 的 `v` 字段为 `1.1.1`；字段与格式不变。

### 实测证据（独立对抗语料 13 组 / 25 条关键信息，py 引擎，2026-11-01）

| 指标 | 1.0.1 基线 | 1.1.1 |
|---|---|---|
| 关键信息存活 | 8/25 | **13/25** |
| 整体压缩率 | 76.5% | **83.7%** |
| 根因在中段 + 120 条级联（`cascade_mid_root`） | 0/1 | **1/1** |
| docker ps（表格 + hex ID） | 0/2 | **2/2** |
| df（99% 满盘告警在中段） | 0/2 | **2/2** |
| 预算轴（22,452 B 输入，BUDGET 8000/20000/24000/60000） | 非单调（24000 → 2,735 B） | 7762 / 9093 / 9093 / 9093，单调不减 |

- 双实现：`hooks/trim.py` 与 `bin/wb-ops-trim.exe` 逐字节一致由 `tests/parity.py --random 200`
  覆盖，CI 与发版前全跑（通过与否以发版终验为准）。
- 与 1.0.1 相同的红线继续成立：8 条真错误 8/8、`failover|isError|errorCode|warningLevel|timeout_ms|cannot_parse`
  不进 strong、520 行埋 6 个关键值 6/6。

### 性能

| 组件 | 本机实测 p50（30 次，301 行 / 18,912 B） |
|---|---|
| `trim.exe` | 27.5 ms |
| `trim.py` | 257.3 ms |
| `ctx-guard.mjs` | 56.6 ms |
| `precompact.mjs` | 52.6 ms |

> 绝对毫秒数**不可跨机器比较**：exe 的 `min = 24.9 ms` 且波动极小，说明由**进程启动成本**主导
> （疑杀软扫描），换机器可能整体差 4–6×。跨机器请只看 `exe/py` 比值（本机 ≈ 9.4×，首发时 7.3×）。

### 已知代价

- Bash 默认预算 8000 → 4000：`>8 KB` 输出默认更激进（目标 8000→4000）；
  而 `3–8 KB` 区间旧版被 `min()` 压到 3000，现在按 4000 保留更多（6.7 KB 输出 2.7 KB→3.6 KB）。
  整体上独立对抗语料压缩率与关键信息同时上升。想更保守：调大 `WB_OPS_BUDGET`（如 8000–12000）。
- F4（空格对齐表格）/ F5（小写 `key=value`、`Key: Value`）识别**留到 1.2**：
  报告建议先放开限额（本版的 F2）再扩谓词，顺序反了会让新识别的行互相挤。

## [1.0.1] - 2026-10-21

WorkBuddy / CodeBuddy 时代（hook 插件形态）。

修掉 1.0.0 实测暴露的三个信息损失问题。

### 修复

- **真错误被抽样稀释**：8 条真错误混在 140 条弱关键词误命中里时，只剩 3–5 条存活。
  原因是用「命中数量」做预算，噪音把真错误挤出了采样窗口。改为三级分类，
  STRONG 独占 45% 预算且无条件全留。→ **8/8**
- **中段关键值全丢**：520 行日志里埋的 6 个 `KEY=VALUE` 存活 **0/6**。
  新增 SKELETON 层（`KEY=VALUE` / 表格 / diff 头 / URL / 路径 / commit SHA / JSON 键），
  与错误同级。→ **6/6**
- **6–7 KB 的 Bash 输出根本不裁**：触发门槛（行数/字节）与输出预算耦合，
  小体积大行数的输出永远够不到门槛。触发门槛与预算解耦（`WB_OPS_MIN_BYTES`）。→ **60% 缩减**
- **多轮填充丢弃已选行**：1.0.0 的填充循环每轮累加已用预算，后续轮次会把前一轮
  选中的关键行挤出候选。改为单次确定性填充。

### 新增

- **原文落盘**：裁剪同时把原文写到 `%TEMP%\wb-ops\<会话>\<crc32>-<字节数>.txt`，
  标记里带可 Grep 回查的路径，7 天自动清理。信息不再不可逆丢失。
  （`WB_OPS_SPILL=0` 可关）
- **`/wb-ops:status`**：版本、引擎、最近一次调用的**原因**、累计节省、上下文水位、诊断。
  此前「没触发」与「挂了」无法区分。
- **`last-trim.json`**：每次调用记录时间/工具/前后字节/原因/引擎，
  原因取值 `trim` `short` `idem` `persisted` `read_off` `bash_failed` `shadow` `error`。
- **`WB_OPS_SHADOW`** 影子模式：只统计「本可省多少」，绝不改输出。建议上线前先跑。
- **`<persisted-output>` 识别**：宿主已把大输出外置时不再二次处理。
- **单行截断标注**：单行超长被截断时补「原文 N 字节」，JSON 形态优先截在 `,}` `]` 边界。
- **PreCompact 会话线索**：从 transcript 尾部提取最近用户消息、待办、文件路径，
  生成「本次会话线索」；提取不到时逐字节退回 1.0.0 固定文案。

### 变更

- **Bash 失败统一透传**：文本 `Exit Code: N` 与结构化 `exitCode/exit_code` 都认，
  非 0 整数一律整段透传。此前结构化 `exitCode: 2` 会被裁掉失败现场。
- `hooks.json` 的 PostToolUse `timeout` 从 10 降到 3（超出即放弃裁剪，不阻塞会话）；
  python 回落时注入 `WB_OPS_DEGRADED=1` 供 status 展示降级。
- 标记文案去掉「命中关键字的 N 条中均匀抽取 M 条」这类实现细节。
- ctx-guard 的自动压缩学习判定改为**以 `compactionKind` 为准**，缺失时才回退看
  `compactType`。此前用 `||` 判定，`compactionKind=manual` 且 `compactType=auto`
  的脏记录会被误学成自动压缩样本。

### 性能

| 组件 | 1.0.0 实测 | 1.0.1 实测 |
|---|---|---|
| `trim.exe` | 102.7 ms | **6.2 ms** |
| `trim.py` | 309.5 ms | 45.0 ms |
| `ctx-guard.mjs` | 136.9 ms | 36.3 ms |
| `precompact.mjs` | 152.2 ms | 37.0 ms |

### 已知代价

整体压缩率从 80.9% 降到 65.1%。这是**刻意的取舍**——少省的字节换来了「不再丢关键行」。
想更激进：调小 `WB_OPS_BUDGET`。

## [1.0.0] - 2026-10-17

WorkBuddy / CodeBuddy 时代（hook 插件形态）。

首个稳定版，功能与 0.6.9 一致。自本版起冻结配置项与输出标记格式。

- 工具输出裁剪覆盖 `Grep` / `Glob` / `WebFetch` / `Bash`（Bash 退出码非 0 整段透传）
- `Read` 按需裁剪（`WB_OPS_READ_TRIM=1` 且 > 1500 行）
- 省略标记带行号区间，可 offset 回查
- 上下文守卫 v2：学习各模型真实自动压缩点、三档提醒、压缩后水位检查
- PreCompact 固定保留清单
- 记忆守卫（SessionStart）
- C++ / Python 双实现逐字节一致

## [0.6.9] 及更早

WorkBuddy / CodeBuddy 时代（hook 插件形态）。

早期迭代，详见 git 历史。要点：

- 0.6.9：裁剪接入 `Bash`；`Read` 按需裁剪
- 0.6.8：移除主动压缩督导入口（与宿主轮末 Gate 抢跑会让 UI 卡在「思考中」）
- 0.6.6：修 hook 命令的路径分隔符敏感性
- 0.6.5：双宿主适配（WorkBuddy / WorkBuddyAI）
