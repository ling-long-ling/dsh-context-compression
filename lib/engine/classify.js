/**
 * 行分类（SPEC-1.1.1 §3）：0 普通 / 1 WEAK / 2 SKELETON / 3 STRONG。
 *
 * 顺序：先 strong，再 skeleton，最后 weak。
 * 全部判定用**显式字符扫描**（禁用正则），与 C++/Python 双实现逐字节对齐；
 * 需要字节语义的谓词（has_win_path / has_hex_token / is_json_key）显式转 UTF-8 字节扫描。
 */

import {
  DIFF_PREFIXES,
  DIFF_SYMBOLS,
  EXCEPTION_NOUNS,
  HEX_HINTS,
  STRONG_CJK,
  STRONG_SUBS,
  STRONG_WORDS,
  SYMBOLS,
  WEAK_CJK,
  WEAK_PREFIX,
  WEAK_WORD,
} from './constants.js';
import { blen, toBytes } from './bytes.js';

const _WS = ' \t\r\v\f';
const _PATH_CHARS = new Set(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._-',
);
const _HEX_BYTES = new Uint8Array(256);
for (let c = 0; c < 256; c += 1) {
  const isHex = (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
  _HEX_BYTES[c] = isHex ? 1 : 0;
}
const _PATH_BYTES = new Uint8Array(256);
for (let c = 0; c < 256; c += 1) {
  const isPath =
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    c === 0x2e ||
    c === 0x5f ||
    c === 0x2d;
  _PATH_BYTES[c] = isPath ? 1 : 0;
}
const _WORD_BYTES = new Uint8Array(256);
for (let c = 0; c < 256; c += 1) {
  const isWord =
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
  _WORD_BYTES[c] = isWord ? 1 : 0;
}
// HEX_HINTS 的 ASCII 字节（小写化后的小写提示词都是 ASCII）
const HEX_HINT_BYTES = HEX_HINTS.map((h) => Buffer.from(h, 'ascii'));

/** ASCII 词字符：字母 / 数字 / 下划线。 */
export function isWordChar(ch) {
  const o = ch.charCodeAt(0);
  return (
    (o >= 48 && o <= 57) ||
    (o >= 65 && o <= 90) ||
    (o >= 97 && o <= 122) ||
    o === 95
  );
}

/** 字节版 is_word_char（>=0x80 的字节一律不是词字符）。 */
export function isWordByte(c) {
  return _WORD_BYTES[c] === 1;
}

/** 字节版路径字符集 [0-9A-Za-z._-]。 */
export function isPathByte(c) {
  return _PATH_BYTES[c] === 1;
}

/** 字节版 hex 字符 [0-9a-fA-F]。 */
export function isHexByte(c) {
  return _HEX_BYTES[c] === 1;
}

/** 字节版 A-Z。 */
export function isUpperByte(c) {
  return c >= 65 && c <= 90;
}

/** ASCII 数字。 */
export function isDigit(ch) {
  const o = ch.charCodeAt(0);
  return o >= 48 && o <= 57;
}

/** 只把 A-Z 转小写（非 ASCII 保持原样，避免 length 变化破坏 parity）。 */
export function asciiLower(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const o = s.charCodeAt(i);
    out += o >= 65 && o <= 90 ? String.fromCharCode(o + 32) : s[i];
  }
  return out;
}

/**
 * 整词查找：tok 两侧都必须是词边界（左起或前一字符非词字符；右端或后一字符非词字符）。
 * @param {string} line
 * @param {string} tok
 * @param {boolean} [ci] 大小写不敏感（只折 ASCII）
 * @returns {boolean}
 */
export function findWord(line, tok, ci = false) {
  const n = tok.length;
  if (n === 0) return false;
  const hay = ci ? asciiLower(line) : line;
  const needle = ci ? asciiLower(tok) : tok;
  let start = 0;
  const ln = hay.length;
  for (;;) {
    const i = hay.indexOf(needle, start);
    if (i < 0) return false;
    const leftOk = i === 0 || !isWordChar(hay[i - 1]);
    const j = i + n;
    const rightOk = j >= ln || !isWordChar(hay[j]);
    if (leftOk && rightOk) return true;
    start = i + 1;
  }
}

