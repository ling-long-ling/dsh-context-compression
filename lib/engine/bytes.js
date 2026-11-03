/**
 * 字节级工具：所有长度/预算/计数按 UTF-8 字节（SPEC-1.1.1 §0.1）。
 *
 * 与 Python 参考实现的对应关系：
 *   blen()            = len(s.encode("utf-8", "replace"))
 *   u8_prefix_bytes() = 取前 n 字节，切在字符中间则回退到上一个完整字符
 *   u8_suffix()       = 取后 n 字节，切在字符中间则前进到下一个完整字符
 *   json_safe_prefix()= 截到 limit 字节，JSON 形态优先截在结构边界并补标注
 *
 * Node 的 Buffer.from(str, "utf8") 对孤立代理项的处理与 Python
 * `encode("utf-8", "replace")` 一致（都产出 U+FFFD 的 UTF-8 编码），
 * 因此这里不需要额外兜底。
 */

/** UTF-8 字节数（等价 Python blen）。 */
export function blen(s) {
  return Buffer.byteLength(s, 'utf8');
}

/** UTF-8 编码（等价 s.encode("utf-8", "replace")）。 */
export function toBytes(s) {
  return Buffer.from(s, 'utf8');
}

/**
 * 取前 nbytes 个字节；若切在字符中间则回退到上一个完整字符。
 * @param {Buffer} b
 * @param {number} nbytes
 * @returns {Buffer}
 */
export function u8PrefixBytes(b, nbytes) {
  if (b.length <= nbytes) return b;
  let k = nbytes;
  while (k > 0 && (b[k] & 0xc0) === 0x80) k -= 1;
  return b.subarray(0, k);
}

/** 取字符串的 UTF-8 字节前缀（落在字符边界）。 */
export function u8Prefix(s, nbytes) {
  return u8PrefixBytes(toBytes(s), nbytes).toString('utf8');
}

/**
 * 取后 nbytes 个字节（若切到字符中间则前进到下一个完整字符）。
 * @param {string} s
 * @param {number} nbytes
 * @returns {string}
 */
export function u8Suffix(s, nbytes) {
  const b = toBytes(s);
  if (b.length <= nbytes) return s;
  let st = b.length - nbytes;
  while (st < b.length && (b[st] & 0xc0) === 0x80) st += 1;
  return b.subarray(st).toString('utf8');
}

// Python bytes.lstrip() 剥掉的 ASCII 空白字节：space、\t、\n、\v、\f、\r
function isByteSpace(c) {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0b || c === 0x0c || c === 0x0d;
}

/**
 * 截断到 limit 字节；JSON 形态优先截在结构边界，并补截断标注（SPEC §4.2）。
 * 返回的串总是 ≤ limit 字节（标注若放不下就逐字符缩短，最终退化为纯 "…"）。
 *
 * @param {string} s
 * @param {number} limit
 * @returns {string}
 */
export function jsonSafePrefix(s, limit) {
  const b = toBytes(s);
  const total = b.length;
  if (total <= limit) return s;
  let cut = limit;
  // stripped = len(b) - len(b.lstrip())
  let stripped = 0;
  while (stripped < total && isByteSpace(b[stripped])) stripped += 1;
  if (stripped < total && (b[stripped] === 0x7b || b[stripped] === 0x5b)) {
    // '{' 或 '['
    let lo = limit - 200;
    if (lo < 0) lo = 0;
    let k = limit;
    while (k > lo) {
      const c = b[k - 1];
      if (c === 0x2c || c === 0x7d || c === 0x5d || c === 0x22) {
        // , } ] "
        cut = k;
        break;
      }
      k -= 1;
    }
  }
  const head = u8PrefixBytes(b, cut).toString('utf8');
  const notePrefix = '\u2026（单行过长已截断，原文 ';
  const noteSuffix = ' 字节）';
  let note = notePrefix + String(total) + noteSuffix;
  while (note.length > 0) {
    const cand = head + note;
    if (blen(cand) <= limit) return cand;
    note = note.slice(0, -1);
  }
  return u8Prefix(head, Math.max(0, limit - 3)) + '\u2026';
}

/**
 * 孤立代理项归一化（SPEC §5 main() 步骤 4）。
 *
 * Python 参考实现用 `text.encode("utf-8", "surrogatepass").decode("utf-8", "replace")`：
 * 每个孤立代理项先编码成 3 字节非法 UTF-8（ED A0 80 这类），再按 UTF-8 替换规则
 * 变成 **3 个 U+FFFD**。Node 的 `Buffer.from` 只给 1 个，所以这里手写 WTF-8 编码
 * 再交给 Node 的 UTF-8 解码器（两者对非法序列的「最大子部分」替换规则一致）。
 *
 * 合法字符串（无孤立代理项）原样返回，零开销快路径。
 *
 * @param {string} s
 * @returns {string}
 */
export function normalizeLoneSurrogates(s) {
  // 快路径：先扫一遍，确认没有孤立代理项就直接返回。
  let clean = true;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) continue;
    if (c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1; // 合法代理对
        continue;
      }
    }
    clean = false;
    break;
  }
  if (clean) return s;

  // WTF-8 编码：按码点遍历（代理对合并成一个码点，孤立代理项保留为代理码点）。
  const parts = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp <= 0x7f) {
      parts.push(cp);
    } else if (cp <= 0x7ff) {
      parts.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp <= 0xffff) {
      parts.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      parts.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Buffer.from(parts).toString('utf8');
}
