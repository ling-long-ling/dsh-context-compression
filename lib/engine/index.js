/**
 * 分层裁剪引擎入口（DESIGN §3）。
 *
 * `trimToolText()` 是纯函数：不读环境变量、不写 stdout、不抛异常。
 * 所有开关都来自 `options`（已由 lib/config.js 解析），所有长度/预算/计数按 UTF-8 字节。
 *
 * 判定顺序照 SPEC-1.1.1 §5（顺序即优先级）：
 *   persisted → read_off → bash_failed → idem → trim
 */

import { MAX_BYTES } from './constants.js';
import { blen, normalizeLoneSurrogates } from './bytes.js';
import { exitCodeNonzero } from './classify.js';
import { hasTrimMarker } from './marker.js';
import { trimText } from './trim.js';

/** 引擎版本（与包版本一致）。 */
export const ENGINE_VERSION = '2.0.0';

const PERSISTED_NEEDLE = Buffer.from('<persisted-output', 'utf8');
const PERSISTED_WINDOW = 4000;

/** 每次返回全新的 meta，避免调用方改到共享对象。 */
function emptyMeta() {
  return { k: 0, g: 0, w: 0, p: 0 };
}

/** P1-3：宿主已把超大输出落盘、只给预览时，别再二次处理（按前 4000 字节判）。 */
function hasPersistedOutput(text) {
  const b = Buffer.from(text, 'utf8');
  if (b.length <= PERSISTED_WINDOW) return b.indexOf(PERSISTED_NEEDLE) >= 0;
  return b.subarray(0, PERSISTED_WINDOW).indexOf(PERSISTED_NEEDLE) >= 0;
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * 裁剪一段工具输出文本。
 *
 * @param {{ text: string, tool: 'Bash'|'Grep'|'Glob'|'WebFetch'|'Read' }} input
 * @param {{
 *   budgetBytes: number,
 *   minBytes: number,
 *   readMode: boolean,
 *   readTrim?: boolean,
 *   spillEnabled: boolean,
 *   spillDir: string,
 *   spillDays: number,
 *   sessionId: string,
 *   minSaveBytes?: number,
 *   minSavePercent?: number,
 *   now?: () => number,
 * }} options
 * @returns {{
 *   text: string|null,
 *   meta: { k: number, g: number, w: number, p: 0|1 },
 *   bytesBefore: number,
 *   bytesAfter: number,
 *   reason: 'trim'|'short'|'read_off'|'persisted'|'idem'|'bash_failed'|'error',
 * }}
 *   `text === null` 表示不改动（原因在 `reason`）；否则 `text` 是压缩结果（标记已内嵌）。
 */
export function trimToolText(input, options) {
  const opts = options || {};
  const rawText = input && typeof input.text === 'string' ? input.text : null;
  const tool = input && typeof input.tool === 'string' ? input.tool : '';

  if (rawText === null) {
    return {
      text: null,
      meta: emptyMeta(),
      bytesBefore: 0,
      bytesAfter: 0,
      reason: 'error',
    };
  }

  let text;
  try {
    // 与参考实现 main() 步骤 4 一致：孤立代理项归一化为 U+FFFD
    text = normalizeLoneSurrogates(rawText);
  } catch {
    text = rawText;
  }
  const bytesBefore = blen(text);
  const noTrim = (reason) => ({
    text: null,
    meta: emptyMeta(),
    bytesBefore,
    bytesAfter: bytesBefore,
    reason,
  });

  // 1) 宿主已外置（P1-3）
  if (hasPersistedOutput(text)) return noTrim('persisted');

  // 2) Read 未开裁剪（F6：必须先于 idem，否则正文恰好含标记会被误报成 idem）
  const readTrim = opts.readTrim === true;
  if (tool === 'Read' && !readTrim) return noTrim('read_off');

  // 3) Bash 失败输出整段透传（P1-1 文本形态；结构化失败由服务层按 isError 跳过）
  if (tool === 'Bash' && exitCodeNonzero(text)) return noTrim('bash_failed');

  // 4) 幂等：已经是本插件裁剪过的形态（只认行首新标记）
  if (hasTrimMarker(text)) return noTrim('idem');

  // 5) 裁剪
  let result;
  try {
    result = trimText(text, {
      tool,
      readMode: opts.readMode === true,
      budgetBytes: numberOr(opts.budgetBytes, MAX_BYTES),
      minBytes: numberOr(opts.minBytes, 0),
      spillEnabled: opts.spillEnabled === true,
      spillDir: typeof opts.spillDir === 'string' ? opts.spillDir : '',
      spillDays: opts.spillDays,
      sessionId: typeof opts.sessionId === 'string' ? opts.sessionId : '',
      minSaveBytes: opts.minSaveBytes,
      minSavePercent: opts.minSavePercent,
      now: opts.now,
    });
  } catch {
    // 兜底：裁剪出任何意外都静默透传，绝不阻断上层流程
    return noTrim('error');
  }

  if (result === null) return noTrim('short');

  return {
    text: result.text,
    meta: result.meta,
    bytesBefore,
    bytesAfter: result.bytesAfter,
    reason: 'trim',
  };
}
