/**
 * 原文落盘（SPEC-1.1.1 §4.5，P0-3）：内容寻址、7 天清理、失败不影响裁剪。
 *
 * 文件：`<spillDir>/<sid8>/<crc32(utf8(text)) 8 位小写 hex>-<tbytes hex>.txt`
 *   - 写入原始 text 的 UTF-8 字节（与原文逐字节一致）
 *   - 同内容 = 同名（天然去重，双实现一致）
 *   - 写失败返回 null，标记里就不带路径；绝不抛异常
 */

import fs from 'node:fs';
import path from 'node:path';
import { SPILL_DAYS, SPILL_SCAN_CAP } from './constants.js';
import { u8Prefix } from './bytes.js';

// ---- crc32（IEEE 802.3，多项式 0xEDB88320）----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * 计算 crc32（无符号 32 位）。
 * @param {Buffer} buf
 * @returns {number}
 */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 会话 id 前 8 字节（不切断多字节字符）→ 仅保留 [A-Za-z0-9_-]，空则 "nosid"。 */
export function safeSidDir(sessionId) {
  const sid8 = u8Prefix(sessionId || '', 8);
  let s = '';
  for (const ch of sid8) {
    if (
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= 'a' && ch <= 'z') ||
      (ch >= '0' && ch <= '9') ||
      ch === '-' ||
      ch === '_'
    ) {
      s += ch;
    }
  }
  return s || 'nosid';
}

/** 内容寻址文件名：`%08x-%x.txt`（crc32 与 tbytes 的 UTF-8 字节数）。 */
export function spillName(text) {
  const raw = Buffer.from(text, 'utf8');
  const crc = crc32(raw);
  return `${crc.toString(16).padStart(8, '0')}-${raw.length.toString(16)}.txt`;
}

/**
 * 删除本会话目录里超过 keep 天的普通文件（目录项超过 500 个时只扫前 500 个）。
 * 静默失败。
 */
export function cleanupSpill(dirPath, keepDays, nowMs) {
  try {
    const keep = Number.isInteger(keepDays) && keepDays > 0 && keepDays < 3660 ? keepDays : SPILL_DAYS;
    const limit = nowMs / 1000 - keep * 86400;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const cap = Math.min(entries.length, SPILL_SCAN_CAP);
    for (let n = 0; n < cap; n += 1) {
      const entry = entries[n];
      try {
        if (!entry.isFile()) continue;
        const st = fs.statSync(path.join(dirPath, entry.name));
        if (st.mtimeMs / 1000 < limit) fs.unlinkSync(path.join(dirPath, entry.name));
      } catch {
        // 单个目录项失败不影响清理整体
      }
    }
  } catch {
    // 目录读不到就算了
  }
}

/**
 * 把原文逐字节落盘，返回路径或 null。
 *
 * @param {string} text
 * @param {{
 *   enabled: boolean,
 *   dir: string,
 *   days: number,
 *   sessionId: string,
 *   now?: () => number,
 * }} spillOptions
 * @returns {string|null}
 */
export function spillOriginal(text, spillOptions) {
  const { enabled, dir, days, sessionId, now } = spillOptions;
  if (!enabled) return null;
  if (!dir) return null;
  const raw = Buffer.from(text, 'utf8');
  const sid8 = safeSidDir(sessionId);
  const dirPath = path.join(dir, sid8);
  const full = path.join(dirPath, spillName(text));
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(full, raw);
  } catch {
    return null;
  }
  const nowMs = typeof now === 'function' ? now() : Date.now();
  cleanupSpill(dirPath, days, nowMs);
  return full;
}