/** 词首前缀匹配（等价 \b<tok>\w*）：左边界为词边界，右侧不限（大小写不敏感）。 */
export function findWordPrefix(line, tok) {
  const n = tok.length;
  if (n === 0) return false;
  const hay = asciiLower(line);
  const needle = asciiLower(tok);
  let start = 0;
  for (;;) {
    const i = hay.indexOf(needle, start);
    if (i < 0) return false;
    if (i === 0 || !isWordChar(hay[i - 1])) return true;
    start = i + 1;
  }
}

/** 剥行首空白 ' ' '\t' '\r' '\v' '\f'。 */
export function lstripWs(line) {
  let i = 0;
  const n = line.length;
  while (i < n && _WS.includes(line[i])) i += 1;
  return line.slice(i);
}

/** 剥行尾 ' ' '\t' '\r'。 */
export function rstripSpTabCr(line) {
  let j = line.length;
  while (j > 0) {
    const ch = line[j - 1];
    if (ch === ' ' || ch === '\t' || ch === '\r') j -= 1;
    else break;
  }
  return line.slice(0, j);
}

/** Read 模式的符号行：命中 SYMBOLS 任一子串。 */
export function isSymbolLine(line) {
  for (const sym of SYMBOLS) {
    if (line.includes(sym)) return true;
  }
  return false;
}

/** error[E1234]：error[E 之后至少 1 位数字，紧跟 ]。 */
export function hasErrorCodeBracket(line) {
  const key = 'error[E';
  let start = 0;
  for (;;) {
    const i = line.indexOf(key, start);
    if (i < 0) return false;
    let j = i + key.length;
    let n = 0;
    while (j < line.length && isDigit(line[j])) {
      j += 1;
      n += 1;
    }
    if (n >= 1 && j < line.length && line[j] === ']') return true;
    start = i + 1;
  }
}

/** error TS1234：error TS 之后至少 1 位数字。 */
export function hasErrorTs(line) {
  const key = 'error TS';
  let start = 0;
  for (;;) {
    const i = line.indexOf(key, start);
    if (i < 0) return false;
    if (i + key.length < line.length && isDigit(line[i + key.length])) return true;
    start = i + 1;
  }
}

/**
 * 全文最后一处**行首** "Exit Code:"，其后可选空格/制表、可选负号、至少 1 位数字且值非 0。
 *
 * v2.1（P2-6）：只认行首形态（行首或前面只隔空白）。以前用 `lastIndexOf` 不看位置，
 * 只要输出里任何地方引用过 `Exit Code: 1`（文档、被回显的脚本）就整段透传。
 * 与 bash 失败判定是同一个函数（P1-1 文本形态）。
 */
export function exitCodeNonzero(text) {
  const key = 'Exit Code:';
  let p = text.lastIndexOf(key);
  for (;;) {
    if (p < 0) return false;
    let b = p;
    while (b > 0 && (text[b - 1] === ' ' || text[b - 1] === '\t')) b -= 1;
    if (b === 0 || text[b - 1] === '\n' || text[b - 1] === '\r') break;
    p = text.lastIndexOf(key, p - 1);
  }
  let i = p + key.length;
  const n = text.length;
  while (i < n && (text[i] === ' ' || text[i] === '\t')) i += 1;
  let neg = false;
  if (i < n && text[i] === '-') {
    neg = true;
    i += 1;
  }
  let v = 0;
  let anyDigit = false;
  while (i < n && isDigit(text[i])) {
    v = v * 10 + (text.charCodeAt(i) - 48);
    anyDigit = true;
    i += 1;
    if (v > 2000000000) break;
  }
  if (!anyDigit) return false;
  if (neg) v = -v;
  return v !== 0;
}

