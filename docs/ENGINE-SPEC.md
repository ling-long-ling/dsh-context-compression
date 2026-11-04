# dsh-context-compression 2.1 · 工具结果裁剪引擎实现契约（lib/engine）

本文件是 `lib/engine`（纯 ESM JavaScript，无构建步骤）的行为契约。引擎只做一件事：
把一段工具输出文本按 **STRONG / SKELETON / WEAK** 分层裁剪到字节预算内，并给出可 Grep 回查的省略标记。

**v2.1 口径（重要）**：本 SPEC 只描述 **JS 实现**（`lib/engine`），不再描述任何「与 Python 参考实现
逐字节对齐」的承诺。1.x 时代有 `hooks/trim.py`（参考实现）与 `src/trim.cpp`（C++ 原生实现）两份实现，
要求逐字节一致（parity）；2.0 只保留 JS 一份实现；**v2.1 起行为已与 `reference/trim.py`
（不随包发布的开发期参考实现）分叉**
（新增分类谓词、触发语义改为纯字节、标记文案扩展、抽样分类），因此：

- `scripts/differential.mjs` 保留为**历史工具**，可用来追溯 2.0 的移植过程，**不再作为验收门槛**；
- golden 夹具（`tests/engine/fixtures/golden.json`）改为**自观测回归基线**：由
  `scripts/update-golden.mjs` 用**当前引擎**生成，测试断言「引擎输出 = 最近一次确认的输出」，
  不再断言「与 Python 输出一致」。改判定逻辑时重跑该脚本并 review diff，就是在更新基线；
- 单实现下，本节所有常量、谓词、取整方向、标记文案仍按「可逐字节复现」的精度写死：
  同一输入 + 同一配置必须产生逐字节相同的输出（确定性）。

> 命名约定：为方便对照历史契约，文中函数名沿用 1.x 的 snake_case
> （`classify_line` / `pick_spread` / `has_wb_ops_marker` …）；JS 实现用 camelCase
> （`classifyLine` / `pickSpread` / `hasTrimMarker`），语义、常量、取整方向以本文件为准。

---

## 0.1 字节与切片语义（JS 引擎必须遵守）

1. **所有谓词的字符集都是纯 ASCII**（`[A-Za-z0-9_.-]`、hex、空白、引号、`|` 等）。
   UTF-8 多字节序列的每个字节都 ≥ 0x80，不会落进这些字符集，因此「按字节扫描」与
   「按码点扫描」的**判定结果相同**。这是全局前提，也是所有分类器都用**显式字符扫描、不用正则**
   的根本原因：正则的 Unicode 语义与贪婪策略会让结果随实现漂移。
2. **所有长度 / 预算 / 计数一律按 UTF-8 字节计**：`Buffer.byteLength(s, 'utf8')`。
   **禁止**把 `String.prototype.length` 当字节数（中文/emoji 会差 3–4 倍）。
3. 前缀 / 后缀 / 截断必须**落在 UTF-8 字符边界**上：`u8_prefix` / `u8_suffix` / `json_safe_prefix`
   不得切开一个多字节字符（也不能把代理对切成孤立半对）。
4. 以下位置**必须显式按字节**：
   - `has_win_path`：按字节扫描（`is_word_byte` / `is_path_byte` 都是字节版）；
   - `has_hex_token`：按字节扫描，且 24 字节前缀窗口也按字节切；
   - `is_json_key`：键宽用 `blen(key) <= 80`，不是码点数；
   - `display_line`：是否超长用字节数判断（`blen(line) > MAX_LINE_BYTES`）；
   - `persisted` 检查：`text` 的**前 4000 字节**内查找 `<persisted-output`，
     且命中位置必须是行首或全文开头（v2.1 / P2-7）；
   - `has_trim_marker`（幂等）：按字节查找 needle
     `E2 80 A6 20 5B 64 73 68 2D 63 74 78 20`（即 `… [dsh-ctx `，13 字节），
     命中位置是字节 0 或前一字节为 `0x0A`（见第 5 节）；
   - `strong_signature`：数字/空白/`A-Z` 全是 ASCII 判定，多字节 UTF-8 字节只会被原样拷贝；
     **变换后取 UTF-8 编码的前 96 字节原样作为分组键（bytes）**，不做 UTF-8 解码、
     不补 U+FFFD（见 4.3.2）。
5. **ANSI 只影响分类，不影响输出**：`is_strong_line` / `is_skeleton_line` 在判定前先剥
   CSI 序列（`\x1b[<params/intermediates><final>`，v2.1 / P2-8），其余 ESC 序列原样保留；
   被保留的行进输出时仍是原始字节（带 ANSI）。
6. **孤立代理项归一化在字符串层完成**（v2.1 / R9）：每个孤立代理项替换成 3 个 U+FFFD
   （等价 Python `encode("utf-8","surrogatepass")` 再 `decode("utf-8","replace")` 的语义），
   不再构造逐字节整数数组；合法字符串零开销快路径。
   `bytesBefore` 仍取**原始输入**的字节数（P2-2），不因归一化放大。

---

## 0.2 保留策略变更总览（1.1.1 引入，2.0 沿用，2.1 调整）

| 编号 | 原始问题 | 保留策略 |
|---|---|---|
| **O1b** | 根因被级联错误淹没 | strong 行**超出条数上限才**按签名归并；每组按配额保留（首条 + 等距取样），8 条不同 `step=` 的真错误在上限内完全不动 |
| **O2** | 预算非单调（调大预算反而压得更狠） | 触发与裁剪目标分离：`eff` 恒等于预算。**v2.1 进一步简化为纯字节触发**：`tbytes <= eff` 直接不裁，门槛/行数分支废除（见 4.1） |
| **O3** | 填充方向 | 首因优先：每组首条（= 首个出现 = 根因）排到 strong 候选末尾，`fill_recent` 从后往前挑 → 根因拿到最高填充优先级 |
| **F2** | 条数天花板 / 关键行只取最近 | 条数上限改为「基线 + 预算自适应」`adaptive_count()`（`//32`，硬顶 128）；关键行候选改为**全区间等距取样** `pick_spread()` |
| **F6** | `[dsh-ctx ` 子串误判幂等 + `read_off` 被抢答 | 幂等判定锚定**行首标记结构** `has_trim_marker()`；入口判定顺序里 `read_off` 提到 `idem` 之前 |
| **R1/R2**（v2.1） | 分类器漏检 7 类关键行、Read 默认不裁 | 新增 K9–K13 谓词与自定义异常规则；Read 默认开启、按字节触发、同时保留 STRONG 行（§3.2 / §3.3 / §3.5） |
| **R3**（v2.1） | 输入已在预算内仍被裁 | 入口即 `tbytes <= eff → return None`；`min_bytes` 不再参与判定（§4.1） |
| **R5/R6**（v2.1） | 标记数字失真 / 归并保留最早一批 | 行号不再 +1、区间注明已保留行、少行分支固定点求解、归并超上限改为先保根因（§4.2 / §4.3.3 / §4.4） |
| **R9**（v2.1） | 行密集输入同步阻塞、代理项内存放大 | > 20000 行中段等距抽样分类；代理项字符串层归一化（§4.3.8 / §0.1） |

**v2.1 收口（复核后又做的两处行为细化）**：

- **strong 候选不再排除尾段**：`strong_cand = strong_all`。旧版 `i < tail_lo` 会把落在最后 N 行里的
  错误行挤出关键行候选，只能靠尾段填充捡回来——尾段预算不够就整条丢了。现在它们照常参与挑选，
  尾段填充用 `taken` 去重，不会重复输出。
- **Read 模式错误行优先**：档位改为 **4 = 真错误 / 3 = 符号行**；错误行先占 45% 预算，符号行只能用
  累计 57% 的剩余额度（条数基线下限 `READ_SYMBOL_MIN_LINES = 64`）。`meta.k` 只数错误行，
  符号行计入 `meta.g`（普通模式 k/g 语义不变）。

