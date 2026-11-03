# dsh-context-compression 2.0 · 工具结果裁剪引擎实现契约（lib/engine）

本文件是 `lib/engine`（纯 ESM JavaScript，无构建步骤）的行为契约。引擎只做一件事：
把一段工具输出文本按 **STRONG / SKELETON / WEAK** 分层裁剪到字节预算内，并给出可 Grep 回查的省略标记。

**2.0 的单实现口径**：1.x 时代有 `hooks/trim.py`（参考实现）与 `src/trim.cpp`（C++ 原生实现）
两份实现，要求逐字节一致（parity）；2.0 只保留 **JS 一份实现**（`lib/engine`），
Python 参考实现只作为开发期差分对拍（`scripts/differential.mjs`）的对照物，不随仓库发布。
即使只有一份实现，下面所有常量、谓词、取整方向、标记文案仍按「可逐字节复现」的精度写死：
改任何判定都要让差分对拍到 **0 差异**（落盘关闭时）才能进主干。

> 命名约定：为方便与参考实现对照，文中函数名沿用 1.x 契约的 snake_case
> （`strong_signature` / `pick_spread` / `has_wb_ops_marker` …）；JS 实现可用 camelCase，
> 语义、常量、取整方向以本文件为准。

---

## 0.1 字节与切片语义（JS 引擎必须遵守）

1. **所有谓词的字符集都是纯 ASCII**（`[A-Za-z0-9_.-]`、hex、空白、引号、`|` 等）。
   UTF-8 多字节序列的每个字节都 ≥ 0x80，不会落进这些字符集，因此「按字节扫描」与
   「按码点扫描」的**判定结果相同**。这是全局前提，也是所有分类器都用**显式字符扫描、不用正则**
   的根本原因：正则的 Unicode 语义与贪婪策略会让结果随实现漂移，破坏与参考实现的逐字节对照。
2. **所有长度 / 预算 / 计数一律按 UTF-8 字节计**：`Buffer.byteLength(s, 'utf8')`。
   **禁止**把 `String.prototype.length` 当字节数（中文/emoji 会差 3–4 倍）。
3. 前缀 / 后缀 / 截断必须**落在 UTF-8 字符边界**上：`u8_prefix` / `u8_suffix` / `json_safe_prefix`
   不得切开一个多字节字符（也不能把代理对切成孤立半对）。
4. 以下位置**必须显式按字节**：
   - `has_win_path`：按字节扫描（`is_word_byte` / `is_path_byte` 都是字节版）；
   - `has_hex_token`：按字节扫描，且 24 字节前缀窗口也按字节切；
   - `is_json_key`：键宽用 `blen(key) <= 80`，不是码点数；
   - `display_line`：是否超长用字节数判断（`blen(line) > MAX_LINE_BYTES`）；
   - `persisted` 检查：`text` 的**前 4000 字节**内查找 `<persisted-output`；
   - `strong_signature`：数字/空白/`A-Z` 全是 ASCII 判定，多字节 UTF-8 字节只会被原样拷贝；
     **变换后取 UTF-8 编码的前 96 字节原样作为分组键（bytes）**，不做 UTF-8 解码、
     不补 U+FFFD（见 4.3.2）；
   - `has_wb_ops_marker`（2.0 语义不变，只换 needle）：按字节查找 needle
     `E2 80 A6 20 5B 64 73 68 2D 63 74 78 20`（即 `… [dsh-ctx `，13 字节），
     命中位置是字节 0 或前一字节为 `0x0A`（见第 5 节）。

---

## 0.2 保留策略变更总览（1.1.1 引入，2.0 原样沿用）