/**
 * 剥 ANSI CSI 序列（`\x1b[<params/intermediates><final>`），彩色 CI 日志用（P2-8）。
 * 只处理 CSI；其他 ESC 序列原样保留。无 ESC 时零开销返回入参。
 * @param {string} s
 * @returns {string}
 */
export function stripAnsi(s) {
  if (s.indexOf('\u001b') < 0) return s;
  const n = s.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 0x1b && i + 1 < n && s.charCodeAt(i + 1) === 0x5b) {
      let j = i + 2;
      while (j < n) {
        const p = s.charCodeAt(j);
        if ((p >= 0x30 && p <= 0x3f) || (p >= 0x20 && p <= 0x2f)) j += 1;
        else break;
      }
      if (j < n && s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e) {
        i = j + 1;
        continue;
      }
    }
    out += s[i];
    i += 1;
  }
  return out;
}

/**
 * 自定义异常类名（P1-5）：`Error:` / `Exception:` 左侧 token 必须以大写开头。
 *
 * `AssertionError:` → token `AssertionError` 大写开头 → true；
 * `isError: false,` → token `isError` 小写开头 → false（配置键不能误判成错误）。
 * @param {string} line
 * @returns {boolean}
 */
export function hasErrorColonToken(line) {
  for (const needle of EXCEPTION_NOUNS) {
    let start = 0;
    for (;;) {
      const i = line.indexOf(needle, start);
      if (i < 0) break;
      let k = i;
      while (k > 0 && isWordChar(line[k - 1])) k -= 1;
      const c0 = line.charCodeAt(k);
      if (c0 >= 65 && c0 <= 90) return true;
      start = i + 1;
    }
  }
  return false;
}

/** STRONG（tier 3）。 */
export function isStrongLine(line) {
  const s = line.indexOf('\u001b') >= 0 ? stripAnsi(line) : line;
  for (const tok of STRONG_WORDS) {
    if (findWord(s, tok)) return true;
  }
  const t = lstripWs(s);
  for (const pre of ['warning:', 'WARNING:']) {
    if (t.startsWith(pre)) {
      const k = pre.length;
      if (k >= t.length || t[k] === ' ' || t[k] === '\t' || t[k] === '\r') return true;
    }
  }
  for (const sub of STRONG_SUBS) {
    if (s.includes(sub)) return true;
  }
  if (hasErrorCodeBracket(s) || hasErrorTs(s)) return true;
  if (hasErrorColonToken(s)) return true;
  if (exitCodeNonzero(s)) return true;
  for (const w of STRONG_CJK) {
    if (s.includes(w)) return true;
  }
  return false;
}

/** 一行里是否出现 http:// 或 https:// 且后跟至少 1 个非空白字符。 */
export function hasUrl(line) {
  const n = line.length;
  for (const pre of ['http://', 'https://']) {
    let start = 0;
    for (;;) {
      const i = line.indexOf(pre, start);
      if (i < 0) break;
      const leftOk = i === 0 || !isWordChar(line[i - 1]);
      const j = i + pre.length;
      if (leftOk && j < n && !' \t\r\n\v\f'.includes(line[j])) return true;
      start = i + 1;
    }
  }
  return false;
}

/** KEY=VALUE：大写键（≥3 字符）后跟可选空白与 '='。 */
export function isKvLine(t) {
  if (!t) return false;
  const c0 = t.charCodeAt(0);
  if (!(c0 >= 65 && c0 <= 90)) return false;
  let i = 1;
  const n = t.length;
  while (i < n) {
    const o = t.charCodeAt(i);
    if ((o >= 65 && o <= 90) || (o >= 48 && o <= 57) || o === 95) i += 1;
    else break;
  }
  if (i < 3) return false;
  while (i < n && (t[i] === ' ' || t[i] === '\t')) i += 1;
  return i < n && t[i] === '=';
}