---

## 1. 常量（引擎内写死，不可由调用方覆盖，除注明「options 可覆盖」者）

```
# ---- 触发与预算 ----
MAX_LINES           = 120      # 已废弃（v2.1）：行数触发取消，保留导出仅兼容旧调用方，引擎不消费（R3）
MAX_BYTES           = 8000     # 引擎默认预算兜底；实际用调用方解析好的 budgetBytes
HEAD_LINES          = 50
TAIL_LINES          = 25
MAX_STRONG_LINES    = 40       # strong 基线；实际上限 = adaptive_count(段配额, 它)
MAX_SKEL_LINES      = 40       # skeleton 基线；v2.1: 24 → 40（YAML/KV 类会挤掉别的关键值）
ADAPTIVE_LINE_BYTES = 32       # 条数上限 = 段字节配额 // 32
ADAPTIVE_LINE_CAP   = 128      # 自适应条数硬顶
MIN_LINE_BYTES      = 60
MAX_LINE_BYTES      = 1000
MARKER_RESERVE      = 480      # 标记**固定部分**预留；实际还要扣落盘路径实长 + 64（见 4.3.1）
SPILL_DAYS          = 7        # options.spillDays 的默认值
SPILL_SCAN_CAP      = 500
SECTION_STRONG      = 45       # strong 独占预算占比 %（先填）
SECTION_SKEL_ADD    = 12       # 追加给 skeleton 的预算 %（累计到 57%）
SECTION_HEAD        = 30       # 再追加给头段的预算 %（累计到 87%）
                               # 剩余 13% 留给尾段，实际以硬上界为准
READ_MIN_LINES      = 0        # v2.1: 保留导出（旧门槛），不再参与判定（Read 按字节触发）
READ_HEAD_LINES     = 200
READ_TAIL_LINES     = 120
READ_SYMBOL_MIN_LINES = 64     # v2.1 收口：Read 符号行条数基线下限（错误行优先后，符号行只剩累计 57% 的余额）
MAX_CLASSIFY_LINES  = 20000    # v2.1: 行数超过它时只分类头段 + 尾段 + 中段等距抽样
SAMPLE_CLASSIFY_CAP = 12000    # v2.1: 抽样后中段最多分类的行数
MIN_SAVE_BYTES      = 300      # options.minSaveBytes 默认值：节省不足 300 字节不裁
MIN_SAVE_PCT        = 4        # options.minSavePercent 默认值：且节省不足 4% 不裁
```

`MAX_STRONG_LINES` / `MAX_SKEL_LINES` / `READ_SYMBOL_MIN_LINES` 只是基线：实际条数上限由
`adaptive_count(段字节配额, 基线)` 计算（见 4.3.5），预算越大允许保留的条数越多，但不会超过 128。
其中 `MAX_LINES` 已废弃（v2.1 行数触发取消），保留导出仅为兼容旧调用方。

预算与触发门槛的**默认值**由 `lib/config.js` 解析后传给引擎；引擎只使用已解析的 `budgetBytes`
（`minBytes` 仅透传、不参与判定），**不读环境变量、不读配置文件**：

| 配置 | 默认值 | 说明 |
|---|---|---|
| `budgets` | `{bash: 4000, grep: 8000, glob: 8000, webFetch: 8000, read: 8000, default: 8000}` | 每工具类字节预算，收敛到 `[2000, 131072]` |
| `minBytes` | **与 `budgets` 相同**（v2.1：`DEFAULT_MIN_BYTES` 已与 `DEFAULT_BUDGETS` 对齐） | 触发门槛，收敛到 `[0, 131072]`；`resolveConfig` 把低于对应预算的值抬到预算。**v2.1 引擎不再读取它**（触发恒为 `tbytes > budget`），只作为兼容键与 `last-boot.json` 记录 |
| `readTrim` | `true`（v2.1 起） | Read 裁剪总开关 |
| `focusPatterns` | `[]` | 用户显式关键词，≤ 32 条、每条 ≤ 128 字符 |
| `spill.enabled` / `dir` / `days` | `true` / `~/.dsh/context-compression/spill` / `7` | 落盘开关（布尔）、目录（非空字符串）、保留天数 `[1, 365]` |
| `statsDir` | `~/.dsh/context-compression/data` | 诊断目录（非空字符串） |
| `shadow` / `debug` / `enabled` | `false` / `false` / `true` | 布尔，强类型校验（传字符串抛错） |
| `minSaveBytes` / `minSavePercent` | `300` / `4` | 非负数 |

---

## 2. 引擎入口

```js
// lib/engine/index.js
export const ENGINE_VERSION = '2.1.0';

/**
 * @param {{ text: string, tool: 'Bash'|'Grep'|'Glob'|'WebFetch'|'Read' }} input
 * @param {{
 *   budgetBytes: number,     // 已解析的字节预算（触发与目标都是它）
 *   minBytes: number,        // 已解析的门槛；v2.1 保留字段，引擎不读取
 *   readMode: boolean,       // tool === 'Read'（决定用 Read 的裁剪策略）
 *   readTrim?: boolean,      // Read 裁剪总开关（false 时返回 read_off）
 *   spillEnabled: boolean,
 *   spillDir: string,        // 落盘根目录
 *   spillDays: number,
 *   sessionId: string,
 *   focusPatterns?: readonly string[] | null,  // v2.1: 命中即按关键行保留
 *   minSaveBytes?: number,   // 默认 300
 *   minSavePercent?: number, // 默认 4
 *   now?: () => number,      // 测试注入
 * }} options
 * @returns {{
 *   text: string|null,                // null = 原样透传；否则为压缩结果（标记已内嵌）
 *   meta: { k: number, g: number, w: number, p: 0|1 },
 *   bytesBefore: number,
 *   bytesAfter: number,
 *   reason: 'trim'|'short'|'read_off'|'persisted'|'idem'|'bash_failed'|'error',
 * }}
 */
export function trimToolText(input, options) {}
```

- `text === null` 表示「原样透传」（不裁剪），`reason` 说明原因；非 null 时 `text` 已含省略标记。
- 引擎是**纯函数 + 落盘 IO**：除写原文落盘文件外不产生副作用；异常一律在入口被收敛为
  `reason: 'error'`，绝不向调用方抛出。
- 上层（`lib/index.js`）负责会话事件遍历、失败现场（`isError`）透传、shadow 模式与
  会话写回；引擎只负责单段文本的判定与裁剪。判定顺序见第 5 节。

---

## 3. 行分类：`tier_of(line) -> 0|1|2|3`（普通）/ `0|2|3|4`（Read）

普通模式走 `classify_line(line)`：`0` 普通 / `1` WEAK / `2` SKELETON / `3` STRONG，
**顺序：先 strong，再 skeleton，最后 weak**。Read 模式走自己的两档判定（见 §3.5）：
`4` = 真错误 / `3` = 符号行 / `2` = `focusPatterns` 命中 / `0` 普通。
两种模式下 `focusPatterns` 都只对 tier < 2 的行生效（不会把 tier 3/4 降级）。

### 3.1 基础工具

- `is_word_char(c)`：ASCII `[0-9A-Za-z_]`
- `find_word(line, tok, ci)`：tok 两侧都必须是「词边界」（左为起始或前一字符非词字符；
  右为末尾或后一字符非词字符）；`ci` 只折 ASCII 大小写（`ascii_lower`）
- `find_word_prefix(line, tok)`：左边界词边界、右侧不限（等价 `\b<tok>\w*`，大小写不敏感）
- 中文关键词按**子串**匹配（中文无词边界概念）
- `lstrip_ws(line)`：剥 `' ' '\t' '\r' '\v' '\f'`；`rstrip_sp_tab_cr`：剥 `' ' '\t' '\r'`
- `strip_ansi(s)`：v2.1 起 strong / skeleton 判定入口先剥 CSI；无 ESC 时零开销返回原串。

