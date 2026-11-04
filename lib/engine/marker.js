/**
 * 标记与幂等判定（SPEC-1.1.1 §4.4 / §5，DESIGN §7 品牌替换）。
 *
 * 2.0 起标记前缀是 `… [dsh-ctx `（旧的 `… [wb-ops ` 不再识别为幂等：
 * v2 只认新标记，避免把历史会话里的旧标记或正文裸子串误判）。
 * 幂等判定只认**行首**（或全文开头）的标记结构。
 *
 * v2.1 起：
 *   - 行号区间说明区间内可能夹着已保留的关键行（P2-1），不再暗示区间是连续删除；
 *   - 无关键行时也带落盘路径（P1-4），兑现 README 的「丢了能回查」；
 *   - Read 标记同时报符号行与错误行（P1-2）；
 *   - 标记行尾跟随输入主导换行（P2-9）。
 */

/** 标记 needle：U+2026 + 空格 + `[dsh-ctx `。 */
export const MARKER_NEEDLE = '\u2026 [dsh-ctx ';

const NEEDLE_BUF = Buffer.from(MARKER_NEEDLE, 'utf8');

/**
 * 按字节查找行首标记结构。等价 Python：
 *   p = find(text, needle); while p >= 0: if p == 0 or text[p-1] == '\n': return True ...
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasTrimMarker(text) {
  const b = Buffer.from(text, 'utf8');
  let p = b.indexOf(NEEDLE_BUF);
  while (p >= 0) {
    if (p === 0 || b[p - 1] === 0x0a) return true;
    p = b.indexOf(NEEDLE_BUF, p + 1);
  }
  return false;
}

/** 落盘段：`；原文 {path}，可 Grep 回查`（无落盘时整段是空串）。 */
export function spillSuffix(spillPath) {
  return spillPath ? `；原文 ${spillPath}，可 Grep 回查` : '';
}

/**
 * 行号区间文案。折行/区间内夹着已保留行时说清楚，避免模型按 a..b 推断被删行（P2-1）。
 * @param {number} rngLo 1-based
 * @param {number} rngHi 1-based
 * @param {number} inSpan 区间内已保留的行数
 */
function rangeText(rngLo, rngHi, inSpan) {
  const base =
    rngLo === rngHi ? `第 ${rngLo} 行` : `第 ${rngLo}\u2013${rngHi} 行`;
  const span =
    inSpan > 0 ? `，该区间内另有 ${inSpan} 行已保留在上/下文` : '';
  return `${base}${span}`;
}

/** 少行分支的省略标记（含前导换行与尾随换行，SPEC §4.2）。 */
export function shortLineMarker({ omitted, tbytes, singleLineOversize, spillPath, eol = '\n' }) {
  let marker = `${eol}\u2026 [dsh-ctx 省略 ${omitted} 字节`;
  if (singleLineOversize) marker += `（单行过长已截断，原文 ${tbytes} 字节）`;
  marker += spillSuffix(spillPath);
  marker += `] \u2026${eol}`;
  return marker;
}

/** 头段/中段省略标记（普通模式，有关键行被保留）。 */
export function keptMarker({ silent, rngLo, rngHi, detail, spillPath, inSpan = 0 }) {
  const detailPart = detail ? `；${detail}` : '';
  return `\u2026 [dsh-ctx 省略 ${silent} 行（${rangeText(rngLo, rngHi, inSpan)}）${detailPart}${spillSuffix(spillPath)}] \u2026`;
}

/** 头段省略标记（普通模式，关键行全在显示区 / 一条都没有）。 */
export function plainMarker({ silent, rngLo, rngHi, kind, spillPath, inSpan = 0 }) {
  const tail =
    kind === 'in_region'
      ? '关键行已包含在显示区域'
      : '未发现错误/关键值行';
  return `\u2026 [dsh-ctx 省略 ${silent} 行（${rangeText(rngLo, rngHi, inSpan)}，${tail}）${spillSuffix(spillPath)}] \u2026`;
}

/** 头段省略标记（Read 模式）。 */
export function readMarker({
  silent,
  rngLo,
  rngHi,
  symbolCount = 0,
  errorCount = 0,
  keyCount = 0,
  kind,
  inSpan = 0,
}) {
  if (kind === 'kept') {
    const parts = [];
    if (symbolCount > 0) parts.push(`${symbolCount} 条符号行`);
    if (errorCount > 0) parts.push(`${errorCount} 条错误行`);
    if (parts.length === 0 && keyCount > 0) parts.push(`${keyCount} 条关键行`);
    const detail =
      parts.length > 0 ? `保留 ${parts.join('、')}，可加 offset 回查` : '可加 offset 回查';
    return `\u2026 [dsh-ctx 省略 ${silent} 行（${rangeText(rngLo, rngHi, inSpan)}）；${detail}] \u2026`;
  }
  const tail =
    kind === 'in_region' ? '符号行已包含在显示区域' : '未发现函数/类/import 行';
  return `\u2026 [dsh-ctx 省略 ${silent} 行（${rangeText(rngLo, rngHi, inSpan)}，${tail}）] \u2026`;
}

/** 尾段标记（行号按真实行数，v2.1 修正末尾换行导致的 +1，见 P1-8）。 */
export function tailMarker({ shownCount, total }) {
  return `\u2026 [dsh-ctx 以下为原文末尾 ${shownCount} 行（第 ${total - shownCount + 1}\u2013${total} 行）] \u2026`;
}