/** 表格行：t[0] == '|'，去尾空白后仍以 '|' 结尾，且 '|' 至少 2 个。 */
export function isTableLine(t) {
  if (!t || t[0] !== '|') return false;
  const body = rstripSpTabCr(t);
  if (body.length < 2 || body[body.length - 1] !== '|') return false;
  let count = 0;
  for (let i = 0; i < t.length; i += 1) if (t[i] === '|') count += 1;
  return count >= 2;
}

/** POSIX 绝对路径：≥2 个以 '/' 分隔的非空段，段字符 [A-Za-z0-9._-]。 */
export function hasPosixPath(line) {
  const n = line.length;
  let i = 0;
  for (;;) {
    i = line.indexOf('/', i);
    if (i < 0) return false;
    let segs = 0;
    let k = i;
    for (;;) {
      if (k >= n || line[k] !== '/') break;
      k += 1;
      const st = k;
      while (k < n && _PATH_CHARS.has(line[k])) k += 1;
      if (k === st) break;
      segs += 1;
      if (segs >= 2) return true;
      if (k >= n || line[k] !== '/') break;
    }
    i += 1;
  }
}

/** Windows 绝对路径 <letter>:\\...；按 UTF-8 字节扫描。 */
export function hasWinPath(line) {
  return hasWinPathBytes(toBytes(line));
}

/**
 * 字节版 hasWinPath（供 isSkeletonLine 复用同一个 Buffer，避免重复编码）。
 * @param {Buffer} b
 * @returns {boolean}
 */
export function hasWinPathBytes(b) {
  const n = b.length;
  let i = 0;
  while (i + 2 < n) {
    const c = b[i];
    if (
      ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) &&
      b[i + 1] === 0x3a &&
      b[i + 2] === 0x5c
    ) {
      const leftOk = i === 0 || !isWordByte(b[i - 1]);
      if (leftOk) {
        let j = i + 3;
        let cnt = 0;
        let hasSep = false;
        while (j < n && (isPathByte(b[j]) || b[j] === 0x5c)) {
          if (b[j] === 0x5c) hasSep = true;
          j += 1;
          cnt += 1;
        }
        if (cnt >= 3 && hasSep) return true;
      }
    }
    i += 1;
  }
  return false;
}

function bufferIndexOf(buf, needle, start) {
  return buf.indexOf(needle, start);
}

/**
 * 独立 hex 串（commit / sha / 容器 ID）；长度 7..64，含 a-f 字母；
 * 7..11 长度时要求其前 24 字节（小写化后）含 HEX_HINTS 之一。全程按字节扫描。
 */
export function hasHexToken(line) {
  return hasHexTokenBytes(toBytes(line));
}

/**
 * 字节版 hasHexToken（供 isSkeletonLine 复用同一个 Buffer）。
 * @param {Buffer} b
 * @returns {boolean}
 */
export function hasHexTokenBytes(b) {
  const n = b.length;
  let i = 0;
  while (i < n) {
    if (isHexByte(b[i])) {
      let j = i;
      let hasAlpha = false;
      while (j < n && isHexByte(b[j])) {
        const c = b[j];
        if ((c >= 97 && c <= 102) || (c >= 65 && c <= 70)) hasAlpha = true;
        j += 1;
      }
      const length = j - i;
      if (length >= 7 && length <= 64 && hasAlpha) {
        const leftOk = i === 0 || !isWordByte(b[i - 1]);
        const rightOk = j >= n || !isWordByte(b[j]);
        if (leftOk && rightOk) {
          if (length >= 12) return true;
          // 前 24 字节、ASCII 小写化（bytes.lower() 只动 A-Z）
          const headStart = Math.max(0, i - 24);
          const head = Buffer.alloc(i - headStart);
          for (let k = 0; k < head.length; k += 1) {
            const c = b[headStart + k];
            head[k] = c >= 65 && c <= 90 ? c + 32 : c;
          }
          for (const hint of HEX_HINT_BYTES) {
            if (bufferIndexOf(head, hint, 0) >= 0) return true;
          }
        }
      }
      i = j;
    } else {
      i += 1;
    }
  }
  return false;
}

