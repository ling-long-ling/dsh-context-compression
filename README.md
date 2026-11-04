# dsh-context-compression

> DSH（DeepSeek Harness）Cordis 插件：把工具输出的 token 成本砍掉一大半，同时不丢关键信息。
> 2.0 起是**插件形态重构**——注册 `toolResultPruner` 服务、接入 compaction 管线，
> 不再是 1.x 的 hook 插件；2.1 起默认把 `Read` 纳入裁剪，并补齐了 7 类常见关键行的分类谓词。

[![CI](https://github.com/ling-long-ling/dsh-context-compression/actions/workflows/ci.yml/badge.svg)](https://github.com/ling-long-ling/dsh-context-compression/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.1.0-blue.svg)](CHANGELOG.md)

---

## 这是什么

一个 **DSH Cordis 插件**，不是 CodeBuddy / WorkBuddy 插件。

它注册与官方确定性裁剪器同名的 **`toolResultPruner`** 服务：当 `compaction` 触发时，
按 **STRONG / SKELETON / WEAK** 分层策略压缩会话里的工具结果，把结果按 replay-safe 协议写回会话。
因为服务名和协议都与官方 `@deepseek-ai/dsh-compaction-tool-result-pruner` 一致，
它是**drop-in 替换**——在 agent preset 的 `compaction` 组里换掉官方那一行即可，
`compaction-basic` 里 `ctx.get('toolResultPruner')` 直接拿到本插件。

- 纯 ESM JavaScript（`lib/`），**无构建步骤、零运行时依赖**，只 import Node 内置模块；
- Node `^22.19.0 || >=24.0.0`，DSH ≥ 0.2.1-rc.2，版本 **2.1.0**；
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
| **STRONG** | 真错误：`ERROR` / `Traceback` / `panic:` / `error[E0432]` / `AssertionError:` / 行首 `Exit Code: 1` / `错误` … | **全部保留**；条数上限按预算自适应（基线 40），同签名级联「超上限才归并」，每组首条（根因）优先 |
| **SKELETON** | 关键值与骨架：`KEY=VALUE` / 小写 `key: value`（k8s manifest、CI workflow、docker-compose、frontmatter）/ 表格行 / diff 头与 `+`/`-` 骨架行 / URL / 绝对路径 / `path:line` / commit SHA / MAC 地址 / `host:port` / JSON 顶层键 | 与错误同级、不占同一预算；条数上限同样随预算自适应（基线 40），全区间等距取样 |
| **WEAK** | 弱关键词：`failover` / `isError` / `warningLevel` / `timeout_ms` … | **只报数、不作为关键行保留**，避免把真错误挤出窗口（它们可能随头/尾段原样出现，见「已知限制」） |

关键机制：

- **触发只看预算**：输入字节数 > 该工具预算才裁；一旦触发，裁剪目标恒等于预算 → 调大预算只会保留更多，
  不会反而压得更狠（预算轴、输入轴都单调）。输入 ≤ 预算**一律不动**（v2.1 删掉了旧的「门槛」触发，
  `minBytes` 仅作兼容保留，见「配置」）。
- **预算分层**：预算先给 STRONG 45%，SKELETON 累计 57%，头段累计 87%，剩余留给尾段；标记预留按
  落盘路径实长动态计算，正常情况下组装结果不会触发硬切。
- **原文落盘**：裁剪同时把原文按内容寻址写到 `spill.dir`（默认
  `~/.dsh/context-compression/spill/<会话>/<crc32>-<字节数>.txt`），标记里带路径，默认 7 天清理。
  **普通模式即使没识别出关键行也落盘**，兑现「丢了能回查」；Read 模式不落盘（源码可用 offset 重读）。
- **幂等**：输出带行首标记 `… [dsh-ctx 省略 N 行（第 a–b 行）…] …`，重复处理同一段文本会直接透传。
- **Read 按字节裁剪**：Read 与其它工具一样按「字节数 > 预算」触发（不再有 1500 行门槛）；
  分类分两档——**错误行优先**（先占 45% 预算），**符号行**（函数 / 类 / import，条数基线下限 64）
  只能用累计 57% 的剩余额度；标记分别报「N 条符号行、M 条错误行」
  （只统计关键行区，`M = meta.k`，`N` 不含 `focusPatterns` 命中的行）。
- **replay-safe 会话写回**：替换工具结果前先 append `compaction/prune` 事件，再以 `surfaceOp: replace`
  追加新的 `tool/result`，不原地改历史事件；`tool/result` 追加失败时中止本趟（不再堆悬空 shadow）。
- **可观测**：启动写 `statsDir/last-boot.json`；每趟 `pruneSession` 写 `last-pass.json`（0 裁剪也写）；
  决策流水写 `saves-YYYY-MM.jsonl`，最近一次决策写 `last-trim.json`（见「怎么确认它真的裁过」）。

工具映射：`bash` / `pwsh` → Bash，`read` → Read，`grep` → Grep，`glob` → Glob，
`web_fetch` / `web_search` → WebFetch；其它工具的输出不处理。

## 2.1 改了什么

逐条对应 2026-11-04 的 v2.0 实测优化报告（报告编号 P1-x / P2-x / R1–R10，完整条目见
[CHANGELOG.md](CHANGELOG.md) 的 2.1.0 段）：

| 报告编号 | 改动 | 使用者能感知到什么 |
|---|---|---|
| **R2** / P1-1 / P1-2 | `readTrim` 默认 `true`；Read 改为按字节触发；**错误行优先**、符号行用剩余额度并分报数 | 占真实工具输出字节 30.5% 的 `Read` 结果开始参与压缩；150 符号 + 30 错误的 Read 结果里错误行 18/30 → **30/30** |
| **R1** / P1-5 / P2-8 | 分类器补 7 类关键行：小写 YAML/KV、`path:line`、自定义异常、MAC、`host:port`、diff `+`/`-` 骨架行、ANSI 彩色日志；补小写 `npm error`；`MAX_SKEL_LINES` 24 → 40 | k8s/CI/frontmatter、编译器定位、ipconfig/docker/netstat、pytest 根因行不再被当噪音 |
| **R3** / P1-3 | 输入 ≤ 预算一律不裁；默认 `minBytes` 抬到与预算相等；行数触发失效 | 不再「白裁」小输出（真实数据 153 条），`ipconfig` 这类 3.2 KB 输出里的 MAC 行不再丢 |
| **R4** / P1-4 / P2-4 | 无关键行也落盘；`finish` 判定退化时删除已写文件 | 标记里的「原文 …，可 Grep 回查」真正兑现，也不留无引用垃圾文件 |
| **R5** / P1-7 / P1-8 / P2-1 / P2-9 | 末尾换行不再让行号 +1；区间可带「另有 N 行已保留在上/下文」；按输入主导行尾输出；少行分支按标记实长固定点求解 | 200 行日志的尾标记就是「176–200」；`offset` 回查不再差 1 行；「省略 N 字节」与真实一致 |
| **R6** | 新配置 `focusPatterns`；`dedup` 超上限改为「先保每组根因 + 其余等距」 | 能盯住 `ORD-` / `trace-` 这类业务关键词；最新错误不被最早那一批挤掉 |
| **R7** | `pruneSession` 返回 `{pruned, bytesRemoved, charsRemoved}`；多 text block 按块裁剪；append 失败中止本趟 | 与官方裁剪器返回结构对齐，stdout/stderr 分块不丢边界 |
| **R8** / P2-3 | `last-boot.json` + `last-pass.json`；布尔配置强类型校验 | 「装了但没裁过」现在一眼能查；`readTrim: "true"` 这类拼写不再静默失效 |
| **R9** / P1-6 | > 20000 行输入中段等距抽样分类（此模式 `meta.w = -1`）；孤立代理项改为字符串层归一化 | 10 MB 行密集输入不再同步阻塞数秒；10 MB 含孤立代理项的峰值 RSS 从约 5 倍降到约 1 倍 |
| **R10** | 推荐配置（见「配置」末尾，含 shadow 观察期） | 开箱更接近实测最优配置 |
| P2-6 / P2-7 | `Exit Code:` 与 `<persisted-output` 只认**行首**形态 | 读到含这些字样的正文/源码时不再整段透传 |

## 安全边界

1. **认不出来就原样透传** —— 绝不猜测、绝不破坏结构化输出。
2. **输入不超过预算就不动** —— 而不是「输出不长就无脑截断」。
3. **分层保留** —— 绝不让噪音把真错误挤出采样窗口。
4. **丢了能回查** —— 普通模式原文落盘，标记带路径；Read 模式不落盘，但标记会给出可回查的行号区间。
5. **失败现场透传** —— 工具结果 `isError` 为真、Bash 行首 `Exit Code: N` 非 0 时整段不动。
6. **任何异常静默透传** —— 单个工具结果失败只跳过它，绝不挂住会话。

> 落盘是**不加密的纯文本**，默认在用户目录 `~/.dsh/context-compression/spill` 下。
> 如果工具输出里常有密钥/token，请配置 `spill.enabled: false`，代价是裁剪后无法回查原文。

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

1. 日志出现 `dsh-context-compression 2.1.0 active (...)`，括号里带解析后的
   budget / readTrim / shadow / spill / stats 目录（`debug: true` 可打开每次决策的明细）；
2. `statsDir/last-boot.json` 出现（这是「插件真的加载了、配置真的解析成这样」的证据）；
3. 长工具输出被替换成 `… [dsh-ctx 省略 N 行（第 a–b 行）；…] …`。

如果第 2 步的文件没出现，多半是插件没加载成功（先看 DSH 日志里的配置错误），
也可能是 `statsDir` 不可写（诊断写入失败会被静默吞掉，不影响裁剪）。

## 怎么确认它真的裁过

2.0 踩过一个坑：日志里三条 `active`，但 `statsDir` 一直是空的——因为旧版**只在有决策时**才写统计，
所以「没触发过 compaction」和「装了但坏了」看起来一模一样。2.1 补了**加载痕迹 + 每趟汇总**两类
无条件写入（`last-boot.json` / `last-pass.json`），现在按下面的顺序查
（`statsDir` 默认 `~/.dsh/context-compression/data`）：

| 文件 | 什么时候写 | 看什么 |
|---|---|---|
| `last-boot.json` | 插件每次加载 | `version`（应为 `2.1.0`）、解析后的 `budgets` / `minBytes` / `readTrim` / `shadow` / `spill` / `statsDir`。**这是最终值，不是 patch 里的字面值**（比如 `minBytes` 会被抬到 ≥ 预算）。 |
| `last-pass.json` | **每趟 `pruneSession` 结束都写，0 裁剪也写** | `candidates`（候选工具结果数）、`trimmed`（真正裁了几条）、`bytesRemoved` / `charsRemoved`、`skippedFailed` / `skippedNoGain`、`aborted`、累计 `totals`。 |
| `last-trim.json` | 每趟结束（有决策时） | 最后一次决策的 `tool` / `reason` / `bytesBefore` / `bytesAfter` / `saved`，以及累计 `totals`。 |
| `saves-YYYY-MM.jsonl` | 每趟结束批量追加 | 逐条决策流水：`at` / `session` / `seq` / `tool` / `reason` / `bytesBefore` / `bytesAfter` / `charsBefore` / `charsAfter` / `shadow`。月份按 UTC。 |

排查顺序：

1. 没有 `last-boot.json` → 插件没加载成功，先看日志里的配置报错；
2. 有 `last-boot.json`、但**从来没有** `last-pass.json` → 插件活着，但装好后还没触发过一次 compaction；
3. `last-pass.json` 里 `candidates > 0` 而 `trimmed = 0` → 看 `skippedFailed`（失败现场按设计不裁）、
   `skippedNoGain`（裁剪后不比原文小），或去 `saves-*.jsonl` 看每条 `reason`；
4. `reason` 取值：`trim`（裁成功）、`short`（不值得裁：输入 ≤ 预算 / 无关键行可省 / 节省不足）、
   `read_off`（Read 关了 `readTrim`）、`persisted`（宿主已外置）、`idem`（已含标记）、
   `bash_failed`（Bash 失败现场）、`error`（引擎异常）；服务层另有 `tool_failed`（isError）、`no_gain`、`shadow`。

```bash
cat ~/.dsh/context-compression/data/last-pass.json
# Windows: Get-Content $HOME\.dsh\context-compression\data\last-pass.json
```

> 不要只靠「会话里有没有 `… [dsh-ctx` 这串字」判断：读到本仓库源码或文档时正文里也会出现它；
> 反过来，没触发 compaction 的会话里不会有任何标记。以 `statsDir` 的文件为准。
> 临时想看得更细：`debug: true` 会把每次决策打到 DSH 日志；`shadow: true` 则只统计、不改会话。

## 配置

全部配置写在 `cordis.patch.yml` 里本插件那一行的 `config:` 下，**不再读环境变量**。
**未知键直接抛错**（顶层、`budgets`、`minBytes`、`spill` 都校验），数值/布尔/路径类型也在加载时校验，
所以拼写错误会立刻在 DSH 日志里看到，而不是静默失效。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件总开关（布尔）。`false` 时插件加载但不注册服务、不裁剪、不写统计。 |
| `budgets` | `{bash: 4000, grep: 8000, glob: 8000, webFetch: 8000, read: 8000, default: 8000}` | 每个工具类的输出预算（UTF-8 字节），收敛到 `[2000, 131072]`。显式调小 = 更狠，调大 = 保留更多，单调生效。 |
| `minBytes` | 与 `budgets` 相同（`{bash: 4000, grep: 8000, glob: 8000, webFetch: 8000, read: 8000, default: 8000}`） | **兼容保留**：v2.1 起引擎不再读取它（触发只看「输入字节数 > 预算」），`resolveConfig` 仅把低于对应预算的值抬到预算并写进 `last-boot.json`。收敛到 `[0, 131072]`。 |
| `readTrim` | `true` | 是否裁剪 `Read` 结果（布尔）。触发与其它工具一致：字节数超过 `budgets.read`。 |
| `focusPatterns` | `[]` | 字符串数组，最多 **32** 条、每条最多 **128** 字符；命中的行按关键行（SKELETON）保留，Read 模式也生效。适合盯业务关键词，如 `["ORD-", "trace-"]`。 |
| `spill` | `{enabled: true, dir: ~/.dsh/context-compression/spill, days: 7}` | 原文落盘：开关（布尔）、根目录（非空字符串）、保留天数（收敛到 `[1, 365]`）。Read 模式不落盘。 |
| `shadow` | `false` | 影子模式（布尔）：只统计「本可省多少」、照常写诊断，**绝不改会话**。建议先跑一两天看收益。 |
| `minSaveBytes` | `300` | 节省不足这么多字节就不裁（非负数）。 |
| `minSavePercent` | `4` | 且节省不足这个百分比就不裁（非负数）。 |
| `statsDir` | `~/.dsh/context-compression/data` | 诊断/统计输出目录（非空字符串）：`last-boot.json` / `last-pass.json` / `last-trim.json` / `saves-YYYY-MM.jsonl`。 |
| `debug` | `false` | 通过 DSH logger 打印每次决策（布尔：工具、序号、原因、前后字节）。 |

> 默认目录从 `os.tmpdir()` 迁到 `~/.dsh/context-compression/{data,spill}`：Windows 上 DSH 每次重启会换
> `%TEMP%`，旧默认会让落盘原文与统计随重启一起消失。旧目录里的文件不会自动迁移。

示例：

```yaml
- id: context-compression
  name: dsh-context-compression
  config:
    readTrim: true            # 默认就是 true，写出来更醒目
    shadow: true              # 先影子模式观察
    budgets:
      bash: 6000              # 想保守一点就调大
    spill:
      days: 14
    statsDir: D:/dsh-stats
```

### 推荐配置（报告 §4-R10，含观察期）

```yaml
- id: context-compression
  name: dsh-context-compression
  config:
    readTrim: true            # 先配合 shadow 跑一周观察
    shadow: true              # 观察期；确认收益后再改成 false
    budgets:
      bash: 5000              # 4000 对报错日志偏紧，5000 通常能保 1~2 条根因
      read: 10000
    spill:
      days: 14
    statsDir: D:/dsh-stats    # 别放 %TEMP%，DSH 每次启动会换 TEMP
```

观察期建议：`shadow: true` 下照常写诊断、不改会话；一周后看 `last-pass.json` 里
`trimmed` 是否 > 0、`saves-*.jsonl` 里 `reason: "shadow"` 的 `bytesBefore - bytesAfter` 累计有多少，
确认后再把 `shadow` 改回 `false`。想更保守就把 `budgets` 调大（预算轴单调，调大只保留更多）。

## 已知限制

- **超大输入会抽样分类**：行数 > 20000 时，头段/尾段之外的中段按等距抽样分类（`MAX_CLASSIFY_LINES` /
  `SAMPLE_CLASSIFY_CAP`）。此时 `meta.w = -1` 表示弱关键词计数未知，中段**稀疏**的错误行**可能漏掉**；
  头段/尾段仍然全量分类。行号与「省略 N 行」仍按真实行数计算。
- **Read 裁剪后模型可能需要重新 Read**：符号行和错误行会保留，但中间实现细节被省略；
  标记给出行号区间，可用 `offset` 回查。
- **Read 里错误行优先于符号行**：符号行只能用错误行剩下的预算（累计 57% 额度内的余额），
  符号行特别多时会被截到条数上限/预算；`focusPatterns` 命中的行同样按 SKELETON 竞争额度，
  不保证一定出现。
- **WEAK 行可能出现在输出里**：WEAK 行不会被选为关键行，但如果它落在头段/尾段的保留区，
  会原样留在输出中（旧文档「永不进入输出」的说法不准确）。
- **单行超长会被截断**：单行 > 1000 字节时，保留行会被截断并补「（单行过长已截断，原文 N 字节）」；
  少行分支按 5/8 头 + 3/10 尾切分，极端预算下只留很小一段。
- **行号区间可能夹着已保留行**：标记会写「该区间内另有 N 行已保留在上/下文」，按 `a..b` 反推删除行时
  要注意别多算。
- **幂等只看行首标记**：正文以 `… [dsh-ctx ` 开头的文本（例如 Read 到本插件源码/文档）会被判 `idem`
  而不裁，这是已知取舍。
- **shadow 模式不写会话**：观察期只统计，不会真的减少上下文。

## 效果

### v2.1 实测（独立复测，2026-11-04）

**口径**：同一份 **107 会话快照 / 11,567 条真实工具结果 / 18.37 MB**、候选 **7,583 条**；
v2.0 也在**同一快照上重跑**，前后对比才公平。原评测报告是 103 会话 / 11,027 条 / 17.62 MB
（语料随本机会话增长），所以这里的 v2.0 数字与下面「原始评测报告」表**不能直接对比**。

| 指标 | v2.0 基线 | **v2.1 默认** | 官方 pruner |
|---|---|---|---|
| 裁剪条数 | 766 | **851** | 393 |
| 省下字节 | 4.95 MB | **6.86 MB** | 5.70 MB |
| 占候选字节 | 26.98% | **37.34%** | 31.01% |
| STRONG 存活（联合公平分母 2,925 行） | 85.88% | **83.79%** | 53.54% |
| STRONG 存活（各自裁剪集合口径） | 68.69% | **83.06%** | 31.67% |
| Read 被裁条数 | 0 / 1,145 | **229 / 1,145** | 182 / 1,145 |
| Read 的 STRONG 存活 | 100%（一条没裁，口径假象） | **96.52%** | 41.97% |
| 「白裁」（输入 ≤ 预算仍被裁） | 156 | **0** | 0 |

- 同一公平分母上 v2.1 vs 官方：STRONG 存活 **84.65% vs 56.43%**（v2.1 分类器口径，+28.22pp）。
- 压缩率停在 37.34% 而不是评测报告预估的 40%+：把 3pp 换成了「Read 里 96.52% 的关键行存活」，
  是有意的取舍。
- 对抗边界（53 例 + 38 项单元检查）：**P0 0 / P1 0 / P2 2**（v2.0 为 0/4/10）；
  行号 oracle（省略行数、区间端点、尾行号、短行省略字节、硬切）**0 失配**。
- 性能（同进程 median，括号为 v2.0）：10 MB 普通日志 **112 ms**（615 ms）、
  10 MB 行密集 524 万行 **203 ms**（4,813 ms）、10 MB 混合 **129 ms**（1,086 ms）、
  10 MB 超长单行 **~53 ms**（52 ms，持平；8 次交替专项 46.2 vs 45.6 ms，±3% 噪声内）、
  10 MB + 孤立代理项 **109 ms / 峰值 RSS 125 MB**（261 ms / 610 MB，-80%）。
- 完整报告见 `ctx-compress-eval/lead/OPTIMIZATION-RESULT.md`（本机评测目录，不在仓库内）。

> 「白裁」指输入字节 ≤ 该工具预算却仍被裁；v2.0 的 Read STRONG 存活 100% 只是因为一条 Read 都没裁，
> 属口径假象，不是真的更好。

### v2.0 实测（原始评测报告，2026-11-04，历史对照）

这是**优化前**的原始评测（16 组真实工程语料 1.0 MB + 2,470 条历史 STRONG 行），用于说明 2.1 改动的动机；
语料快照与口径都和上表不同，**不要直接对比**。它指出的两个最大缺口（Read 默认不裁、分类器漏
6 类关键行）正是 2.1 修掉的内容，见「2.1 改了什么」。

| 指标 | 插件 v2.0 | 官方确定性裁剪器 |
|---|---|---|
| 压缩率（16 组真实工程语料，1.0 MB） | **93.25%** | 92.15% |
| 真实历史 STRONG 行存活（2,470 条错误行） | **83.3%** | 54.7% |
| 中段事实存活（官方语料 21 条中段事实） | **6/21** | 0/21 |
| 真实历史压缩量（11,027 条工具结果） | 743 条 / 省 5.01 MB / 28.5% | 344 条 / 省 5.38 MB / 30.5% |
| 稳定不变量 | 幂等 38/38、确定性 48/48、`bytesAfter < bytesBefore` 0 违反 | — |

### 历史基线（1.1.1 独立对抗语料）

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

> ⚠️ 这组数字来自 **1.x 的 Python 参考引擎**，不是 2.1 JS 引擎重新跑出来的，只作历史对照。
> v2.1 起引擎行为已与 `reference/trim.py` 分叉（新增分类谓词、触发语义、标记文案），
> **不再以差分对拍作为验收门槛**：golden 夹具改为「自观测回归基线」——由
> `scripts/update-golden.mjs` 用当前引擎生成 `tests/engine/fixtures/golden.json`，
> 测试断言「引擎输出 = 最近一次确认的输出」。口径详见 [docs/ENGINE-SPEC.md](docs/ENGINE-SPEC.md)。

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
node scripts/update-golden.mjs     # 用当前引擎重新生成 golden 夹具（自观测基线）
```

写法、作用域与禁止事项见 [CONTRIBUTING.md](CONTRIBUTING.md)；算法契约见
[docs/ENGINE-SPEC.md](docs/ENGINE-SPEC.md)。

> `scripts/differential.mjs` 是与 1.x Python 参考实现做差分的**历史工具**，v2.1 起不再作为验收门槛
> （行为已分叉），保留仅为追溯 2.0 的移植过程。

## 许可

[MIT](LICENSE)
