/**
 * 展示与填充（SPEC-1.1.1 §4.3.7）：
 *   display_line()       = 超长单行按 MAX_LINE_BYTES 自截并带标注
 *   fill_forward_idx()   = 按行号从前往后填进段配额
 *   fill_backward_idx()  = 反转后走 forward，结果再反转（从尾往前挑、输出保原序）
 *   fill_recent()        = 关键行从新到旧挑，结果保持行号升序
 */

import { MAX_LINE_BYTES, MIN_LINE_BYTES } from './constants.js';
import { blen, jsonSafePrefix, u8Prefix } from './bytes.js';

/**
 * @param {string} line
 * @returns {{ text: string, want: number }} 展示串与该段需要的字节额度
 */
export function displayLine(line) {
  const n = blen(line);
  if (n > MAX_LINE_BYTES) {
    const disp = jsonSafePrefix(line, MAX_LINE_BYTES);
    return { text: disp, want: blen(disp) };
  }
  return { text: line, want: n };
}

// used + want + 1 <= cap 时才放整行；否则按剩余额度截断末行（剩余够 MIN_LINE_BYTES+3 才截）

/**
 * 按行号从前往后填充；返回 `{ shown: string[], used }`。
 * 调用方据 `shown.length` 前缀还原已显示行号。
 * @param {number[]} idx
 * @param {string[]} lines
 * @param {number} cap
 * @param {number} used
 */
export function fillForwardIdx(idx, lines, cap, used) {
  const chosen = [];
  for (const i of idx) {
    const line = lines[i];
    const { text, want } = displayLine(line);
    if (used + want + 1 <= cap) {
      chosen.push(text);
      used += want + 1;
    } else {
      const rem = cap > used + 1 ? cap - used - 1 : 0;
      if (rem >= MIN_LINE_BYTES + 3) {
        chosen.push(u8Prefix(line, rem - 3) + '\u2026');
        used = cap;
      }
      break;
    }
  }
  return { shown: chosen, used };
}

/**
 * 按行号从后往前填充，输出行序恢复原文顺序。
 * @returns {{ shown: string[], used: number }}
 */
export function fillBackwardIdx(idx, lines, cap, used) {
  const rev = Array.from(idx).reverse();
  const r = fillForwardIdx(rev, lines, cap, used);
  return { shown: r.shown.slice().reverse(), used: r.used };
}

/**
 * 关键行填充：从新到旧挑（时间倒序优先），返回行号升序的 `(idx, 展示串)` 与 used。
 * @returns {{ picked: Array<[number, string]>, used: number }}
 */
export function fillRecent(idx, lines, cap, used) {
  const picked = [];
  for (let n = idx.length - 1; n >= 0; n -= 1) {
    const i = idx[n];
    const line = lines[i];
    const { text, want } = displayLine(line);
    if (used + want + 1 <= cap) {
      picked.push([i, text]);
      used += want + 1;
    } else {
      const rem = cap > used + 1 ? cap - used - 1 : 0;
      if (rem >= MIN_LINE_BYTES + 3) {
        picked.push([i, u8Prefix(line, rem - 3) + '\u2026']);
        used = cap;
      }
      break;
    }
  }
  picked.reverse();
  return { picked, used };
}