/** JSON 顶层键：行首引号键后紧跟冒号（键长按 UTF-8 字节计）。 */
export function isJsonKey(t) {
  if (!t || t[0] !== '"') return false;
  const j = t.indexOf('"', 1);
  if (j < 0) return false;
  if (blen(t.slice(1, j)) > 80) return false;
  let k = j + 1;
  const n = t.length;
  while (k < n && (t[k] === ' ' || t[k] === '\t')) k += 1;
  return k < n && t[k] === ':';
}

/**
 * 小写/混合大小写的 `key: value`（P1-5，真实数据里最大的一类漏检）。
 *
 * 覆盖 k8s manifest、GitHub Actions workflow、docker-compose、frontmatter 等
 * 小写 YAML/KV：`image: registry.example.com/app:v1`、`runs-on: ubuntu-latest`。
 * 约束：键只含 `[a-z0-9_.-]`（小写开头）、冒号后必须有非空值、整行 ≤ 200 字节、
 * 且值不能以 `/` 开头（排除 `http://` 这类 URL，URL 由 hasUrl 负责）。
 *
 * @param {string} t 已剥行首空白的行
 * @returns {boolean}
 */
export function isLowerKvLine(t) {
  const n = t.length;
  // 200 字节上限先按字符数粗筛（UTF-8 字节数 ≥ 字符数），避免对 10MB 单行做
  // O(n) 的 blen，也不给长行白扫。
  if (n === 0 || n > 200) return false;
  const c0 = t.charCodeAt(0);
  if (!(c0 >= 97 && c0 <= 122)) return false;
  let i = 1;
  while (i < n) {
    const o = t.charCodeAt(i);
    if (
      (o >= 97 && o <= 122) ||
      (o >= 48 && o <= 57) ||
      o === 0x5f ||
      o === 0x2e ||
      o === 0x2d
    ) {
      i += 1;
    } else {
      break;
    }
  }
  if (i >= 64 || i >= n || t[i] !== ':') return false;
  let j = i + 1;
  while (j < n && (t[j] === ' ' || t[j] === '\t')) j += 1;
  if (j >= n) return false;
  if (t[j] === '/') return false;
  return blen(t) <= 200;
}

/**
 * 长行闸门：`path:line` / MAC / `host:port` 这些细粒度模式只在小行上有意义，
 * 而它们要在整行里找 `:` / hex 串。10MB 单行输入（常见于压成一行的 JSON）如果
 * 全扫会白白多花十几毫秒，所以超长行直接不跑这三条。
 * @param {string} line
 * @returns {boolean} 是否值得跑细粒度骨架模式
 */
function isShortEnoughForFinePatterns(line) {
  return line.length <= 8192;
}

/**
 * `path:line` / `path:line:col`（P1-5）：编译器与 grep -n 的定位行。
 *
 * 冒号后必须是 1..9 位数字，数字后是行尾/空白/冒号/逗号/右括号；
 * 冒号左侧的紧邻 token 必须含 `.` 或 `/` 或 `\`（否则 `12:30`、`2026-10-20T12:00` 会误判）。
 *
 * @param {string} line
 * @returns {boolean}
 */