### 3.2 STRONG（普通模式 tier 3；Read 模式 tier 4）

判定前若行内含 `\x1b`（ESC），先 `strip_ansi` 得到 `s`；以下规则都在 `s` 上做：

1. **整词命中（大小写敏感，全文任意位置）**，逐个 `find_word`：
   `ERROR`, `Error:`, `FAILED`, `FAIL`, `FATAL`, `Fatal`, `fatal:`, `panic:`, `Traceback`,
   `Exception`, `OSError`, `TypeError`, `KeyboardInterrupt`, `ModuleNotFoundError`,
   `ImportError`, `PermissionError`, `FileNotFoundError`, `NotADirectoryError`,
   `EACCES`, `EPERM`, `ENOENT`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`,
   `EADDRINUSE`, `ENOTFOUND`, `EHOSTUNREACH`
   > 说明：整词要求保证 `isError` / `failover` / `errorCode` / `warningLevel` **不会**进入 strong。
2. **行首告警**：`lstrip_ws` 后以 `warning:` 或 `WARNING:` 开头，且其后紧接空格/制表/回车或行尾。
3. **子串（大小写敏感）**：`Segmentation fault`、`core dumped`、`No such file or directory`、
   `npm ERR!`、`npm error`（v2.1：现代 npm ≥ 8 的小写错误行）。
4. **`error[E<digits>]`**：出现 `error[E`，其后至少 1 个 ASCII 数字，紧跟 `]`。
5. **`error TS<digits>`**：出现 `error TS`，其后至少 1 个 ASCII 数字。
6. **自定义异常类名（v2.1 / P1-5）**：出现 `Error:` 或 `Exception:`，且其**左侧 token 以 `A-Z` 开头**。
   实现是 `has_error_colon_token`：从 needle 位置向左吃到词边界，看 token 首字符是否 `A-Z`。
   > `AssertionError:` → token `AssertionError` 大写开头 → true；
   > `isError: false,` / `errorCode: 0` → token 小写开头 → false（配置键不会被误判成错误）。
7. **`Exit Code: <nonzero>`（v2.1 / P2-6：只认行首形态）**：从全文**最后**一处 `Exit Code:` 开始，
   向左跳过空格/制表；若再往左是行首（或全文开头/换行），取该处解析；否则继续找**前一处**
   行首形态的 `Exit Code:`（都找不到返回 false）。命中后向右跳过空格/制表、允许一个 `-`、
   紧接至少 1 位数字，该数值（带符号）非 0。
   > 行首判定：`Exit Code:` 前只允许多个空格/制表，再往前必须是 `\n`、`\r` 或全文开头。
   > （与文本形态 Bash 失败的判定完全同一函数；被回显/引用的 `Exit Code: 1` 不再让整段透传。）
8. **中文子串**：`错误`、`失败`、`异常`、`致命`、`崩溃`

### 3.3 SKELETON（tier 2，且不是 strong）

同样先剥 ANSI；`t = lstrip_ws(s)`：

- **K1 KEY=VALUE**：`t[0]` 是 `A-Z`；随后连续 `[A-Z0-9_]` 至少再 2 个字符（即键总长 ≥ 3）；
  然后跳过空格/制表；下一个字符是 `=`。
- **K2 表格行**：`t[0] == '|'`，且 `rstrip(' \t\r')` 以 `|` 结尾，且 `|` 至少 2 个。
- **K3 diff 头**：`t` 以 `---` / `+++` / `diff --git` / `@@ ` 之一开头。
- **K4 URL**：出现 `http://` 或 `https://`，且 `://` 之后紧跟至少 1 个非空白字符，
  且 `http` 前是行首或非词字符。
- **K5 POSIX 绝对路径**：存在一段 ≥2 个以 `/` 分隔的连续段，段字符集 `[A-Za-z0-9._-]`，每段非空。
- **K6 Windows 绝对路径**：`<letter>:\`，前一字符为行首或非词字符，
  其后至少 3 个 `[A-Za-z0-9._\-\\]` 字符，且其中至少一个 `\`。
- **K7 独立 hex（commit / sha / 容器 ID）**：连续的 `[0-9a-fA-F]` 串，长度 `7..64`，左右两侧为词边界，
  且串内至少含一个 `a-f` 字母（排除纯十进制）；长度 ≥ 12 直接算；长度 7..11 时要求其前 24 字节
  （小写化后）含 `sha` / `commit` / `rev` / `hash` / `digest` / `version` / `tag` / `@` 之一。
- **K8 JSON 顶层键**：`t[0] == '"'`，其后 1..80 **字节**内出现 `"`，再跳过空格/制表后紧跟 `:`。
- **K9 小写/混合大小写 `key: value`（v2.1 / R1 / P1-5）**：`t[0]` 是 `a-z`；键体只含
  `[a-z0-9_.-]`、键长 < 64 字符；紧跟 `:`；冒号后跳过空格/制表必须有非空值；值不能以 `/` 开头
  （排除 `http://` 这类 URL，URL 由 K4 负责）；**`t`（去行首空白后）≤ 200 字节**。
  > 覆盖 k8s manifest、GitHub Actions workflow、docker-compose、frontmatter：
  > `image: registry.example.com/app:v1`、`runs-on: ubuntu-latest`、`replicas: 3`。
- **K10 `path:line` / `path:line:col`（v2.1 / P1-5）**：出现 `:`，其后 1..9 位数字，数字后是
  行尾 / 空格 / 制表 / `:` / `,` / `)` 之一；冒号左侧紧邻 token 必须含 `.`、`/` 或 `\`
  （否则 `12:30`、`2026-10-20T12:00` 会误判）。
  > 覆盖编译器定位（`src/x.rs:261:9`）、`grep -n` 命中、Java/Rust 堆栈里的 `File.java:42`。
- **K11 MAC 地址（v2.1 / P1-5）**：6 组 2 位 hex，用 `-` 或 `:` 分隔；左右边界不能是 hex 字符
  （避免命中有更长的 hex 串）。覆盖 ipconfig / ifconfig。
- **K12 `host:port`（v2.1 / P1-5）**：端口 1..5 位数字，其后必须是空格 / 制表 / `\r` / `,` / `)`
  / `]` / `}` / `;` / `'` / `"` / `-` / `/` 之一；`:` 左侧 host 由 `[A-Za-z0-9._-]` 组成
  （1..255 字符）且**至少含一个字母或 `.`**；左侧 ≥ 10 字符且形如 `NNNN-` 的日期前缀不算。
  另支持 IPv6 方括号形态 `[::1]:8080`（冒号左边是 `]`，向前找 `[`，端口后须为行尾/非词字符）。
  > 排除 `12:30`、`2026-11-01T00:00:59`、`12:30:45` 这类时间戳；覆盖 netstat / docker ps
  > （`0.0.0.0:8080->80/tcp`）/ 连接日志。
- **K13 diff 的 `+`/`-` 骨架行（v2.1 / P1-5）**：`t` 以 `+` 或 `-` 开头（但 `---` / `+++` 除外），
  且行内含 `export ` / `def ` / `class ` / `function ` / `import ` / `struct ` / `interface ` / `const `
  之一。覆盖 git diff 里的新增代码骨架。

> 条数与取样仍是闸门：新增谓词只提高**分类优先级**，`MAX_SKEL_LINES`（v2.1: 40）与
> `pick_spread` 等距取样决定最终保留多少条，不会变成「全留」。

### 3.4 WEAK（tier 1，且不是 strong / skeleton）

- 词首前缀（大小写不敏感，等价 `\bwarn\w*`）：`warn`、`fail`、`timeout`
- 整词（大小写不敏感）：`cannot`、`error`、`errors`、`timed out`
- 中文子串：`警告`、`无法`、`未能`、`超时`