| 编号 | 原始问题 | 保留策略 |
|---|---|---|
| **O1b** | 根因被级联错误淹没 | strong 行**超出条数上限才**按签名归并；每组按配额保留（首条 + 等距取样），8 条不同 `step=` 的真错误在上限内完全不动 |
| **O2** | 预算非单调（调大预算反而压得更狠） | 触发门槛与裁剪目标彻底分离：门槛只管「要不要裁」，`eff` 恒等于预算；Bash 默认预算 4000（更激进） |
| **O3** | 填充方向 | 首因优先：每组首条（= 首个出现 = 根因）排到 strong 候选末尾，`fill_recent` 从后往前挑 → 根因拿到最高填充优先级 |
| **F2** | 条数天花板 / 关键行只取最近 | 条数上限改为「基线 + 预算自适应」`adaptive_count()`（`//32`，硬顶 128）；关键行候选改为**全区间等距取样** `pick_spread()` |
| **F6** | `[dsh-ctx ` 子串误判幂等 + `read_off` 被抢答 | 幂等判定锚定**行首标记结构** `has_wb_ops_marker()`；入口判定顺序里 `read_off` 提到 `idem` 之前 |

**硬约束**：分类谓词不变、输出标记**结构**不变（只换品牌前缀）、`MIN_SAVE_BYTES` /
`MIN_SAVE_PCT` 退化门槛不变。F4（空格对齐表格）/ F5（小写 `key=value`、`Key: Value`）的识别谓词
留到后续版本 —— 先放开限额（F2），再扩谓词；顺序反了会让新识别的行互相挤。

---

## 1. 常量（引擎内写死，不可由调用方覆盖，除注明「options 可覆盖」者）

```
# ---- 触发与预算 ----
MAX_LINES           = 120      # 行数触发（行数超过它也会裁）
HEAD_LINES          = 50
TAIL_LINES          = 25
MAX_STRONG_LINES    = 40       # strong 基线；实际上限 = adaptive_count(段配额, 它)
MAX_SKEL_LINES      = 24       # skeleton 基线；同上
ADAPTIVE_LINE_BYTES = 32       # 条数上限 = 段字节配额 // 32
ADAPTIVE_LINE_CAP   = 128      # 自适应条数硬顶
MIN_LINE_BYTES      = 60
MAX_LINE_BYTES      = 1000
MARKER_RESERVE      = 480      # 给省略标记预留的字节数（标记带落盘路径）
SPILL_DAYS          = 7        # options.spillDays 的默认值
SPILL_SCAN_CAP      = 500
SECTION_STRONG      = 45       # strong 独占预算占比 %（先填）
SECTION_SKEL_ADD    = 12       # 追加给 skeleton 的预算 %（累计到 57%）
SECTION_HEAD        = 30       # 再追加给头段的预算 %（累计到 87%）
                               # 剩余 13% 留给尾段，实际以硬上界为准
READ_MIN_LINES      = 1500
READ_HEAD_LINES     = 200
READ_TAIL_LINES     = 120
MIN_SAVE_BYTES      = 300      # options.minSaveBytes 默认值：节省不足 300 字节不裁
MIN_SAVE_PCT        = 4        # options.minSavePercent 默认值：且节省不足 4% 不裁
```

`MAX_STRONG_LINES` / `MAX_SKEL_LINES` 只是基线：实际条数上限由
`adaptive_count(段字节配额, 基线)` 计算（见 4.3.5），预算越大允许保留的条数越多，但不会超过 128。

预算与触发门槛的**默认值**（`Bash 4000`、其余 `8000`，门槛 `Bash 3000` / `Grep·Glob·WebFetch 6000` /
`Read 8000` / 其余 `4000`）以及它们的收敛区间（`[2000, 131072]` 等）由 `lib/config.js` 解析后
传给引擎；引擎只使用已解析的 `budgetBytes` / `minBytes`，**不读环境变量、不读配置文件**。

---

## 2. 引擎入口