export function hasPathLineRef(line) {
  const n = line.length;
  if (n > 8192) return false;
  let start = 0;
  for (;;) {
    const i = line.indexOf(':', start);
    if (i < 0) return false;
    let j = i + 1;
    let digits = 0;
    while (j < n && digits < 9 && isDigit(line[j])) {
      j += 1;
      digits += 1;
    }
    if (digits >= 1) {
      const after = j < n ? line.charCodeAt(j) : 0x20;
      const okAfter =
        after === 0x3a || after === 0x20 || after === 0x09 || after === 0x2c || after === 0x29;
      if (okAfter) {
        let k = i;
        while (k > 0) {
          const c = line.charCodeAt(k - 1);
          if (
            c === 0x20 ||
            c === 0x09 ||
            c === 0x3a ||
            c === 0x2c ||
            c === 0x28 ||
            c === 0x5b ||
            c === 0x7b ||
            c === 0x27 ||
            c === 0x22 ||
            c === 0x3d
          ) {
            break;
          }
          k -= 1;
        }
        if (i - k > 0) {
          for (let q = k; q < i; q += 1) {
            const c = line.charCodeAt(q);
            if (c === 0x2e || c === 0x2f || c === 0x5c) return true;
          }
        }
      }
    }
    start = i + 1;
  }
}

function isHexCharCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

/**
 * MAC 地址（P1-5）：6 组 2 位 hex，用 `-` 或 `:` 分隔（ipconfig / ifconfig / 网络排障）。
 * 左右边界不能是 hex 字符，避免命中更长的 hex 串。
 * @param {string} line
 * @returns {boolean}
 */
export function hasMacAddress(line) {
  const n = line.length;
  if (n > 8192) return false;
  for (let i = 0; i + 17 <= n; i += 1) {
    if (!isHexCharCode(line.charCodeAt(i))) continue;
    let ok = true;
    for (let g = 0; g < 6; g += 1) {
      const base = i + g * 3;
      if (!isHexCharCode(line.charCodeAt(base)) || !isHexCharCode(line.charCodeAt(base + 1))) {
        ok = false;
        break;
      }
      if (g < 5) {
        const sep = line.charCodeAt(base + 2);
        if (sep !== 0x2d && sep !== 0x3a) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) continue;
    const before = i > 0 ? line.charCodeAt(i - 1) : 0x20;
    const after = i + 17 < n ? line.charCodeAt(i + 17) : 0x20;
    if (!isHexCharCode(before) && !isHexCharCode(after)) return true;
  }
  return false;
}

/**
 * `host:port`（P1-5）：netstat / docker ps / 连接日志里的地址。
 *
 * host 必须是 `[A-Za-z0-9._-]` 且至少含一个字母或 `.`（排除 `12:30` 这类时间），
 * 端口 1..5 位数字，**后面不能是 `:` 或 `.`**（否则 `2026-11-01T00:00:59`、
 * `12:30:45` 这类时间戳会被当成 host:port），也不能是词字符。
 * 另支持 IPv6 方括号形态 `[::1]:8080`。
 *
 * @param {string} line
 * @returns {boolean}
 */
export function hasHostPort(line) {
  const n = line.length;
  if (n > 8192) return false;
  let start = 0;
  for (;;) {
    const i = line.indexOf(':', start);
    if (i < 0) return false;
    // IPv6：[::1]:8080 —— 冒号左边是 ']'，往前找配对的 '['
    if (i > 0 && line[i - 1] === ']') {
      const open = line.lastIndexOf('[', i - 1);
      if (open >= 0) {
        let j = i + 1;
        let digits = 0;
        while (j < n && digits < 5 && isDigit(line[j])) {
          j += 1;
          digits += 1;
        }
        if (digits >= 1 && (j >= n || !isWordChar(line[j]))) return true;
      }
    }
    let j = i + 1;
    let digits = 0;
    while (j < n && digits < 5 && isDigit(line[j])) {
      j += 1;
      digits += 1;
    }
    if (digits >= 1) {
      const after = j < n ? line.charCodeAt(j) : 0x20;
      const afterOk =
        after === 0x20 || // space
        after === 0x09 || // tab
        after === 0x0d ||
        after === 0x2c || // ,
        after === 0x29 || // )
        after === 0x5d || // ]
        after === 0x7d || // }
        after === 0x3b || // ;
        after === 0x27 || // '
        after === 0x22 || // "
        after === 0x2d || // -（docker 端口映射 host:8080->80）
        after === 0x2f; // /（host:8080/tcp）
      if (afterOk) {
        let k = i;
        while (k > 0) {
          const c = line.charCodeAt(k - 1);
          if (
            (c >= 48 && c <= 57) ||
            (c >= 65 && c <= 90) ||
            (c >= 97 && c <= 122) ||
            c === 0x2e ||
            c === 0x2d ||
            c === 0x5f
          ) {
            k -= 1;
          } else {
            break;
          }
        }
        if (i - k >= 1 && i - k <= 255) {
          // 日期前缀 `2026-11-01T` 不是主机名
          const dateLike =
            i - k >= 10 &&
            isDigit(line[k]) &&
            isDigit(line[k + 1]) &&
            isDigit(line[k + 2]) &&
            isDigit(line[k + 3]) &&
            line[k + 4] === '-';
          if (!dateLike) {
            let named = 0;
            for (let q = k; q < i; q += 1) {
              const c = line.charCodeAt(q);
              if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 0x2e) named += 1;
            }
            if (named > 0) return true;
          }
        }
      }
    }
    start = i + 1;
  }
}