> **v2.1 修正（P2-5）**：WEAK 行**不会作为关键行被选中**，但它可能落在头段/尾段的保留区里
> 而**原样出现在输出中**。旧文档「WEAK 行永不进入输出」与实现不符，已废弃。
> 标记里的「N 行弱关键词未展开」只统计**未被显示**的 WEAK 行；抽样分类模式下该计数未知，
> `meta.w = -1`。

### 3.5 Read 模式（v2.1 收口：4 = 错误行 / 3 = 符号行）

不做普通模式的三级分类，而是**错误行优先**的两档：

```
tier = 4 if is_strong_line(line)            # 真错误：优先级最高
     = 3 elif is_symbol_line(line)          # 符号行：SYMBOLS 子串表（函数/类/import 骨架）
     = 0 otherwise
if tier < 2 and focus_pattern_hit(line): tier = 2   # focusPatterns 命中的普通行
```

- **错误行先占 45% 预算**（`capStrong`），**符号行只能用累计 57% 里的剩余额度**（`capSkel`，
  条数基线下限 `READ_SYMBOL_MIN_LINES = 64`）；详见 4.3.4 的 1b 步。
  动机：一个 150 个 `def` 的文件会把 30 条 `TypeError` 全挤掉——复核实测不分开时错误行只留
  18/30，分开后 **30/30**，符号行 93/150 → **131/150**。
- `focusPatterns` 命中的普通行记 tier 2，与符号行竞争同一份额度（见 4.3.4 第 2 步）。
- `meta`：`k` = 保留的错误行数，`g` = 保留的符号行 + tier 2 行数（见 4.7）。
- Read 模式**不落盘**（源码本身可用 offset 重读，落一份全量源码只是重复占磁盘），
  标记里不带原文路径；不做 weak 统计（正常 `meta.w = 0`；若进入 4.3.8 的抽样分类模式，
  按统一规则记 `-1`）。

---

## 4. 裁剪流程（内部函数 `trimText(text, params) -> { text, meta, bytesAfter } | null`）

`params` 由入口（第 2 节）拆出：`tool`、`readMode`、`budgetBytes`、`minBytes`（保留字段）、落盘三件套、
`focusPatterns`、`minSaveBytes` / `minSavePercent`、`now`。返回 `null` = 不需要裁剪
（输入 ≤ 预算 / 收益不足 / 退化）。

### 4.1 触发（v2.1：纯字节，门槛与行数分支废除）

```
budget_bytes = options.budgetBytes            # 触发阈值与裁剪目标都是它
eff          = budget_bytes
tbytes       = blen(text)
read_mode    = options.readMode

if tbytes <= eff: return None                 # ① v2.1 / R3：输入已在预算内，没有压缩空间
lines = split_lines(text)                     # 末尾换行不产生空行（见 4.2 / R5）
total = len(lines)
if total <= 0: return None
head_n, tail_n = (READ_HEAD_LINES, READ_TAIL_LINES) if read_mode else (HEAD_LINES, TAIL_LINES)
```

- **不再有**「超 minBytes」「超 MAX_LINES 行」这类分支；`min_bytes` 与 `MAX_LINES`（已废弃导出）/
  `READ_MIN_LINES`（旧门槛）都只作兼容保留、不参与判定（因此「行多但总字节小」的输出不裁）。
- `split_lines`：`text.split('\n')` 后，若末尾是空 token 则**丢弃它**（末尾换行不产生第 N+1 行，
  因此行号不会 +1，P1-8）；再按**多数行尾**决定输出行尾：`\r\n` 行数 × 2 > 总行数时用 `\r\n`，
  否则 `\n`；CRLF 输入的各行去掉行尾 `\r`（P2-9）。输出用同一 `eol` 拼接。

### 4.2 少行分支（`total <= head_n + tail_n + 5`）

- `avg = tbytes // max(total,1)`；若 `avg > 200` 或 `total <= 3` → **按字节截首尾**：
  - 标记用固定点求解（最多 4 次迭代，P1-7）：
    ```
    omitted = tbytes
    for iter in 0..3:
        marker = "\n… [dsh-ctx 省略 {omitted} 字节"
                 + ("（单行过长已截断，原文 {tbytes} 字节）" if total<=3 else "")
                 + ("；原文 {path}，可 Grep 回查" if 落盘成功 else "")
                 + "] …\n"                       # 行尾用主导 eol
        avail  = eff - blen(marker)
        head   = json_safe_prefix(text, avail*5//8)   # avail<=0 时为空
        tail   = u8_suffix(text, avail*3//10)
        kept_original = blen(head) - inserted_note_bytes(head) + blen(tail)
        omitted = tbytes - kept_original
        if omitted == 上一轮: break
    ```
  - 即「省略 N 字节」= 输出里没有出现的**原文字节**，并扣掉 `json_safe_prefix` 自己插入的
    「…（单行过长已截断，原文 M 字节）」标注字节（标注不是原文，不能算已保留）——标记数字
    不再因硬切而少算。
  - `res = head + marker + tail`，走 4.6 的统一收尾。
- 否则**按比例收缩头尾**：`head_n = max(1, total*50//100)`、`tail_n = max(1, total*25//100)`，继续 4.3。

`json_safe_prefix(s, limit)`：`limit` 落在 UTF-8 字符边界上（回退到前一完整字符）；
若 `s.lstrip()` 以 `{` 或 `[` 开头，则在 `[limit-200, limit]` 区间内**从后往前**找第一个
`,` `` `}` `` `]` `` `"` 字节，找到了就切在其后。切过（`cut < 原长`）时补
`…（单行过长已截断，原文 {N} 字节）`；标注放不下就逐字符缩短，最终退化为纯 `…`
（总字节数 ≤ limit）。

### 4.3 候选选择与填充

#### 4.3.1 分层预算

```
# v2.1 / P1-7：标记预留 = 固定部分 + 落盘路径实长的 spillSuffix + 64 字节余量
budget     = max(500, eff - (MARKER_RESERVE + blen(spill_suffix(spill_path)) + 64))
cap_strong = budget * SECTION_STRONG // 100              # 45%
cap_skel   = cap_strong + budget * SECTION_SKEL_ADD // 100  # 累计 57%
cap_head   = cap_skel + budget * SECTION_HEAD // 100     # 累计 87%
used       = 0
tail_lo    = total - tail_n
```

`//` 为整数除法（所有操作数非负；JS 用 `Math.floor`）。因为标记与落盘路径的实长已被前置扣除，
正常路径不再触发 4.6 的硬收口。

> Read 模式下 `cap_skel` 同时是**符号行**的上限：错误行先占 `cap_strong`（45%），符号行与
> skeleton 共用累计 57% 的额度——`used` 里已经记了错误行占用，所以符号行实际只能用
> 45%→57% 之间的空间（`READ_SYMBOL_MIN_LINES = 64` 保证条数基线）。

**落盘时机（v2.1 / P1-4）**：普通模式在分类**之前**就落盘（有没有关键行都落盘，成本只是磁盘），
标记里才能给出回查路径；Read 模式 `spill_path = null`（不落盘）。

#### 4.3.2 `strong_signature(line)` —— O1b 的签名（**只作分组键，不进输出**）

```
out = []            # 输出字符序列
prev_digit = False  # 上一个输入字符是不是 ASCII 数字
prev_sp    = False  # 上一个输入字符是不是空白（' ' / '\t' / '\r'）
for ch in line:
    o = ord(ch)
    if 48 <= o <= 57:                       # 数字：整段折叠成一个 '#'
        if not prev_digit: out.append('#')
        prev_digit = True;  prev_sp = False
    else:
        prev_digit = False
        if ch in (' ', '\t', '\r'):         # 空白：整段折叠成一个空格（仅当已有输出）
            if (not prev_sp) and out: out.append(' ')
            prev_sp = True
        else:
            out.append(chr(o + 32) if 65 <= o <= 90 else ch)   # A-Z 只折 ASCII 小写
            prev_sp = False
s = "".join(out).strip(' ')                 # 只剥 ASCII 空格（制表/回车已被折叠）
sig = s.encode("utf-8", "replace")[:96]     # bytes 前缀：只作分组键，不 decode
return sig
```