```js
// lib/engine/index.js
export const ENGINE_VERSION = '2.0.0';

/**
 * @param {{ text: string, tool: 'Bash'|'Grep'|'Glob'|'WebFetch'|'Read' }} input
 * @param {{
 *   budgetBytes: number,     // 已解析的字节预算
 *   minBytes: number,        // 已解析的触发门槛；0 = 关闭按门槛触发
 *   readMode: boolean,       // tool === 'Read'（决定用 Read 的裁剪策略）
 *   readTrim?: boolean,      // Read 裁剪总开关（false 时返回 read_off）
 *   spillEnabled: boolean,
 *   spillDir: string,        // 落盘根目录
 *   spillDays: number,
 *   sessionId: string,
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

## 3. 行分类：`classify_line(line) -> 0|1|2|3`

`0` 普通 / `1` WEAK / `2` SKELETON / `3` STRONG。**顺序：先 strong，再 skeleton，最后 weak。**

### 3.1 基础工具

- `is_word_char(c)`：ASCII `[0-9A-Za-z_]`
- `find_word(line, tok, ci)`：tok 两侧都必须是「词边界」（左为起始或前一字符非词字符；
  右为末尾或后一字符非词字符）
- 中文关键词按**子串**匹配（中文无词边界概念）
- `lstrip_ws(line)`：剥 `' ' '\t' '\r' '\v' '\f'`

### 3.2 STRONG（tier 3）

1. **整词命中（大小写敏感，全文任意位置）**，逐个 `find_word`：
   `ERROR`, `Error:`, `FAILED`, `FAIL`, `FATAL`, `Fatal`, `fatal:`, `panic:`, `Traceback`,
   `Exception`, `OSError`, `TypeError`, `KeyboardInterrupt`, `ModuleNotFoundError`,
   `ImportError`, `PermissionError`, `FileNotFoundError`, `NotADirectoryError`,
   `EACCES`, `EPERM`, `ENOENT`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`,
   `EADDRINUSE`, `ENOTFOUND`, `EHOSTUNREACH`
   > 说明：整词要求保证 `isError` / `failover` / `errorCode` / `warningLevel` **不会**进入 strong。

2. **行首告警**：`lstrip_ws` 后以 `warning:` 或 `WARNING:` 开头，且其后紧接空格/制表/回车或行尾。

3. **子串（大小写敏感）**：`Segmentation fault`、`core dumped`、`No such file or directory`、`npm ERR!`

4. **`error[E<digits>]`**：出现 `error[E`，其后至少 1 个 ASCII 数字，紧跟 `]`。

5. **`error TS<digits>`**：出现 `error TS`，其后至少 1 个 ASCII 数字。

6. **`Exit Code: <nonzero>`**：全文**最后**一处 `Exit Code:`，其后跳过空格/制表，允许一个 `-`，
   紧接至少 1 位数字，该数值（带符号）非 0。
   （与文本形态 Bash 失败的判定完全同一函数）

7. **中文子串**：`错误`、`失败`、`异常`、`致命`、`崩溃`

### 3.3 SKELETON（tier 2，且不是 strong）

`t = lstrip_ws(line)`：

- **K1 KEY=VALUE**：`t[0]` 是 `A-Z`；随后连续 `[A-Z0-9_]` 至少再 2 个字符（即键总长 ≥ 3）；
  然后跳过空格/制表；下一个字符是 `=`。
- **K2 表格行**：`t[0] == '|'`，且 `rstrip(' \t\r')` 以 `|` 结尾，且 `|` 至少 2 个。
- **K3 diff 头**：`t` 以 `---` / `+++` / `diff --git` / `@@ ` 之一开头。
- **K4 URL**：出现 `http://` 或 `https://`，且 `://` 之后紧跟至少 1 个非空白字符，
  且 `http` 前是行首或非词字符。
- **K5 POSIX 绝对路径**：存在一段 ≥2 个以 `/` 分隔的连续段，段字符集 `[A-Za-z0-9._-]`，每段非空
  （例：`/usr/local/bin`、`src/a/b.py` 里的 `/a/b`）。
- **K6 Windows 绝对路径**：`<letter>:\\`，前一字符为行首或非词字符，
  其后至少 3 个 `[A-Za-z0-9._\-\\]` 字符，且其中至少一个 `\`。
- **K7 独立 hex（commit / sha）**：连续的 `[0-9a-fA-F]` 串，长度 `7..64`，左右两侧为词边界，
  且串内至少含一个 `a-f` 字母（排除纯十进制）；
  长度 ≥ 12 直接算；长度 7..11 时，要求其前 24 字符（小写化后）含
  `sha` / `commit` / `rev` / `hash` / `digest` / `version` / `tag` / `@` 之一。
  > 说明：据此 `job=08f2a1c`（日志里的随机 hex）不会被当成骨架行，而 `ARTIFACT_SHA=9d1f7c2`、
  > `commit 9f2c1e7` 会。
- **K8 JSON 顶层键**：`t[0] == '"'`，其后 1..80 字符内出现 `"`，再跳过空格/制表后紧跟 `:`。

