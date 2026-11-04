/**
 * 引擎常量（SPEC-1.1.1 §1，两侧同值）。
 *
 * 所有长度/预算/计数一律按 UTF-8 字节。`//` 整数除法在 JS 侧统一用
 * `Math.floor(a / b)`（操作数非负，与 Python `//` 向下取整一致）。
 */

// ---- 触发与预算（v0.2.2 起预算一律按字节计）----
// v2.1：行数触发已取消（字节预算才是上下文成本），MAX_LINES 仅为兼容旧配置读取保留，引擎不再消费。
export const MAX_LINES = 120; // 已废弃（v2.1）：保留导出以兼容旧调用方
export const MAX_BYTES = 8000; // 默认预算（字节）；引擎实际用调用方解析好的 budgetBytes
export const HEAD_LINES = 50;
export const TAIL_LINES = 25;
export const MAX_STRONG_LINES = 40; // strong 基线条数；实际上限 = adaptive_count(段配额, 它)
export const MAX_SKEL_LINES = 40; // skeleton 基线条数；v2.1: 24 → 40（YAML/KV 类会挤掉别的关键值）
export const ADAPTIVE_LINE_BYTES = 32; // 条数上限 = 段字节配额 // 32
export const ADAPTIVE_LINE_CAP = 128; // 自适应条数硬顶
export const MIN_LINE_BYTES = 60;
export const MAX_LINE_BYTES = 1000;
export const MARKER_RESERVE = 480; // 给省略标记预留的字节数（不含落盘路径，路径另算）

// ---- Read 按需裁剪 ----
// v2.1: Read 触发改由字节预算决定（tbytes > budgetBytes），行数门槛不再单独生效。
export const READ_MIN_LINES = 0;
export const READ_HEAD_LINES = 200;
export const READ_TAIL_LINES = 120;
// Read 模式符号行的条数基线下限：符号行是 Read 的主产物（函数/类/import 骨架），
// 基数比普通 SKELETON 大，否则错误行先占位后符号行几乎全丢。
export const READ_SYMBOL_MIN_LINES = 64;

// ---- 大规模输入（P1-6 / R9）----
// 行数超过它时只对「头段 + 尾段 + 中段等距抽样」的行做分类，避免 10MB 行密集输入
// 同步阻塞数秒。silent/行号仍按真实行数计算，只有"关键行是否被看到"降级为抽样。
export const MAX_CLASSIFY_LINES = 20000;
// 抽样后中段最多分类的行数上限。
export const SAMPLE_CLASSIFY_CAP = 12000;

// ---- 落盘 ----
export const SPILL_DAYS = 7;
export const SPILL_SCAN_CAP = 500;

// ---- 分层预算占比 ----
export const SECTION_STRONG = 45; // strong 独占预算份额 %
export const SECTION_SKEL_ADD = 12; // 追加给 skeleton 的预算 %（累计 57%）
export const SECTION_HEAD = 30; // 再追加给头段的预算 %（累计 87%）

// ---- 节省下限 ----
export const MIN_SAVE_BYTES = 300;
export const MIN_SAVE_PCT = 4;

// ---- 分类常量（SPEC §3）----
// strong：真错误信号，整词大小写敏感匹配；命中即全留
export const STRONG_WORDS = Object.freeze([
  'ERROR', 'Error:', 'FAILED', 'FAIL', 'FATAL', 'Fatal', 'fatal:', 'panic:',
  'Traceback', 'Exception', 'OSError', 'TypeError', 'KeyboardInterrupt',
  'ModuleNotFoundError', 'ImportError', 'PermissionError', 'FileNotFoundError',
  'NotADirectoryError', 'EACCES', 'EPERM', 'ENOENT', 'ECONNREFUSED',
  'ECONNRESET', 'ETIMEDOUT', 'EADDRINUSE', 'ENOTFOUND', 'EHOSTUNREACH',
]);
// strong：子串（大小写敏感）
export const STRONG_SUBS = Object.freeze([
  'Segmentation fault',
  'core dumped',
  'No such file or directory',
  'npm ERR!',
  'npm error', // v2.1: 现代 npm（>=8）的小写错误行
]);
// strong：自定义异常类名（`AssertionError:` / `FooException:` / `MyError:`）。
// 判定在 classify.hasErrorColonToken 里做：`Error:`/`Exception:` 左侧 token 必须以大写开头，
// 因此 `isError: false,`、`errorCode: 0` 这类配置键不会被误判。
export const EXCEPTION_NOUNS = Object.freeze(['Error:', 'Exception:']);
// strong：中文子串（中文没有词边界）
export const STRONG_CJK = Object.freeze(['错误', '失败', '异常', '致命', '崩溃']);
// weak：词首前缀匹配（等价 \bwarn\w*），只报数、不进输出
export const WEAK_PREFIX = Object.freeze(['warn', 'fail', 'timeout']);
// weak：整词匹配（等价 \bcannot\b / \berrors?\b）
export const WEAK_WORD = Object.freeze(['cannot', 'error', 'errors', 'timed out']);
// weak：中文子串
export const WEAK_CJK = Object.freeze(['警告', '无法', '未能', '超时']);
// skeleton：diff 头前缀
export const DIFF_PREFIXES = Object.freeze(['---', '+++', 'diff --git', '@@ ']);
// skeleton：diff 的 `+`/`-` 行里出现这些骨架词才认定（git diff 中的新增代码）
export const DIFF_SYMBOLS = Object.freeze([
  'export ', 'def ', 'class ', 'function ', 'import ', 'struct ', 'interface ', 'const ',
]);
// skeleton：hex 串（commit / sha）前 24 字节里出现这些词才认定为 sha
export const HEX_HINTS = Object.freeze([
  'sha', 'commit', 'rev', 'hash', 'digest', 'version', 'tag', '@',
]);
// Read 模式下的「符号行」：函数 / 类 / 结构 / 导入等骨架行
export const SYMBOLS = Object.freeze([
  '#include', 'function ', 'def ', 'class ', 'struct ', 'namespace ',
  'impl ', 'interface ', 'pub fn', 'export ', 'typedef ', 'import ',
]);