**实现要点**：

1. 数字/空白/`A-Z` 的判定全在 ASCII 范围，多字节 UTF-8 的字节都 ≥ 0x80，只会被原样拷贝。
2. `strip(' ')` 只剥 `0x20`，不剥 `\t` / `\r`。
3. 截断取的是**字节前缀**，不是「回退到字符边界」：直接取前 96 字节原样作分组键（`Buffer`）。
   **不要**补全或替换残缺的 UTF-8 序列——补 U+FFFD 会把两条不同的级联错误误并成一组。
4. 刻意不用正则、不用 `toLowerCase()`（非 ASCII 的 lower 可能改长度）。

#### 4.3.3 `dedup_strong(idx, lines, cap)` —— O1b 归并（超上限才动手）

```
if len(idx) <= cap: return list(idx), 0, set()      # 上限内完全不动（保 8/8 红线）
groups = {}   # 签名 -> 该组行号（Map 保持插入序）
order  = []   # 签名首次出现顺序（= 根因出现顺序）
for i in idx:
    sig = strong_signature(lines[i])
    if sig not in groups: groups[sig] = []; order.append(sig)
    groups[sig].append(i)

total = len(idx)
kept  = []
for sig in order:
    g     = groups[sig]
    quota = cap * len(g) // total                   # 按组大小分配（整数向下取整）
    if quota < 1: quota = 1                         # 每组至少 1 条
    if quota >= len(g): kept.extend(g); continue    # 配额够 -> 全留
    if quota == 1: kept.append(g[0]); continue      # 只留首条（= 根因）
    last = len(g) - 1
    for k in range(quota):                          # 等距取样，必含首条与末尾条
        kept.append(g[last * k // (quota - 1)])

kept = sorted(set(kept))
# v2.1 / R6（破坏旧行为）：超上限裁剪不再 kept[:cap]（那会保留"最早"的一批），
# 而是先保各组首条（根因），剩余名额从其余行里等距取样：
if len(kept) > cap:
    firsts_all = {g[0] for g in groups.values()}
    first_keep = [i for i in kept if i in firsts_all]
    rest       = [i for i in kept if i not in firsts_all]
    room       = max(0, cap - len(first_keep))
    kept       = sorted(first_keep + pick_spread(rest, room))
kept_set = set(kept)
firsts   = {g[0] for g in groups.values() if g[0] in kept_set}   # 各组首条中被保留的
return kept, total - len(kept), firsts
```

- 返回值：`(升序行号列表, 被归并掉的行数, 各组首条行号集合)`。
- `firsts` 只包含「首条本身仍在 `kept` 里」的组（被裁剪掉的不算），供 O3 用。
- 极端情形（首条条数本身就 > cap）下优先保根因，`first_keep` 可能超过 `cap`。

#### 4.3.4 填充顺序（O3 首因优先 + F2 全区间取样）

```
# 1) strong：归并 -> 首因优先 -> 从新到旧填进 cap_strong
#    v2.1 收口：候选 = 全部 strong 行（不再排除尾段区间）。以前 `i < tail_lo` 会把落在
#    最后 N 行里的错误行挤出关键行候选，尾段预算不够就整条丢了；现在照常参与挑选。
strong_cand = strong_all
strong_keep, strong_merged, strong_first = dedup_strong(
    strong_cand, lines, adaptive_count(cap_strong, MAX_STRONG_LINES))
if strong_first:
    strong_prior = [i for i in strong_keep if i not in strong_first]
    strong_prior += sorted(strong_first)        # 首因排到末尾 -> fill_recent 先挑它们
else:
    strong_prior = strong_keep
picked_s, used = fill_recent(strong_prior, lines, cap_strong, used)

# 1b) Read 模式的符号行（仅 read_mode）：错误行已先占 cap_strong（45%），
#     符号行只能用 cap_skel（累计 57%）里的剩余额度；条数基线 READ_SYMBOL_MIN_LINES(64)。
#     符号行候选仍不取尾段区间（尾段有自己的填充通道）。
picked_y = []
if read_mode and sym_all:
    taken_e = {i for i, _ in picked_s}
    sym_cand = [i for i in sym_all if i < tail_lo and i not in taken_e]
    picked_y, used = fill_recent(
        pick_spread(sym_cand, adaptive_count(cap_skel, READ_SYMBOL_MIN_LINES)),
        lines, cap_skel, used)

# 2) skeleton：不与 strong/符号行抢位；全区间等距取样 -> 从新到旧填进 cap_skel
#    （Read 模式下 skel_all 里只剩 focusPatterns 命中的 tier 2 行）
taken = {i for i, _ in picked_s} | {i for i, _ in picked_y}
skel_cand = [i for i in skel_all if i < tail_lo and i not in taken]
picked_k, used = fill_recent(
    pick_spread(skel_cand, adaptive_count(cap_skel, MAX_SKEL_LINES)),
    lines, cap_skel, used)

key_picked = sorted(picked_s + picked_y + picked_k)   # 合并后按行号升序输出
taken      = {i for i, _ in key_picked}

# 3) 头段：按行号升序填，跳过 key_picked 已占的行
head_idx = [i for i in range(0, head_n) if i not in taken]
head_shown, used = fill_forward_idx(head_idx, lines, cap_head, used)

# 3b) 尾段保底（P1-7 第二形态）：确保「原文最后一行」完整可见。
#     尾段名义上只分剩余 13%，落盘目录很长（标记预留被撑大）时连一行都放不下，
#     于是末行被截在中间、尾标记却仍声称「末尾 N 行」。这里从头段尾部回收空间：
last_idx = total - 1
if tail_n > 0 and last_idx not in taken:
    last_want = blen(display_line(lines[last_idx]).text) + 1
    while head_shown and used + last_want > budget:
        dropped = head_shown.pop()
        used -= blen(dropped) + 1
        if used < 0: used = 0

# 4) 尾段：同样跳过已输出的行；从尾往前挑、输出保持原序
tail_idx = [i for i in range(tail_lo, total) if i not in taken]
tail_shown, used = fill_backward_idx(tail_idx, lines, budget, used)
```

- **1b 步只在 Read 模式执行**：符号行的条数上限用 `READ_SYMBOL_MIN_LINES`（64）作基线，
  和 skeleton 共用 `cap_skel`；因为 `used` 已含错误行占用，符号行实际只能用 45%→57% 的余额。
- **3b 步是尾段保底**：必要时从已填头段尾部弹出展示行、同步扣减 `used`，换来末行完整。
  这样尾标记声称的行号区间与实际输出始终一致。

**O3 原理**：`fill_recent` 从候选列表**末尾往前**挑，所以把「每组首条（首个出现 = 时间最早 =
最可能的根因）」追加到 `strong_prior` 末尾，就等于给它最高填充优先级；输出顺序最后由
`sorted(...)` 按行号决定，不受候选顺序影响。

> 「只留最近 40 条 strong」的旧做法已删除：它会让最早出现的根因被级联错误挤掉。

#### 4.3.5 `adaptive_count(cap_bytes, base)` —— F2 条数上限

```
v = cap_bytes // ADAPTIVE_LINE_BYTES   # //32
if v < base: v = base                  # 不低于基线（strong 40 / skeleton 40 / Read 符号行 64）
if v > ADAPTIVE_LINE_CAP: v = 128      # 硬顶
return v
```

- strong 传入 `(cap_strong, MAX_STRONG_LINES)`；skeleton 传入 `(cap_skel, MAX_SKEL_LINES)`；
  Read 模式的符号行传入 `(cap_skel, READ_SYMBOL_MIN_LINES)`。
  —— 注意 skeleton 与 Read 符号行用的都是**累计 57%** 的 `cap_skel`。