> 2.0 **未**新增任何分类谓词（K1 仍要求大写键；空白对齐表格仍不识别）。F4/F5 留到后续版本。

### 3.4 WEAK（tier 1，且不是 strong / skeleton）

整词、**大小写不敏感**：`warn` `warning` `warnings` `fail` `fails` `failed` `failure`
`failures` `failing` `timeout` `timeouts` `timed out` `cannot` `error` `errors`
中文子串：`警告` `无法` `未能` `超时`

> WEAK 行**永不进入输出**，只在标记里报「N 行弱关键词未展开」。

### 3.5 Read 模式

不做三级分类：`is_symbol_line`（`SYMBOLS` 子串表）命中的行记 tier 3，其余 0；
不落盘、不报 weak。

---

## 4. 裁剪流程（内部函数 `trimText(text, params) -> { text, meta, bytesAfter } | null`）

`params` 由入口（第 2 节）拆出：`tool`、`readMode`、`budgetBytes`、`minBytes`、落盘三件套、
`minSaveBytes` / `minSavePercent`、`now`。返回 `null` = 不需要裁剪（触发条件不足 / 收益不足）。

### 4.1 触发（门槛与目标分离）

```
budget_bytes = options.budgetBytes
min_bytes    = 0 if read_mode else options.minBytes
head_n, tail_n = (READ_HEAD_LINES, READ_TAIL_LINES) if read_mode else (HEAD_LINES, TAIL_LINES)
tbytes, total = blen(text), len(lines)

read_mode:
    if total <= READ_MIN_LINES or tbytes <= budget_bytes: return None
    eff = budget_bytes
else:
    eff = -1
    if tbytes > budget_bytes:                    eff = budget_bytes    # ① 超预算
    elif min_bytes > 0 and tbytes > min_bytes:   eff = budget_bytes    # ② 超门槛
    elif total > MAX_LINES:                      eff = budget_bytes    # ③ 超行数
    if eff < 0: return None
```

- 分支 ② 里 `eff` 是**预算**而不是 `min(budget, min_bytes)`：门槛只管要不要裁，
  `eff` 一旦触发就恒等于预算，因此输出字节数对预算**单调不减**。
- `resolve_budget` / `resolve_min_bytes` 在 `lib/config.js` 完成（见第 2 节），引擎不再解析。

### 4.2 少行分支（`total <= head_n + tail_n + 5`）

- `avg = tbytes // max(total,1)`；若 `avg > 200` 或 `total <= 3` → **按字节截首尾**：
  - `head = json_safe_prefix(text, eff*5//8)`、`tail = u8_suffix(text, eff*3//10)`
  - 标记：`\n… [dsh-ctx 省略 {omitted} 字节` + （`total<=3` 时）`（单行过长已截断，原文 {tbytes} 字节）`
    + （有落盘时）`；原文 {path}，可 Grep 回查` + `] …\n`
  - `res = head + marker + tail`，走 4.6 的统一收尾
- 否则**按比例收缩头尾**：`head_n = max(1, total*50//100)`、`tail_n = max(1, total*25//100)`，继续 4.3。

`json_safe_prefix(s, limit)`：`limit` 落在 UTF-8 字符边界上（回退到前一完整字符）；
若 `s.lstrip()` 以 `{` 或 `[` 开头，则在 `[limit-200, limit]` 区间内**从后往前**找第一个
`,` `` `}` `` `]` `` `"` 字节，找到了就切在其后。切过（`cut < 原长`）时补
`…（单行过长已截断，原文 {N} 字节）`；标注放不下就逐字符缩短，最终退化为纯 `…`（总字节数 ≤ limit）。

### 4.3 候选选择与填充

#### 4.3.1 分层预算

