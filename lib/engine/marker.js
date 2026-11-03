/**
 * 标记与幂等判定（SPEC-1.1.1 §4.4 / §5，DESIGN §7 品牌替换）。
 *
 * 2.0 起标记前缀是 `… [dsh-ctx `（旧的 `… [wb-ops ` 不再识别为幂等：
 * v2 只认新标记，避免把历史会话里的旧标记或正文裸子串误判）。
 * 幂等判定只认**行首**（或全文开头）的标记结构。
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

/** 少行分支的省略标记（含前导换行与尾随换行，SPEC §4.2）。 */
export function shortLineMarker({ omitted, tbytes, singleLineOversize, spillPath }) {
  let marker = `\n\u2026 [dsh-ctx 省略 ${omitted} 字节`;
  if (singleLineOversize) marker += `（单行过长已截断，原文 ${tbytes} 字节）`;
  marker += spillSuffix(spillPath);
  marker += '] \u2026\n';
  return marker;
}

/** 头段/中段省略标记（普通模式，有关键行被保留）。 */
export function keptMarker({ silent, rngLo, rngHi, detail, spillPath }) {
  return `\u2026 [dsh-ctx 省略 ${silent} 行（第 ${rngLo}\u2013${rngHi} 行）；${detail}${spillSuffix(spillPath)}] \u2026`;
}

/** 头段省略标记（普通模式，关键行全在显示区 / 一条都没有）。 */
export function plainMarker({ silent, rngLo, rngHi, kind }) {
  const tail =
    kind === 'in_region'
      ? '关键行已包含在显示区域'
      : '未发现错误/关键值行';
  return `\u2026 [dsh-ctx 省略 ${silent} 行（第 ${rngLo}\u2013${rngHi} 行，${tail}）] \u2026`;
}

/** 头段省略标记（Read 模式）。 */
export function readMarker({ silent, rngLo, rngHi, symbolCount, kind }) {
  if (kind === 'kept') {
    return `\u2026 [dsh-ctx 省略 ${silent} 行（第 ${rngLo}\u2013${rngHi} 行）；保留 ${symbolCount} 条符号行，可加 offset 回查] \u2026`;
  }
  const tail =
    kind === 'in_region' ? '符号行已包含在显示区域' : '未发现函数/类/import 行';
  return `\u2026 [dsh-ctx 省略 ${silent} 行（第 ${rngLo}\u2013${rngHi} 行，${tail}）] \u2026`;
}

/** 尾段标记（未变，只换品牌）。 */
export function tailMarker({ shownCount, total }) {
  return `\u2026 [dsh-ctx 以下为原文末尾 ${shownCount} 行（第 ${total - shownCount + 1}\u2013${total} 行）] \u2026`;
}