- 因此预算越大允许保留越多条，但不会超过 128；预算很小时仍保住基线（40/40，Read 符号行 64）。

#### 4.3.6 `pick_spread(idx, cap)` —— F2 全区间等距取样

```
if cap <= 0 or not idx: return []
n = len(idx)
if n <= cap: return list(idx)
return [idx[(2*k + 1) * n // (2*cap)] for k in range(cap)]
```

- 取样点均匀铺满整个候选区间（首个 ≈ `1/(2cap)`，末个 ≈ `(2cap-1)/(2cap)`），**不是**只取最近的 `cap` 条。
- 返回行号仍升序；随后交给 `fill_recent` 按预算从新到旧填充。
- 乘除都按整数运算（JS 里优先 `Math.floor(a / b)`，避免位运算 32 位截断）。

#### 4.3.7 填充函数

- `fill_forward_idx(idx, …)`：按 `idx` 顺序逐行尝试，整行放得下就放；单行 >
  `MAX_LINE_BYTES` 先经 `display_line()` 自截；放不下且剩余 ≥ `MIN_LINE_BYTES+3` 时
  末行截断（补 `…`）后结束本段；否则直接结束本段。
- `fill_backward_idx(idx, …)` = 把 `idx` 反转后走 `fill_forward_idx`，结果再反转回来，
  因此**从尾往前挑、输出保持原序**。
- `fill_recent(idx, …)`：从 `idx` 末尾往前挑，结果保持行号升序；返回 `(列表, used)`，
  列表元素是 `(行号, 展示串)`。
- `display_line(line)`：`blen(line) > MAX_LINE_BYTES` 时取 `json_safe_prefix(line, MAX_LINE_BYTES)`
  的结果（已带标注）；`want` = 该展示串的字节数。
- `budget` 是硬上界：各段配额累加可能超过 `budget`，`fill_*` 只按 `used` 累计，
  最终 `res` 还会经 4.6 的 `finish()` 按 `eff` 字节二次收口。
- **尾段保底（v2.1 新增）**：填尾段之前，若「原文最后一行的展示字节 + `used` > 内容预算 `budget`」，
  就从**头段尾部**逐行弹出已填展示行、同步扣减 `used`，直到最后一行能完整放下（见 4.3.4 的 3b 步）。
  原因：尾段名义上只分剩下的 13%，落盘目录很长时标记预留被撑大、内容预算变小，13% 连一行都放不下；
  没有这道保底就会出现「末行被截在行中间、尾标记仍声称末尾 N 行」。

#### 4.3.8 抽样分类（v2.1 / R9 / P1-6）

行数超过 `MAX_CLASSIFY_LINES` 时，只对「头段 + 尾段 + 中段等距抽样」的行做分类：

```
sample_step = 0 if total <= MAX_CLASSIFY_LINES
              else ceil((total - head_n - tail_n) / SAMPLE_CLASSIFY_CAP)
tail_lo0 = total - tail_n
for i in range(total):
    if sample_step > 1 and head_n <= i < tail_lo0 and (i - head_n) % sample_step != 0:
        continue                      # 中段未抽中的行：tier 视为 0，不参与候选
    tier[i] = tier_of(lines[i], read_mode, focus)
```

- 头段（`head_n` 行）与尾段（`tail_n` 行）**始终全量分类**；只有中段抽样。
- `silent` / 行号区间 / `tail_marker` 仍按**真实行数**计算，标记里的数字仍然自洽。
- 此模式下 `weak_hidden` 为未知：`meta.w = -1`（调用方不得把它当计数用；服务层聚合时遇到 -1
  也把整个 `meta.w` 记为 -1）。
- **已知代价**：中段**稀疏**出现的错误/关键值行可能落在未抽样的行上而漏保留；头尾不受影响。
  `sample_step == 1`（中段本身 ≤ `SAMPLE_CLASSIFY_CAP` 行）时不抽样，行为与普通模式一致。

### 4.4 标记（行号按真实行数；v2.1 文案有扩展）

`silent = total - 已显示行数`；`rng_lo/rng_hi` = 未显示区间**首/末行的 1 基行号**
（`rng_lo = first_omitted + 1`，`rng_hi = 最后一个未显示的 0 基下标 + 1`）。
`in_span` = 已显示且落在 `[rng_lo, rng_hi]` 区间内的行数（v2.1 / P2-1）。

`range_text(lo, hi, in_span)`：

- `lo == hi` → `第 {lo} 行`，否则 `第 {lo}–{hi} 行`；
- `in_span > 0` 时追加 `，该区间内另有 {in_span} 行已保留在上/下文`（不追加则是空串）。

**普通模式**：

- 有关键行被保留（`key_picked` 非空）：
  `… [dsh-ctx 省略 {silent} 行（{range_text}）；{明细}{落盘段}] …`
  - 明细 = 依次追加，用 `；` 连接：
    - `保留 {n} 条错误行`（`strong_detected > n` 时再补尾部）：
      - `strong_merged > 0` → `（共检出 {d} 条，{k} 条同签名已归并）`
      - 否则 → `（共检出 {d} 条）`
    - `保留 {m} 条关键值行`
    - `{w} 行弱关键词未展开`（仅在 `w > 0` 时）
- 有关键行但全在显示区：`… [dsh-ctx 省略 {silent} 行（{range_text}，关键行已包含在显示区域）{落盘段}] …`
- 一条都没有：`… [dsh-ctx 省略 {silent} 行（{range_text}，未发现错误/关键值行）{落盘段}] …`
  （v2.1 / P1-4：无关键行也带落盘路径。）

**Read 模式**（无落盘段）：

- `… [dsh-ctx 省略 {silent} 行（{range_text}）；保留 {parts}，可加 offset 回查] …`
  - `parts` 依序取 `{n} 条符号行`（`n` = 关键行区里 tier 3 符号行数，**不含** `focusPatterns`
    命中的 tier 2 行）/ `{m} 条错误行`（`m` = tier 4，即 `meta.k`）；各 > 0 时才出现；
  - 两者都为 0 而仍有 key 行（只剩 focus 命中）时用 `{k} 条关键行`；
  - 用 `、` 连接。**只统计关键行区**：头段/尾段里顺带显示的同档行不计入这些数字。
- `（{range_text}，符号行已包含在显示区域）` / `（{range_text}，未发现函数/类/import 行）`。

**尾段标记**：`… [dsh-ctx 以下为原文末尾 {n} 行（第 {a}–{b} 行）] …`，
`a = total - n + 1`、`b = total`（v2.1：`total` 不含末尾换行产生的空行，所以 200 行日志是 176–200）。

**少行分支标记**：`\n… [dsh-ctx 省略 {omitted} 字节` + 单行超长说明 + 落盘段 + `] …\n`（见 4.2）。

落盘段：`；原文 {path}，可 Grep 回查`（无落盘则整段省略，即空串）。

> 行号区间用的是 **en dash `–`（U+2013）**，标记前缀是 `…`（U+2026）后接空格 `[dsh-ctx `；
> 这两处是幂等判定依赖的结构，**不许改**。

标记示例（级联错误被归并、且区间内夹着已保留行）：

```
… [dsh-ctx 省略 471 行（第 20–490 行，该区间内另有 92 行已保留在上/下文）；保留 3 条错误行（共检出 121 条，118 条同签名已归并）；原文 C:\Users\me\.dsh\context-compression\spill\a1b2c3d4\3f2a91c0-33100.txt，可 Grep 回查] …
```

（上例 121 条 = 1 条根因 + 120 条同签名级联；归并时按组配额保留，根因必在保留集合里。
`保留 3 条` 的具体条数由 cap 与字节预算决定，示例只示意文案结构与拼接顺序。）

### 4.5 落盘（信息不丢失的兜底）

