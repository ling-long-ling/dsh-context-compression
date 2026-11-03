# dsh-context-compression

> DSH（DeepSeek Harness）Cordis 插件：把工具输出的 token 成本砍掉一大半，同时不丢关键信息。
> 2.0 起是**插件形态重构**——注册 `toolResultPruner` 服务、接入 compaction 管线，
> 不再是 1.x 的 hook 插件；1.x 的 Python / C++ 双实现已移除。

[![CI](https://github.com/ling-long-ling/dsh-context-compression/actions/workflows/ci.yml/badge.svg)](https://github.com/ling-long-ling/dsh-context-compression/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](CHANGELOG.md)

---

## 这是什么

一个 **DSH Cordis 插件**，不是 CodeBuddy / WorkBuddy 插件。

它注册与官方确定性裁剪器同名的 **`toolResultPruner`** 服务：当 `compaction` 触发时，
按 **STRONG / SKELETON / WEAK** 分层策略压缩会话里的工具结果，把结果按 replay-safe 协议写回会话。
因为服务名和协议都与官方 `@deepseek-ai/dsh-compaction-tool-result-pruner` 一致，
它是**drop-in 替换**——在 agent preset 的 `compaction` 组里换掉官方那一行即可，
`compaction-basic` 里 `ctx.get('toolResultPruner')` 直接拿到本插件。

- 纯 ESM JavaScript（`lib/`），**无构建步骤、零运行时依赖**，只 import Node 内置模块；
- Node ≥ 22，DSH ≥ 0.2.1-rc.2；
- 不读 stdin、不写 hook 输出、不起子进程；任何异常都收敛为「原样透传」，绝不阻断压缩流程。

## 为什么需要它

Agent 干活时，一个 `Bash` 调用动辄返回几百行日志、几万字节。这些内容进上下文，token 就烧掉了，
而其中真正有用的可能只有 8 行错误。

粗暴截断（只留头尾 N 行）会丢掉**中段的关键信息**——1.x 实测中「520 行日志里埋的 6 个关键值」
用朴素方案存活 **0/6**。这类信息丢了，模型就只能瞎猜或者重新执行命令。

本插件的做法是**先分层再裁剪**，并且被裁掉的原文会落盘、标记里带可 Grep 回查的路径，
所以不是不可逆的信息损失。算法细节与常量见 [docs/ENGINE-SPEC.md](docs/ENGINE-SPEC.md)。

## 算法

| 层级 | 内容 | 处理 |
|---|---|---|
| **STRONG** | 真错误：`ERROR` / `Traceback` / `panic:` / `error[E0432]` / `错误` … | **全部保留**；条数上限按预算自适应（基线 40），同签名级联「超上限才归并」，每组首条（根因）优先 |
| **SKELETON** | 关键值与骨架：`KEY=VALUE` / 表格行 / diff 头 / URL / 绝对路径 / commit SHA / JSON 顶层键 | 与错误同级、不占同一预算；条数上限同样随预算自适应（基线 24），全区间等距取样 |
| **WEAK** | 弱关键词：`failover` / `isError` / `warningLevel` / `timeout_ms` … | **只报数、不占预算**，避免把真错误挤出窗口 |

关键机制：

- **触发与目标分离**：门槛只决定「要不要裁」，一旦触发，裁剪目标恒等于预算 → 调大预算只会保留更多，不会反而压得更狠（预算轴、输入轴都单调）。
- **预算分层**：预算先给 STRONG 45%，SKELETON 累计 57%，头段累计 87%，剩余留给尾段；最终再按预算字节硬上界收口。
- **原文落盘**：裁剪同时把原文按内容寻址写到 `spill.dir`（默认 `<系统临时目录>/dsh-context-compression/spill/<会话>/<crc32>-<字节数>.txt`），标记里带路径，默认 7 天清理。
- **幂等**：输出带行首标记 `… [dsh-ctx 省略 N 行（第 a–b 行）…] …`，重复处理同一段文本会直接透传。
- **Read 按需**：只有 `readTrim: true` 且文件超过 1500 行才裁剪，命中函数/类/import 行的保留策略与其他工具不同。
- **replay-safe 会话写回**：替换工具结果前先 append `compaction/prune` 事件，再以 `surfaceOp: replace` 追加新的 `tool/result`，不原地改历史事件。

工具映射：`bash` / `pwsh` → Bash，`read` → Read，`grep` → Grep，`glob` → Glob，
`web_fetch` / `web_search` → WebFetch；其它工具的输出不处理。

## 安全边界

1. **认不出来就原样透传** —— 绝不猜测、绝不破坏结构化输出。
2. **输出不长就不动** —— 而不是无脑截断。
3. **分层保留** —— 绝不让噪音把真错误挤出采样窗口。
4. **丢了能回查** —— 原文落盘，标记带路径。
5. **失败现场透传** —— 工具结果 `isError` 为真、Bash 非 0 退出时整段不动。
6. **任何异常静默透传** —— 单个工具结果失败只跳过它，绝不挂住会话。

> 落盘是**不加密的纯文本**，落在系统临时目录。如果工具输出里常有密钥/token，
> 请配置 `spill.enabled: false`，代价是裁剪后无法回查原文。

## 装

前置：DSH 已就绪，本仓库已克隆到本机。

```bash
node scripts/install-profile.mjs --dry-run   # 先看计划，不写盘
node scripts/install-profile.mjs             # 实际安装
```

脚本做三件事，且**幂等**（重复执行不重复插入）：

1. 在 profile（默认 `~/.dsh/profiles/desktop`）的 `package.json` 里加依赖
   `"dsh-context-compression": "link:<本仓库路径>"`；
2. 把 `cordis.patch.yml` 里**每个 agent preset 的 `compaction` 组**中的官方
   `tool-result-pruner` 行替换成本插件的行（保留 `isolate` 键与缩进）：

   ```yaml
   - id: context-compression
     name: dsh-context-compression
     config:
       budgets:
         bash: 4000
   ```

3. 在 profile 的 `node_modules/` 下建指向本仓库的 junction，让 profile 能解析到插件包。

其它参数：`--profile <dir>` 指定 profile，`--repo <dir>` 指定本仓库路径，
`--uninstall` 还原官方行并移除依赖与 junction。改动前会写 `.bak-dsh-ctx-*` 备份。

### 验证

重启 DSH 后：

1. 日志出现 `dsh-context-compression 2.0.0 active`（可用 `debug: true` 打开每次决策的明细）；
2. 长工具输出被替换成 `… [dsh-ctx 省略 N 行（第 a–b 行）；…] …`；
3. 诊断文件：`<系统临时目录>/dsh-context-compression/data/last-trim.json`。

## 配置

全部配置写在 `cordis.patch.yml` 里本插件那一行的 `config:` 下，**不再读环境变量**。
未知键会直接抛错（避免拼写错误静默失效）；数值会收敛到合法区间。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件总开关。`false` 时插件加载但不工作：不注册服务、不裁剪、不写统计。 |
| `budgets` | `{bash: 4000, grep: 8000, glob: 8000, webFetch: 8000, read: 8000, default: 8000}` | 每个工具类的输出预算（UTF-8 字节），收敛到 `[2000, 131072]`。显式调小 = 更狠，调大 = 保留更多，单调生效。 |
| `minBytes` | `{bash: 3000, grep: 6000, glob: 6000, webFetch: 6000, read: 8000, default: 4000}` | 触发门槛（字节）：超过才裁，**只管要不要裁、不影响裁到多少**；`0` = 关闭按门槛触发（退回只按「超预算或超 120 行」触发）。收敛到 `[0, 131072]`。 |
| `readTrim` | `false` | 是否裁剪 `Read` 结果（只对 > 1500 行的文件生效）。 |
| `spill` | `{enabled: true, dir: <临时目录>/dsh-context-compression/spill, days: 7}` | 原文落盘：开关、根目录、保留天数（收敛到 `[1, 365]`）。 |
| `shadow` | `false` | 影子模式：只统计「本可省多少」、照常写诊断，**绝不改会话**。建议先跑一两天看收益。 |
| `minSaveBytes` | `300` | 节省不足这么多字节就不裁。 |
| `minSavePercent` | `4` | 且节省不足这个百分比就不裁。 |
| `statsDir` | `<临时目录>/dsh-context-compression/data` | 诊断/统计输出目录：`saves-YYYY-MM.jsonl`（每次决策一行）、`last-trim.json`（最近一次 + 累计计数）。 |
| `debug` | `false` | 通过 DSH logger 打印每次决策（工具、序号、原因、前后字节）。 |

示例：

```yaml
- id: context-compression
  name: dsh-context-compression
  config:
    shadow: true            # 先影子模式观察
    budgets:
      bash: 6000            # 想保守一点就调大
    spill:
      days: 14
    statsDir: D:/dsh-stats
```

`last-trim.json` 与 `saves-*.jsonl` 里的 `reason` 取值：
`trim`（裁剪成功）、`short`（不值得裁）、`read_off`（Read 未开裁剪）、
`persisted`（宿主已外置）、`idem`（已含标记）、`bash_failed`（Bash 失败）、
`error`（引擎异常）；服务层还会记 `tool_failed`、`no_gain`、`shadow`。

## 效果

### 1.1.1 实测（独立对抗语料，1.x 同算法引擎）

**口径**：13 组真实命令输出 + 工程场景（`netstat -an` 429 行、`env` 227 行、`git log` 200 条、
pytest 失败、npm 安装、docker ps、K8s ConfigMap、`.env`、50 KB 单行 JSON、600 行级联错误 …），
判据只有一条——**人还需要的那几个事实还在不在**（共 25 条）；2026-11-01 本机实测。

| 指标 | 1.0.1 | 1.1.1 |
|---|---|---|
| 关键信息存活 | 8/25 | **13/25** |
| 整体压缩率 | 76.5% | **83.7%** |
| 根因在中段 + 120 条级联 | 0/1 | **1/1** |
| docker ps（表格 + hex ID） | 0/2 | **2/2** |
| df（99% 满盘告警在中段） | 0/2 | **2/2** |
| 预算轴 8000/20000/24000/60000（22,452 B 输入） | 非单调（24000 反而 2,735 B） | 7762/9093/9093/9093（单调不减） |

> ⚠️ 这组数字来自 **WorkBuddy hook 时代同算法引擎的独立语料**（1.x 的 Python 参考实现），
> 不是 2.0 JS 引擎重新跑出来的；2.0 逐条移植同一套算法，并用开发期差分对拍
> （`scripts/differential.mjs`，与 Python 参考实现逐字节比对）保证行为一致：
> 2026-11-03 实测 **245 组载荷（固定 35 + 随机 210）0 差异**（文本 / reason / meta 三项全比）。
> 这组数字与仓库自带测试夹具**不是同一批输入**，不要混着加总。

## 2.0 变更

- **插件形态**：从 hook 插件改成 **DSH Cordis 插件**，注册 `toolResultPruner` 服务，
  drop-in 替换官方确定性裁剪器；不读 stdin、不写 hook 输出、无子进程。
- **配置**：环境变量 → 插件配置（见上表）；未知键抛错、数值收敛。
- **标记前缀**：`… [wb-ops ` → `… [dsh-ctx `；v2 只识别新标记（旧会话没有 v2 写入）。
- **实现语言**：删除 Python / C++ 双实现与逐字节 parity 要求，只保留纯 ESM JS 引擎
  （`lib/engine`），无 Python、无 g++、无构建步骤、零运行时依赖。
- **统计**：`saves-*.jsonl` / `last-trim.json` 改为写入 `statsDir`，字段与原因取值更贴合 DSH 的
  `tool/result` 语义。
- **测试**：`node --test tests/`（Node 内置 test runner），CI 覆盖 ubuntu + windows。

完整历史见 [CHANGELOG.md](CHANGELOG.md)。

## 开发

```bash
node --test tests/                 # 全部测试（引擎 golden + 服务契约 + 真加载冒烟）
node --test tests/engine/          # 只跑引擎
node scripts/differential.mjs --count 200    # 开发期与 Python 参考实现差分对拍
```

写法、作用域与禁止事项见 [CONTRIBUTING.md](CONTRIBUTING.md)；算法契约见
[docs/ENGINE-SPEC.md](docs/ENGINE-SPEC.md)。

## 许可

[MIT](LICENSE)
