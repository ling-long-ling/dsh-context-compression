/**
 * 行分类（SPEC-1.1.1 §3）：0 普通 / 1 WEAK / 2 SKELETON / 3 STRONG。
 *
 * 顺序：先 strong，再 skeleton，最后 weak。
 * 全部判定用**显式字符扫描**（禁用正则），与 C++/Python 双实现逐字节对齐；
 * 需要字节语义的谓词（has_win_path / has_hex_token / is_json_key）显式转 UTF-8 字节扫描。
 */

import {
  DIFF_PREFIXES,
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
 * 全文最后一处 "Exit Code:"，其后可选空格/制表、可选负号、至少 1 位数字且值非 0。
 * 与 bash 失败判定是同一个函数（P1-1 文本形态）。
 */
export function exitCodeNonzero(text) {
  const key = 'Exit Code:';
  const p = text.lastIndexOf(key);
  if (p < 0) return false;
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

/** STRONG（tier 3）。 */
export function isStrongLine(line) {
  for (const tok of STRONG_WORDS) {
    if (findWord(line, tok)) return true;
  }
  const t = lstripWs(line);
  for (const pre of ['warning:', 'WARNING:']) {
    if (t.startsWith(pre)) {
      const k = pre.length;
      if (k >= t.length || t[k] === ' ' || t[k] === '\t' || t[k] === '\r') return true;
    }
  }
  for (const sub of STRONG_SUBS) {
    if (line.includes(sub)) return true;
  }
  if (hasErrorCodeBracket(line) || hasErrorTs(line)) return true;
  if (exitCodeNonzero(line)) return true;
  for (const w of STRONG_CJK) {
    if (line.includes(w)) return true;
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
  const b = toBytes(line);
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
 * 独立 hex 串（commit / sha）；长度 7..64，含 a-f 字母；
 * 7..11 长度时要求其前 24 字节（小写化后）含 HEX_HINTS 之一。全程按字节扫描。
 */
export function hasHexToken(line) {
  const b = toBytes(line);
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

/** SKELETON（tier 2，且不是 strong）。 */
export function isSkeletonLine(line) {
  const t = lstripWs(line);
  if (!t) return false;
  if (isKvLine(t)) return true;
  if (isTableLine(t)) return true;
  for (const pre of DIFF_PREFIXES) {
    if (t.startsWith(pre)) return true;
  }
  if (hasUrl(line)) return true;
  if (hasPosixPath(line)) return true;
  if (hasWinPath(line)) return true;
  if (hasHexToken(line)) return true;
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