```
dir  = options.spillDir          # 默认 ~/.dsh/context-compression/spill（lib/config.js 解析）
sid8 = UTF-8 前 8 字节（不切断字符），仅保留 [A-Za-z0-9_-]，空则 "nosid"
name = "%08x-%x.txt" % (crc32(utf8(text)), tbytes)      # 内容寻址：同内容同名
path = dir + "/" + sid8 + "/" + name
```

- 写入**原始 text 的 UTF-8 字节**（与原文逐字节一致），`options.spillEnabled === false` 时不写。
- **v2.1：普通模式无论有没有关键行都落盘**（P1-4）；落盘在分类之前发生，标记才能带路径。
- **Read 模式不落盘**（`spill_path = null`），标记里不带原文路径。
- 写失败不影响裁剪（标记里就不带路径）。
- 清理：每次落盘后扫描**本会话目录**，删除 mtime 早于 `options.spillDays` 天的普通文件；
  目录项超过 `SPILL_SCAN_CAP`（500）个时只扫前 500 个。
- **v2.1：`finish` 判定退化（返回 null）时删除刚写的文件**（`deleteSpill`，P2-4），
  不留无引用的垃圾文件。

### 4.6 收尾

`finish(res, text, eff, meta, params)` 有**两条退化条件**（返回 `null` = 不裁，调用方按原样透传）：

```
if blen(res) >= tbytes: return None   # ① 不比原文小：裁剪没有收益（并删落盘）
if blen(res) > eff:     return None   # ② 超过内容预算：宁可不动，也不输出与标记矛盾的文本（P1-7）
saved = tbytes - blen(res)
if saved < minSaveBytes or saved*100 < tbytes*minSavePercent: return None   # ③ 节省不足
return { text: res, meta, bytesAfter: blen(res) }
```

- 条件 ② 在 v2.0 是 `res = json_safe_prefix(res, eff)` **硬切**（会把尾段切在行中间、让「省略 N 字节」
  与真实不符）。v2.1 改为**直接不裁**：前置预算（4.3.1）已保证正常路径不会超 `eff`，
  若真的超了，说明标记与内容已经不自洽，透传比给出错误数字更安全。
- 组装前还有一条等价退化：**`silent <= 0`**（没有任何整行被省略，只可能是行内被 `MAX_LINE_BYTES`
  截断）→ 不出标记、直接返回 `null` 透传，并**删除已写的落盘文件**；不允许出现「没有标记却丢了行内容」
  的输出（见 `trimText` 的 `silent <= 0` 分支）。
- 所有返回 `null` 的分支都会删除本次已写的落盘文件，不留无引用垃圾（P2-4）。

### 4.7 meta 与 reason

`meta = {"k": ..., "g": ..., "w": ..., "p": 1/0 是否落盘}`，其中：

- **普通模式**：`k` = 保留的 STRONG 条数（tier 3），`g` = 保留的 SKELETON 条数（tier 2）；
- **Read 模式（v2.1 收口）**：`k` = 保留的**错误行**条数（tier 4），`g` = 保留的**符号行 + tier 2
  行**数（即 `readMarker` 里的「符号行」只数 tier 3，`g` 还额外包含 `focusPatterns` 命中的行）；
- `w` = 未展开的 weak 行数（抽样分类模式下为 `-1`，调用方不得当计数用）；
- `k` / `g` **只统计关键行区**：头段/尾段里顺带显示的同档行不计入。

`reason` 取值：

| reason | 含义 |
|---|---|
| `trim` | 裁剪成功（`text` 为结果） |
| `short` | 不值得裁：**输入 ≤ 预算**（v2.1 主因）/ 未触发 / 退化（不比原文小）/ 节省不足门槛 → 引擎内部返回 `null` |
| `read_off` | `tool === 'Read'` 但 `readTrim` 为假（Read 裁剪总开关关闭） |
| `persisted` | 文本前 4000 字节内、**行首**已含 `<persisted-output`（宿主已外置） |
| `idem` | 文本行首已含 `… [dsh-ctx ` 标记（重复处理） |
| `bash_failed` | Bash 失败现场（行首 `Exit Code: N` 非 0，失败现场透传） |
| `error` | 引擎内部异常（异常被吞掉，原样透传） |

> 入口还有一层兜底：若裁剪结果 `bytesAfter >= bytesBefore`（归一化可能让输出比原始输入更大），
> 也返回 `short`、不改写上层消息（P2-2）。

---

## 5. 入口判定顺序（顺序即优先级）

`trimToolText()` 内按以下顺序判定，命中即返回：

1. **孤立代理项归一化**先做（字符串层，见 §0.1），`bytesBefore` 取**原始输入**字节数。
2. `<persisted-output` 出现在**前 4000 字节**内、且命中位置是**行首或全文开头** → `reason: 'persisted'`，
   原样透传（v2.1 / P2-7：正文任意位置出现不再算）。
3. `tool === 'Read'` 且 `readTrim` 为假 → `reason: 'read_off'`，原样透传
   （**必须先于 idem**：否则 Read 未开裁剪、正文恰好含标记时会被误报成 `idem`）。
4. `tool === 'Bash'` 且**行首** `Exit Code: N` 非 0 → `reason: 'bash_failed'`，原样透传
   （失败现场透传；结构化 `exitCode/exit_code` 非 0 由服务层按 `isError` 跳过，不进引擎）。
5. 幂等标记判定 `has_trim_marker(text)` 为真 → `reason: 'idem'`，原样透传。
6. 进入 `trimText()`：返回 `null` → `reason: 'short'`；异常 → `reason: 'error'`；成功 → `reason: 'trim'`。

`has_trim_marker(text)`（v2 只认新标记，行首语义）：

```
needle = "… [dsh-ctx "        # 字节序列 E2 80 A6 20 5B 64 73 68 2D 63 74 78 20（13 字节）
p = find_bytes(text, needle)  # 按字节查找
while p >= 0:
    if p == 0 or text[p-1] == '\n': return True   # 只认行首（或全文开头）
    p = find_bytes(text, needle, p + 1)
return False
```

- 正文里偶然打印的裸 `[dsh-ctx `（例如读源码、构建日志里 echo 出标记格式）**不**被误判成幂等；
  但**以标记开头**的文本（例如读到本插件源码/文档里的标记行）会判 `idem`，这是已知取舍。
- 旧 `[wb-ops ` 标记不识别（旧会话里没有 v2 写入，不构成误判）。

**服务层（`lib/index.js`）在此之外还负责**：

- 跳过 `isError` 的工具结果事件（失败现场透传），记 `reason: 'tool_failed'`；
- 只处理能映射到 `Bash` / `Read` / `Grep` / `Glob` / `WebFetch` 的工具（其它工具、无文本块的结果跳过）；
- `shadow` 模式下只统计（`reason: 'shadow'`）、绝不写会话；
- **多 text block 按块裁剪**（v2.1 / R7）：stdout/stderr 分块时逐块调用引擎，块数与顺序保留；
  分块时每块预算按字节占比分摊、下限 2000；
- 按 replay-safe 协议先 append `compaction/prune`（shadow price）再 `surfaceOp: replace` 替换工具结果；
  `tool/result` 追加失败时**中止本趟**（`aborted`），不再给后续候选堆悬空 shadow；
- 返回 `{pruned, bytesRemoved, charsRemoved}`，`pruned` 条目含 `bytesBefore/bytesAfter/charsBefore/charsAfter`；
- 启动写 `statsDir/last-boot.json`；每趟结束写 `last-pass.json`（0 裁剪也写）；决策流水批量写
  `saves-YYYY-MM.jsonl`（UTC 月），最近一次决策写 `last-trim.json`。

---

## 6. 2.1 不变量（改代码前必读）

1. **认不出来就原样透传** —— 绝不猜测、绝不破坏结构化输出。
2. **输入不超过预算就不动** —— 不是「输出不长就不动」；`tbytes <= budget` 一律 `short`。
3. **分层保留** —— 绝不让噪音把真错误挤出采样窗口。
4. **错误行优先于符号行/骨架行**（v2.1 收口）—— 普通模式 strong 先填；Read 模式错误行（tier 4）
   先占 45% 预算，符号行（tier 3，条数基线下限 64）只能用累计 57% 的剩余额度，
   `focusPatterns` 命中的 tier 2 行再排在其后。