```
budget     = max(500, eff - MARKER_RESERVE)
cap_strong = budget * SECTION_STRONG // 100              # 45%
cap_skel   = cap_strong + budget * SECTION_SKEL_ADD // 100  # 累计 57%
cap_head   = cap_skel + budget * SECTION_HEAD // 100     # 累计 87%
used       = 0
tail_lo    = total - tail_n
```

`//` 为整数除法（所有操作数非负；JS 用 `Math.floor` 或 `>>>` 语义等价地实现，
不要用对负数不同的「截断」）。

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

**实现要点（逐字节）**：

1. 数字/空白/`A-Z` 的判定全在 ASCII 范围，多字节 UTF-8 的字节都 ≥ 0x80，只会被原样拷贝；
   按字节遍历与按码点遍历结果相同。
2. `strip(' ')` 只剥 `0x20`，不剥 `\t` / `\r`。
3. 截断取的是**字节前缀**，不是「回退到字符边界」：变换后转 UTF-8，直接取前 96 字节，
   原样作为分组键（`Buffer`）。**不要**尝试补全或替换残缺的 UTF-8 序列
   —— 补 U+FFFD 会让两条不同的级联错误被误并成一组，差分对拍会红。
4. 刻意不用正则、不用 `toLowerCase()`（非 ASCII 的 lower 可能改长度，破坏与参考实现的对照）。

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
if len(kept) > cap: kept = kept[:cap]               # 兜底截前 cap 条
kept_set = set(kept)
firsts   = {g[0] for g in groups.values() if g[0] in kept_set}   # 各组首条中被保留的
return kept, total - len(kept), firsts
```

- 返回值：`(升序行号列表, 被归并掉的行数, 各组首条行号集合)`。
- `idx` 是**升序**的 strong 候选行号；`kept` 返回前再排序，保持升序。
- 「超上限才归并」是关键：8 条 `step=` 不同的真错误 < 上限时**完全不动**。
- `firsts` 只包含「首条本身仍在 `kept` 里」的组（被 `[:cap]` 截掉的首条不算），供 O3 用。

#### 4.3.4 填充顺序（O3 首因优先 + F2 全区间取样）

```
# 1) strong：归并 -> 首因优先 -> 从新到旧填进 cap_strong
strong_cand = [i for i in strong_all if i < tail_lo]
strong_keep, strong_merged, strong_first = dedup_strong(
    strong_cand, lines, adaptive_count(cap_strong, MAX_STRONG_LINES))
if strong_first:
    strong_prior = [i for i in strong_keep if i not in strong_first]
    strong_prior += sorted(strong_first)        # 首因排到末尾 -> fill_recent 先挑它们
else:
    strong_prior = strong_keep
picked_s, used = fill_recent(strong_prior, lines, cap_strong, used)

# 2) skeleton：不与 strong 抢位；全区间等距取样 -> 从新到旧填进 cap_skel
taken = {i for i, _ in picked_s}
skel_cand = [i for i in skel_all if i < tail_lo and i not in taken]
picked_k, used = fill_recent(
    pick_spread(skel_cand, adaptive_count(cap_skel, MAX_SKEL_LINES)),
    lines, cap_skel, used)

key_picked = sorted(picked_s + picked_k)        # 合并后按行号升序输出
taken      = {i for i, _ in key_picked}

# 3) 头段：按行号升序填，跳过 key_picked 已占的行
head_idx = [i for i in range(0, head_n) if i not in taken]
head_shown, used = fill_forward_idx(head_idx, lines, cap_head, used)