/**
 * diff 的 `+`/`-` 行里含代码骨架词（P1-5）：git diff 里的新增/删除代码。
 * @param {string} t 已剥行首空白的行
 * @returns {boolean}
 */
export function isDiffSymbolLine(t) {
  if (t.length < 2) return false;
  const c = t.charCodeAt(0);
  if (c !== 0x2b && c !== 0x2d) return false;
  if (t.startsWith('---') || t.startsWith('+++')) return false;
  for (const sym of DIFF_SYMBOLS) {
    if (t.includes(sym)) return true;
  }
  return false;
}

/**
 * 用户显式关键词（R6 `focusPatterns`）：命中即按 SKELETON 保留。
 * @param {string} line
 * @param {readonly string[]} [patterns]
 * @returns {boolean}
 */
export function focusPatternHit(line, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  for (const p of patterns) {
    if (typeof p === 'string' && p.length > 0 && line.includes(p)) return true;
  }
  return false;
}

/** SKELETON（tier 2，且不是 strong）。 */
export function isSkeletonLine(line) {
  const s = line.indexOf('\u001b') >= 0 ? stripAnsi(line) : line;
  const t = lstripWs(s);
  if (!t) return false;
  if (isKvLine(t)) return true;
  if (isTableLine(t)) return true;
  if (isLowerKvLine(t)) return true;
  for (const pre of DIFF_PREFIXES) {
    if (t.startsWith(pre)) return true;
  }
  if (isDiffSymbolLine(t)) return true;
  if (hasUrl(s)) return true;
  if (hasPosixPath(s)) return true;
  if (isShortEnoughForFinePatterns(s)) {
    if (hasPathLineRef(s)) return true;
    if (hasMacAddress(s)) return true;
    if (hasHostPort(s)) return true;
  }
  let bytes = null;
  const byteView = () => {
    if (bytes === null) bytes = toBytes(s);
    return bytes;
  };
  if (hasWinPathBytes(byteView())) return true;
  if (hasHexTokenBytes(byteView())) return true;
  if (isJsonKey(t)) return true;
  return false;
}

/** WEAK（tier 1，且不是 strong / skeleton）。 */
export function isWeakLine(line) {
  for (const tok of WEAK_PREFIX) {
    if (findWordPrefix(line, tok)) return true;
  }
  for (const tok of WEAK_WORD) {
    if (findWord(line, tok, true)) return true;
  }
  for (const w of WEAK_CJK) {
    if (line.includes(w)) return true;
  }
  return false;
}

/**
 * 分类一行。
 * @param {string} line
 * @returns {0|1|2|3} 0 普通 / 1 WEAK / 2 SKELETON / 3 STRONG
 */
export function classifyLine(line) {
  if (isStrongLine(line)) return 3;
  if (isSkeletonLine(line)) return 2;
  if (isWeakLine(line)) return 1;
  return 0;
}