5. **丢了能回查** —— 普通模式原文落盘（无关键行也落盘），标记带可 Grep 的路径；
   Read 模式不落盘，但标记给出可回查的行号区间。
6. **Bash 失败整段透传** —— 失败现场不动；`Exit Code:` 只认行首形态（P2-6）。
7. **任何异常静默透传** —— 引擎绝不让插件抛出、挂住会话。
8. **标记结构冻结**：行首 needle `… [dsh-ctx `（13 字节）+ en dash 行号区间；幂等检测依赖它。
9. **标记数字必须自洽**：`省略 N 行 / 字节`、区间端点、尾标记行号都要与真实被省内容一致；
   宁可退化成「不裁」，也不输出自相矛盾的标记（v2.1 / P1-7）；尾段至少保住「原文最后一行」完整。
10. **性能**（v2.1 / R9）：单次裁剪 ≤ 30 ms（10 KB 输入）；行数 > `MAX_CLASSIFY_LINES` 时中段抽样
    分类（`meta.w = -1`）；孤立代理项走字符串层归一化；不得对 > 1 MB 文本做重复编解码。

---

## 7. 验收

### 7.1 回归判据

| 用例 | 判据 |
|---|---|
| 621 行日志，根因在第 151 行 + 120 条同签名级联错误 | 根因行必须在输出里；标记出现「同签名已归并」 |
| 8 条 `step=` 各不相同的真错误混 140 条误命中 | **8/8 保留**（不同签名的错误不许被归并） |
| docker ps 150 行表格 / df 99% 满盘（中段） | 关键信息 2/2、2/2（F2 取样覆盖中段） |
| 200 行 `KEY=VALUE`，预算 8000 | 保留条数 **> 24**（基线 40，自适应可更多），且保留行分散在全文 |
| 预算轴：同一 22,452 字节输入，预算 8000 / 20000 / 24000 / 60000 | 输出字节数**单调不减** |
| Bash 默认预算 4000：~7.3 KB 日志（60 行） | 触发且输出 ≤ 4400 字节 |
| 输入 3,256 字节、预算 4000（ipconfig 形态，MAC 行在第 55 行） | `reason: 'short'`，**不裁**；MAC 行不丢（R3） |
| 200 行、以 `\n` 结尾的日志 | 尾标记为「第 176–200 行」，不是 177–201；CRLF 输入同样 |
| 无关键行的长输出（netstat） | `meta.p = 1`，标记含「原文 …，可 Grep 回查」 |
| `finish` 退化（如 `minSaveBytes` 调大） | 不裁，且落盘目录里**没有**刚写的文件 |
| 900 行日志，含 `TypeError` / `Traceback`，`readTrim` 默认开 | Read 被裁，且错误行保留、标记报「N 条错误行」 |
| Read：150 符号行 + 30 错误行（超预算） | 错误行 **30/30** 保留（错误行优先前为 18/30）；符号行 131/150 量级；标记「N 条符号行、M 条错误行」= 关键行区计数（`M = meta.k`，`N` 不含 focus 行） |
| 普通模式：错误行落在最后 25 行 | 照常进关键行候选（`meta.k` 计数），尾段填充不重复输出 |
| 长落盘目录 + 小预算 | 尾段至少保「原文最后一行」完整，尾标记声称的行号与实际一致 |
| Read 的 `meta` | `meta.k` = 错误行数、`meta.g` = 符号行 + focus 行数；普通模式 k/g 语义不变 |
| k8s manifest / CI workflow（小写 `key: value`） | 关键行保留（K9） |
| 自定义异常 `AssertionError:` / `FooException:` | 算 STRONG；`isError: false` / `errorCode: 0` 不算 |
| 彩色 `\x1b[31mERROR` | 剥 ANSI 后算 STRONG |
| diff 里的 `+export function foo()` | 算 SKELETON（K13） |
| 26 万行行密集输入 | 仍裁剪、输出 ≤ 预算、`meta.w = -1`、标记行号与真实未显示行数自洽 |
| 幂等：真裁剪输出二次喂入 | `reason: 'idem'` |
| 幂等：Bash 正文含裸 `[dsh-ctx ` 子串 | 仍然裁剪，`reason: 'trim'` |
| Read 未开裁剪且正文含行首标记 | `reason: 'read_off'`（不是 `idem`） |
| 分类不变 | 8/8 真错误红线、`failover\|isError\|errorCode\|warningLevel\|timeout_ms\|cannot_parse` 不进 strong、520 行埋 6 关键值 6/6 |

### 7.2 golden 回归基线（v2.1 起）

`tests/engine/fixtures/golden.json` 是**自观测基线**：由 `scripts/update-golden.mjs` 读取
`tests/engine/corpus.js` 的 `goldenCases()`，用**当前引擎**生成 `expectedText` / `expectedMeta` /
`expectedReason` / `options` 写回。`golden.test.js` 断言当前引擎输出与夹具逐字节一致
（文本、reason、meta 三项都比），并校验输出 ≤ 预算。CI **不需要 Python**。

- 改判定逻辑的流程：跑 `node scripts/update-golden.mjs` → review `golden.json` 的 diff →
  确认变更是**有意**的行为变化后提交。
- `scripts/differential.mjs`（与 1.x Python 参考实现对拍）保留为历史工具，v2.1 起不再作为门槛；
  它生成过 2.0 的夹具，但 2.0 夹具已被 v2.1 的自观测基线取代。

### 7.3 效果基线

**v2.0 实测（外部评测报告，2026-11-04）**：16 组真实工程语料（1.0 MB）压缩率 **93.25%**
（官方 92.15%）；2,470 条真实 STRONG 行存活 **83.3%**（官方 54.7%）；中段事实 **6/21**
（官方 0/21）；真实历史回放 743 条 / 省 5.01 MB / **28.5%**（官方 344 条 / 5.38 MB / 30.5%）。
报告指出的两个最大短板是 Read 默认不裁与分类器漏 6 类关键行——v2.1 的 R1/R2 修的就是它们；
**这些数字不代表 2.1 行为**，2.1 的复测数字见评测报告的 v2.1 复测。

**历史基线（1.1.1，独立对抗语料）**：

| 指标 | 1.0.1 | 1.1.1（2.0 沿用） |
|---|---|---|
| 关键信息存活 | 8/25 | **13/25** |
| 整体压缩率 | 76.5% | **83.7%** |
| `cascade_mid_root`（根因在中段 + 120 条级联） | 0/1 | **1/1** |
| docker ps（12 位 hex ID 表格） | 0/2 | **2/2** |
| df（99% 满盘告警在中段） | 0/2 | **2/2** |
| 预算轴（22,452 B 输入，预算 8000/20000/24000/60000） | 非单调（24000 反而 2,735 B） | 7762/9093/9093/9093，单调不减 |

> 口径：1.x 的 Python 参考引擎、2026-11-01 本机、仓库外的独立对抗语料；
> **v2.1 起引擎行为已与 Python 参考实现分叉**（分类谓词、触发语义、标记文案都变），
> 这组数字只作历史对照，不是当前 JS 引擎实测。

### 7.4 测试入口

```bash
node --test tests/                 # 全部测试（引擎 golden + 服务契约 + 真加载）
node --test tests/engine/          # 只跑引擎单测与夹具
node scripts/update-golden.mjs     # 用当前引擎重新生成 golden 夹具（自观测基线）
```

> `node --test tests/` 在某些沙箱环境（如 DSH 自己的沙箱）会因 `spawn EPERM` 失败，
> 那是子进程/管道限制，属环境限制而非插件问题；可以逐文件直跑
> `node tests/<file>.test.js`。