# 4) 尾段：按行号降序填（从最后一行往前），输出仍按原序
tail_idx = [i for i in range(tail_lo, total) if i not in taken]
tail_shown, used = fill_backward_idx(tail_idx, lines, budget, used)
```

**O3 原理**：`fill_recent` 从候选列表**末尾往前**挑，所以把「每组首条（首个出现 = 时间最早 =
最可能的根因）」追加到 `strong_prior` 末尾，就等于给它最高填充优先级；输出顺序最后由
`sorted(...)` 按行号决定，不受候选顺序影响。

> 「只留最近 40 条 strong」的旧做法已删除：它会让最早出现的根因被级联错误挤掉。
> 现在改用 `dedup_strong` 的配额分配。

#### 4.3.5 `adaptive_count(cap_bytes, base)` —— F2 条数上限

```
v = cap_bytes // ADAPTIVE_LINE_BYTES   # //32
if v < base: v = base                  # 不低于基线（strong 40 / skeleton 24）
if v > ADAPTIVE_LINE_CAP: v = 128      # 硬顶
return v
```

- strong 传入 `(cap_strong, MAX_STRONG_LINES)`；skeleton 传入 `(cap_skel, MAX_SKEL_LINES)`
  —— 注意 skeleton 用的是**累计 57%** 的 `cap_skel`。
- 因此预算越大允许保留越多条，但不会超过 128；预算很小时仍保住基线 40/24。

#### 4.3.6 `pick_spread(idx, cap)` —— F2 全区间等距取样

```
if cap <= 0 or not idx: return []
n = len(idx)
if n <= cap: return list(idx)
return [idx[(2*k + 1) * n // (2*cap)] for k in range(cap)]
```

- 取样点均匀铺满整个候选区间（首个 ≈ `1/(2cap)`，末个 ≈ `(2cap-1)/(2cap)`），**不是**只取最近的 `cap` 条。
- 返回行号仍升序；随后交给 `fill_recent` 按预算从新到旧填充。
- 乘除都按整数运算（JS 里 `n` 最大与文本行数同阶，普通 Number 足够；如实现里用了位运算，
  注意 32 位截断风险，优先用 `Math.floor(a / b)`）。

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

### 4.4 标记（结构不变，品牌前缀改 `[dsh-ctx `）

`silent = total - 已显示行数`；`rng_lo/rng_hi` = 未显示区间的首末行号（1 基）。
`strong_shown` = `key_picked` 中 tier 3 的条数；`strong_detected` = 全文 tier 3 的总条数；
`skel_shown`、`weak_hidden` 同理。

普通模式：
- 有关键行被保留：
  `… [dsh-ctx 省略 {silent} 行（第 {lo}–{hi} 行）；{明细}{落盘段}] …`
  - 明细 = 依次追加，用 `；` 连接：
    - `保留 {n} 条错误行`（`strong_detected > n` 时再补尾部）：
      - `strong_merged > 0` → `（共检出 {d} 条，{k} 条同签名已归并）`
      - 否则 → `（共检出 {d} 条）`
    - `保留 {m} 条关键值行`
    - `{w} 行弱关键词未展开`（仅在 `w > 0` 时）
- 有关键行但全在显示区：`… [dsh-ctx 省略 {silent} 行（第 {lo}–{hi} 行，关键行已包含在显示区域）] …`
- 一条都没有：`… [dsh-ctx 省略 {silent} 行（第 {lo}–{hi} 行，未发现错误/关键值行）] …`
- Read 模式：`… [dsh-ctx 省略 {silent} 行（第 {lo}–{hi} 行）；保留 {n} 条符号行，可加 offset 回查] …` /
  `（符号行已包含在显示区域）` / `（未发现函数/类/import 行）`

落盘段：`；原文 {path}，可 Grep 回查`（无落盘则整段省略，即整段是空串）。
尾段标记（未变）：`… [dsh-ctx 以下为原文末尾 {n} 行（第 {a}–{b} 行）] …`

> 行号区间用的是 **en dash `–`（U+2013）**，标记前缀是 `…`（U+2026）后接空格 `[dsh-ctx `；
> 这两处是幂等判定依赖的结构，**不许改**。

标记示例（级联错误被归并时）：

```
… [dsh-ctx 省略 471 行（第 20–490 行）；保留 3 条错误行（共检出 121 条，118 条同签名已归并）；原文 C:\Users\me\AppData\Local\Temp\dsh-context-compression\spill\a1b2c3d4\3f2a91c0-33100.txt，可 Grep 回查] …
```

（上例 121 条 = 1 条根因 + 120 条同签名级联；归并时按组配额保留，根因必在保留集合里。
`保留 3 条` 的具体条数由 cap 与字节预算决定，示例只示意文案结构与拼接顺序。）

### 4.5 落盘（信息不丢失的兜底）

```
dir  = options.spillDir          # 默认 os.tmpdir()/dsh-context-compression/spill（lib/config.js 解析）
sid8 = UTF-8 前 8 字节（不切断字符），仅保留 [A-Za-z0-9_-]，空则 "nosid"
name = "%08x-%x.txt" % (crc32(utf8(text)), tbytes)      # 内容寻址：同内容同名
path = dir + "/" + sid8 + "/" + name
```

- 写入**原始 text 的 UTF-8 字节**（与原文逐字节一致），`options.spillEnabled === false` 时不写。
- 写失败不影响裁剪（标记里就不带路径）。
- 清理：每次落盘后扫描**本会话目录**，删除 mtime 早于 `options.spillDays` 天的普通文件；
  目录项超过 `SPILL_SCAN_CAP`（500）个时只扫前 500 个。

### 4.6 收尾

```
if blen(res) >= tbytes: return None                       # 退化：不比原文小就透传
saved = tbytes - blen(res)
if saved < minSaveBytes or saved*100 < tbytes*minSavePercent: return None
if blen(res) > eff: res = json_safe_prefix(res, eff)      # 兜底硬上界
```

### 4.7 meta 与 reason

`meta = {"k": 保留的 strong 条数, "g": 保留的 skeleton 条数, "w": 未展开的 weak 行数, "p": 1/0 是否落盘}`。

`reason` 取值：

| reason | 含义 |
|---|---|
| `trim` | 裁剪成功（`text` 为结果） |
| `short` | 不值得裁：未触发 / 退化（不比原文小）/ 节省不足门槛 → 引擎内部返回 `null` |
| `read_off` | `tool === 'Read'` 但 `readTrim` 为假（Read 裁剪总开关关闭） |
| `persisted` | 文本前 4000 字节内已含 `<persisted-output`（宿主已外置） |
| `idem` | 文本行首已含 `… [dsh-ctx ` 标记（重复处理） |
| `bash_failed` | Bash 失败现场（文本 `Exit Code: N` 非 0，失败现场透传） |
| `error` | 引擎内部异常（异常被吞掉，原样透传） |

---

## 5. 入口判定顺序（顺序即优先级）

`trimToolText()` 内按以下顺序判定，命中即返回：

1. `<persisted-output` 出现在**前 4000 字节**内 → `reason: 'persisted'`，原样透传。
2. `tool === 'Read'` 且 `readTrim` 为假 → `reason: 'read_off'`，原样透传
   （**必须先于 idem**：否则 Read 未开裁剪、正文恰好含标记时会被误报成 `idem`）。
3. `tool === 'Bash'` 且文本 `Exit Code: N` 非 0 → `reason: 'bash_failed'`，原样透传
   （失败现场透传；结构化 `exitCode/exit_code` 非 0 由服务层按 `isError` 跳过，不进引擎）。
4. 幂等标记判定 `has_wb_ops_marker(text)`（JS：`hasTrimMarker`）为真 → `reason: 'idem'`，原样透传。
5. 进入 `trimText()`：返回 `null` → `reason: 'short'`；异常 → `reason: 'error'`；成功 → `reason: 'trim'`。

`has_wb_ops_marker(text)`（needle 换品牌，行首语义不变）：

```
needle = "… [dsh-ctx "        # 字节序列 E2 80 A6 20 5B 64 73 68 2D 63 74 78 20（13 字节）
p = find(text, needle)       # 从 0 开始（按字节，或按 ASCII 字符扫描后确认字节位置）
while p >= 0:
    if p == 0 or text[p-1] == '\n': return True   # 只认行首（或全文开头）
    p = find(text, needle, p + 1)
return False
```

- 正文里偶然打印的裸 `[dsh-ctx `（例如读源码、构建日志里 echo 出标记格式）**不再**被误判成幂等。
- v2 **只认新标记**：旧 `[wb-ops ` 标记不识别（旧会话里没有 v2 写入，不构成误判）。

**服务层（`lib/index.js`）在此之外还负责**：跳过 `isError` 的工具结果事件（失败现场透传）、
shadow 模式下只统计不写会话、按 replay-safe 协议先 append `compaction/prune` 再
`surfaceOp: replace` 替换工具结果事件。详见仓库 README 与 `lib/index.js`。

---

## 6. 2.0 不变量（改代码前必读）

1. **认不出来就原样透传** —— 绝不猜测、绝不破坏结构化输出。
2. **输出不长就不动** —— 而不是无脑截断。
3. **分层保留** —— 绝不让噪音把真错误挤出采样窗口。
4. **丢了能回查** —— 原文落盘，标记带可 Grep 的路径。
5. **Bash 失败整段透传** —— 失败现场不动。
6. **任何异常静默透传** —— 引擎绝不让插件抛出、挂住会话。
7. **标记结构冻结**：行首 needle `… [dsh-ctx `（13 字节）+ en dash 行号区间；幂等检测依赖它。
8. **性能**：单次裁剪 ≤ 30 ms（10 KB 输入）；不得对 > 1 MB 文本做重复编解码。

---

## 7. 验收

### 7.1 回归判据

| 用例 | 判据 |
|---|---|
| 621 行日志，根因在第 151 行 + 120 条同签名级联错误 | 根因行必须在输出里；标记出现「同签名已归并」 |
| 8 条 `step=` 各不相同的真错误混 140 条误命中 | **8/8 保留**（不同签名的错误不许被归并） |
| docker ps 150 行表格 / df 99% 满盘（中段） | 关键信息 2/2、2/2（F2 取样覆盖中段） |
| 200 行 `KEY=VALUE`，预算 8000 | 保留条数 **> 24**，且保留行分散在全文（首行附近与中段都有） |
| 预算轴：同一 22,452 字节输入，预算 8000 / 20000 / 24000 / 60000 | 输出字节数**单调不减**（参考实测 7762 / 9093 / 9093 / 9093） |
| Bash 默认预算 4000：~7.3 KB 日志（60 行） | 触发且输出 ≤ 4400 字节（参考实测 3625–3658） |
| 幂等：真裁剪输出二次喂入 | `reason: 'idem'` |
| 幂等：Bash 正文含裸 `[dsh-ctx ` 子串 | 仍然裁剪，`reason: 'trim'` |
| Read 未开裁剪且正文含行首标记 | `reason: 'read_off'`（不是 `idem`） |
| 分类不变 | 8/8 真错误红线、`failover\|isError\|errorCode\|warningLevel\|timeout_ms\|cannot_parse` 不进 strong、520 行埋 6 关键值 6/6 |

### 7.2 效果基线（WorkBuddy hook 时代同算法引擎的独立语料实测）

独立对抗语料（13 组真实命令输出 + 工程场景，25 条「人还需要的事实」判据；自 1.0.1 基线以同语料同口径复测）：

| 指标 | 1.0.1 基线 | 1.1.1（2.0 沿用） |
|---|---|---|
| 关键信息存活 | 8/25 | **13/25** |
| 整体压缩率 | 76.5% | **83.7%** |
| `cascade_mid_root`（根因在中段 + 120 条级联） | 0/1 | **1/1** |
| docker ps（12 位 hex ID 表格） | 0/2 | **2/2** |
| df（99% 满盘告警在中段） | 0/2 | **2/2** |
| 预算轴（22,452 B 输入，预算 8000/20000/24000/60000） | 非单调（24000 反而 2,735 B） | 7762/9093/9093/9093，单调不减 |

> 口径：1.x 的 Python 参考引擎、2026-11-01 本机、仓库外的独立对抗语料；
> 2.0 的 JS 引擎逐条移植同一套算法，并靠开发期差分对拍保证行为一致。
> 这组数字不是 2.0 JS 引擎重新测的，引用时请保留这一口径说明。

### 7.3 测试入口

```bash
node --test tests/                # 全部测试（引擎 golden + 服务契约 + 真加载）
node --test tests/engine/         # 只跑引擎单测与夹具
node scripts/differential.mjs --random 200   # 开发期 JS↔Python 差分对拍（需本机 Python 参考实现）
```

差分对拍要求：随机 ≥ 200 组载荷、落盘关闭时，与参考实现输出**逐字节一致**；
任何判定逻辑改动都要重跑。
