/**
 * O1b 同签名归并 + F2 条数自适应 / 全区间取样（SPEC-1.1.1 §4.3.2 ~ §4.3.6）。
 *
 * 签名（strong_signature）只作分组键，**绝不进入输出**：
 * 数字段折成 '#'、空白段折成 ' '、A-Z 折小写，然后取 UTF-8 前 96 字节原样作 bytes 键
 * （不 decode、不补 U+FFFD —— 补了会把两条不同级联错误误并成一组）。
 */

import { ADAPTIVE_LINE_BYTES, ADAPTIVE_LINE_CAP } from './constants.js';
import { toBytes } from './bytes.js';

// 只剥 ASCII 空格（' '），制表/回车在折叠阶段已变成空格
function stripAsciiSpaces(s) {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === ' ') start += 1;
  while (end > start && s[end - 1] === ' ') end -= 1;
  return s.slice(start, end);
}

/**
 * 错误行签名（O1b）：抹掉「数字 / 时间戳 / 空白差异」，把同一条级联错误归并成一类。
 *
 * 只用显式 ASCII 字符扫描（故意不用正则 / str.lower()）：
 *   - 连续的十进制数字整体替换成 '#'
 *   - 连续空白（' ' '\t' '\r'）折叠成一个空格（仅当已输出内容时）
 *   - A-Z 折成小写（只动 ASCII，不动非 ASCII 的长度）
 *   - 截前 96 字节（按字节前缀截断，返回 Buffer 作分组键）
 *
 * @param {string} line
 * @returns {Buffer} UTF-8 前 96 字节
 */
export function strongSignature(line) {
  let out = '';
  let prevDigit = false;
  let prevSp = false;
  for (const ch of line) {
    const o = ch.codePointAt(0);
    if (o >= 48 && o <= 57) {
      if (!prevDigit) out += '#';
      prevDigit = true;
      prevSp = false;
    } else {
      prevDigit = false;
      if (ch === ' ' || ch === '\t' || ch === '\r') {
        if (!prevSp && out.length > 0) out += ' ';
        prevSp = true;
      } else {
        out += o >= 65 && o <= 90 ? String.fromCodePoint(o + 32) : ch;
        prevSp = false;
      }
    }
  }
  const s = stripAsciiSpaces(out);
  return toBytes(s).subarray(0, 96);
}

/**
 * O1b：同签名级联错误「超出 cap 才归并」——每组保首条 + 等距取样（含末条）。
 *
 * 返回 `{ kept, merged, firsts }`：
 *   - kept：升序行号列表
 *   - merged：被归并掉的行数
 *   - firsts：各组首条中仍在 kept 里的行号集合（供 O3 首因优先）
 *
 * @param {number[]} idx 升序 strong 候选行号
 * @param {string[]} lines
 * @param {number} cap
 */
export function dedupStrong(idx, lines, cap) {
  if (idx.length <= cap) {
    return { kept: idx.slice(), merged: 0, firsts: new Set() };
  }
  const groups = new Map(); // 字节签名的 latin1 串 -> 行号数组（Map 保插入顺序）
  const order = [];
  for (const i of idx) {
    const key = strongSignature(lines[i]).toString('latin1');
    let g = groups.get(key);
    if (g === undefined) {
      g = [];
      groups.set(key, g);
      order.push(key);
    }
    g.push(i);
  }

  const total = idx.length;
  let kept = [];
  for (const key of order) {
    const g = groups.get(key);
    let quota = Math.floor((cap * g.length) / total);
    if (quota < 1) quota = 1;
    if (quota >= g.length) {
      for (const i of g) kept.push(i);
      continue;
    }
    if (quota === 1) {
      kept.push(g[0]);
      continue;
    }
    // 等距取样：必含首条与末条
    const last = g.length - 1;
    for (let k = 0; k < quota; k += 1) {
      kept.push(g[Math.floor((last * k) / (quota - 1))]);
    }
  }
  kept = Array.from(new Set(kept)).sort((a, b) => a - b);
  if (kept.length > cap) kept = kept.slice(0, cap);
  const keptSet = new Set(kept);
  const firsts = new Set();
  for (const g of groups.values()) {
    if (keptSet.has(g[0])) firsts.add(g[0]);
  }
  return { kept, merged: total - kept.length, firsts };
}

/**
 * F2：条数上限随该段字节配额自适应（//32，硬顶 128）。
 * @param {number} capBytes
 * @param {number} base
 */
export function adaptiveCount(capBytes, base) {
  let v = Math.floor(capBytes / ADAPTIVE_LINE_BYTES);
  if (v < base) v = base;
  if (v > ADAPTIVE_LINE_CAP) v = ADAPTIVE_LINE_CAP;
  return v;
}

/**
 * F2：在候选区间上等距取样（不只取最近的 cap 条）。返回行号升序列表；
 * 调用方随后仍交给 fill_recent 按预算从新到旧填充。
 * @param {number[]} idx
 * @param {number} cap
 */
export function pickSpread(idx, cap) {
  if (cap <= 0 || !idx.length) return [];
  const n = idx.length;
  if (n <= cap) return idx.slice();
  const out = [];
  for (let k = 0; k < cap; k += 1) {
    out.push(idx[Math.floor(((2 * k + 1) * n) / (2 * cap))]);
  }
  return out;
}
