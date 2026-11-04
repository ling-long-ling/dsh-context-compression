/**
 * 分层裁剪算法主体（SPEC-1.1.1 §4）—— trim.py 的 `trim()` / `finish()` 逐条移植。
 *
 * 输出结构：开头行 → [省略标记] → 保留的关键行 → [末尾标记] → 结尾行
 *
 * 本模块假设调用方已完成 main() 的前置判定（persisted / read_off / bash_failed / idem），
 * 并把预算、门槛、开关都解析成参数传进来（引擎不读环境变量）。
 *
 * v2.1 行为修正（对应评测报告 R2/R3/R4/R5/R9 与 P1-2/3/4/5/6/7/8、P2-1/4/9）：
 *   - 输入已 ≤ 预算时直接不裁（R3，消灭「白裁」窗口）；
 *   - Read 模式同时保留符号行与错误行，并在标记里分别报数（R2/P1-2）；
 *   - 末尾换行不再虚增行号（P1-8），标记区间说明区间内已保留的行（P2-1）；
 *   - 无关键行时也落盘（P1-4），`finish` 退化时删除已写文件（P2-4）；
 *   - 少行分支的「省略 N 字节」按标记实长固定点求解，不再硬切失真（P1-7）；
 *   - 按输入主导行尾输出（P2-9）；
 *   - 超大行密集输入按等距抽样分类（R9/P1-6）。
 */

import {
  HEAD_LINES,
  MARKER_RESERVE,
  MAX_CLASSIFY_LINES,
  MAX_SKEL_LINES,
  MAX_STRONG_LINES,
  MIN_SAVE_BYTES,
  MIN_SAVE_PCT,
  READ_HEAD_LINES,
  READ_SYMBOL_MIN_LINES,
  READ_TAIL_LINES,
  SAMPLE_CLASSIFY_CAP,
  SECTION_HEAD,
  SECTION_SKEL_ADD,
  SECTION_STRONG,
  TAIL_LINES,
} from './constants.js';
import { blen, jsonSafePrefix, u8Suffix } from './bytes.js';
import { classifyLine, focusPatternHit, isStrongLine, isSymbolLine } from './classify.js';
import { adaptiveCount, dedupStrong, pickSpread } from './dedup.js';
import { fillBackwardIdx, fillForwardIdx, fillRecent, displayLine } from './display.js';
import {
  keptMarker,
  plainMarker,
  readMarker,
  shortLineMarker,
  spillSuffix,
  tailMarker,
} from './marker.js';
import { deleteSpill, spillOriginal } from './spill.js';

/**
 * @typedef {object} TrimParams
 * @property {string} tool - 规范化工具类（仅用于日志语义，判定已在 main 层）
 * @property {boolean} readMode - Read 裁剪模式
 * @property {number} budgetBytes - 已解析的字节预算（触发后的目标恒为它）
 * @property {number} minBytes - 已解析的触发门槛（v2.1 起引擎不读：触发只看 tbytes > budgetBytes，仅保留入参兼容）
 * @property {boolean} spillEnabled
 * @property {string} spillDir
 * @property {number} spillDays
 * @property {string} sessionId
 * @property {readonly string[]} [focusPatterns] - 用户显式关键词，命中即按关键行保留
 * @property {number} [minSaveBytes]
 * @property {number} [minSavePercent]
 * @property {() => number} [now]
 */

/**
 * 拆行并统一行尾。
 *
 * @param {string} text
 * @returns {{ lines: string[], eol: string, trailingNewline: boolean }}
 */
function splitLines(text) {
  const raw = text.split('\n');
  const trailingNewline = raw.length > 1 && raw[raw.length - 1] === '';
  if (trailingNewline) raw.pop(); // P1-8：末尾换行不产生空行，否则所有行号 +1
  let crlf = 0;
  for (const line of raw) {
    if (line.endsWith('\r')) crlf += 1;
  }
  const eol = crlf * 2 > raw.length ? '\r\n' : '\n';
  const lines =
    eol === '\n'
      ? raw
      : raw.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  return { lines, eol, trailingNewline };
}

/** `jsonSafePrefix` 截断时插入的标注前缀（它不属于原文，不能算作"已保留的原文字节"）。 */
const TRUNC_NOTE_MARK = '\u2026\uff08\u5355\u884c\u8fc7\u957f\u5df2\u622a\u65ad';

/**
 * 头段里由 `jsonSafePrefix` 插入的标注字节数（0 表示没有插入）。
 * 标记里的「省略 N 字节」按**原文**字节算，标注是插件自己加的字，必须扣掉（P1-7）。
 *
 * @param {string} head
 * @returns {number}
 */
function insertedNoteBytes(head) {
  const p = head.lastIndexOf(TRUNC_NOTE_MARK);
  if (p < 0) return 0;
  return blen(head) - blen(head.slice(0, p));
}

/**
 * 少行/单行分支：头段 + 标记 + 尾段，按标记实长求解（P1-7）。
 *
 * 标记长度只随「省略 N 字节」的位数变化，所以先用上界 `tbytes` 估一次；
 * 算出真实省略量后若位数没变，立即收敛（10MB 单行只做一次前缀/后缀拷贝，
 * 而不是每个迭代都对整段文本再编码一次）。
 *
 * @param {string} text
 * @param {{ tbytes: number, eff: number, total: number, spillPath: string|null, eol: string }} ctx
 * @returns {{ text: string, meta: {k:number,g:number,w:number,p:number} }}
 */
function shortLineBranch(text, ctx) {
  const { tbytes, eff, total, spillPath, eol } = ctx;
  const singleLineOversize = total <= 3;
  const buildMarker = (omitted) =>
    shortLineMarker({ omitted, tbytes, singleLineOversize, spillPath, eol });
  let marker = buildMarker(tbytes);
  let head = '';
  let tail = '';
  for (let iter = 0; iter < 3; iter += 1) {
    const avail = eff - blen(marker);
    const lh = avail > 0 ? Math.floor((avail * 5) / 8) : 0;
    const lt = avail > 0 ? Math.floor((avail * 3) / 10) : 0;
    head = lh > 0 ? jsonSafePrefix(text, lh) : '';
    tail = lt > 0 ? u8Suffix(text, lt) : '';
    const keptOriginal = blen(head) - insertedNoteBytes(head) + blen(tail);
    const next = buildMarker(tbytes - keptOriginal);
    const sameLength = blen(next) === blen(marker);
    marker = next;
    if (sameLength) break; // 位数没变 → 预算分配不用重算
  }
  return {
    text: head + marker + tail,
    meta: { k: 0, g: 0, w: 0, p: spillPath ? 1 : 0 },
  };
}

/**
 * 分类一行（含 Read 模式与用户关键词）。
 *
 * Read 模式用 4 = 真错误 / 3 = 符号行两档：错误行先占预算（见 trimText 的分层填充），
 * 符号行用剩余额度，避免一个 150 个 `def` 的文件把 30 条 TypeError 全挤掉。
 *
 * @param {string} line
 * @param {boolean} readMode
 * @param {readonly string[]|null} focus
 * @returns {0|1|2|3|4}
 */
function tierOf(line, readMode, focus) {
  let tier;
  if (readMode) {
    tier = isStrongLine(line) ? 4 : isSymbolLine(line) ? 3 : 0;
  } else {
    tier = classifyLine(line);
  }
  if (tier < 2 && focus !== null && focusPatternHit(line, focus)) tier = 2;
  return tier;
}

/**
 * 裁剪主函数。
 * @param {string} text
 * @param {TrimParams} params
 * @returns {null | { text: string, meta: {k:number,g:number,w:number,p:number}, bytesAfter: number }}
 *   不需要裁剪（或裁剪收益不足）时返回 null。
 */
export function trimText(text, params) {
  const readMode = params.readMode === true;
  const budgetBytes = params.budgetBytes;
  const eff = budgetBytes;
  const tbytes = blen(text);

  // R3：输入本身已经在预算内 → 没有任何压缩空间，不裁（旧版在 (minBytes, budget] 区间会白裁并丢信息）。
  if (tbytes <= eff) return null;

  const { lines, eol } = splitLines(text);
  const total = lines.length;
  if (total <= 0) return null;

  const headN0 = readMode ? READ_HEAD_LINES : HEAD_LINES;
  const tailN0 = readMode ? READ_TAIL_LINES : TAIL_LINES;

  const spill = (value) =>
    spillOriginal(value, {
      enabled: params.spillEnabled === true,
      dir: typeof params.spillDir === 'string' ? params.spillDir : '',
      days: params.spillDays,
      sessionId: typeof params.sessionId === 'string' ? params.sessionId : '',
      now: params.now,
    });

  // R4：无关键行也要落盘（成本只是磁盘），标记里才能给出回查路径。
  // Read 模式不落盘：源码本身可以用 offset 重新读，落一份全量源码只是重复占用磁盘。
  const spillPath = readMode ? null : spill(text);

  // ---- 少行分支 ----
  let headN = headN0;
  let tailN = tailN0;
  if (total <= headN + tailN + 5) {
    const avg = Math.floor(tbytes / total);
    if (avg > 200 || total <= 3) {
      const short = shortLineBranch(text, { tbytes, eff, total, spillPath, eol });
      const out = finish(short.text, text, eff, short.meta, params);
      if (out === null && spillPath) deleteSpill(spillPath);
      return out;
    }
    headN = Math.max(1, Math.floor((total * 50) / 100));
    tailN = Math.max(1, Math.floor((total * 25) / 100));
  }

  // ---- 分类 ----
  const focus = Array.isArray(params.focusPatterns) ? params.focusPatterns : null;
  const tier = new Uint8Array(total);
  const strongAll = []; // 普通模式 tier3；Read 模式 tier4（真错误，优先级最高）
  const symAll = []; // Read 模式 tier3（符号行）
  const skelAll = [];
  const weakAll = [];
  // R9/P1-6：超大行密集输入只分类「头段 + 尾段 + 中段等距抽样」，避免同步阻塞数秒。
  // silent/行号仍按真实行数计算，只有"关键行是否被看到"降级为抽样。
  const sampleStep =
    total > MAX_CLASSIFY_LINES
      ? Math.ceil((total - headN - tailN) / SAMPLE_CLASSIFY_CAP)
      : 0;
  const tailLo0 = total - tailN;
  for (let i = 0; i < total; i += 1) {
    if (
      sampleStep > 1 &&
      i >= headN &&
      i < tailLo0 &&
      (i - headN) % sampleStep !== 0
    ) {
      continue;
    }
    const t = tierOf(lines[i], readMode, focus);
    tier[i] = t;
    if (t === 4 || (t === 3 && !readMode)) strongAll.push(i);
    else if (t === 3) symAll.push(i);
    else if (t === 2) skelAll.push(i);
    else if (t === 1) weakAll.push(i);
  }
  const strongDetected = strongAll.length;
  const symDetected = symAll.length;
  const skelDetected = skelAll.length;

  // 标记预留：固定部分 + 落盘路径实长（含少量余量），保证组装结果不触发硬切。
  let budget = eff - (MARKER_RESERVE + blen(spillSuffix(spillPath)) + 64);
  if (budget < 500) budget = 500;

  // ---- 分层预算（strong 45% → skeleton 累计 57% → 头段累计 87%）----
  const capStrong = Math.floor((budget * SECTION_STRONG) / 100);
  const capSkel = capStrong + Math.floor((budget * SECTION_SKEL_ADD) / 100);
  const capHead = capSkel + Math.floor((budget * SECTION_HEAD) / 100);

  let used = 0;
  const tailLo = total - tailN;

  // 1) strong：同签名级联「超上限才归并」（O1b）；归并时每组首条（根因）排到候选末尾，
  //    fill_recent 从后往前挑 -> 首因拿到最高填充优先级（O3）。
  //    v2.1：候选不再排除尾段区间的行。以前 `i < tailLo` 会把落在最后 25 行里的错误行
  //    挤出关键行候选，只剩尾段填充一条路——尾段预算不够就整条丢了，违背「错误行优先保留」。
  //    现在它们照常进关键行候选；尾段填充遇到已输出的行会被 `taken` 跳过，不会重复。
  const strongCand = strongAll;
  const dedup = dedupStrong(strongCand, lines, adaptiveCount(capStrong, MAX_STRONG_LINES));
  let strongPrior;
  if (dedup.firsts.size) {
    strongPrior = dedup.kept.filter((i) => !dedup.firsts.has(i));
    strongPrior = strongPrior.concat(Array.from(dedup.firsts).sort((a, b) => a - b));
  } else {
    strongPrior = dedup.kept;
  }
  const pickedS = fillRecent(strongPrior, lines, capStrong, used);
  used = pickedS.used;

  // 1b) Read 模式的符号行：错误行已经先占住 45% 的 strong 份额，符号行只能用
  //     累计 57% 里的剩余空间。这样「一个 150 个 def 的文件」不会把 30 条 TypeError
  //     全挤掉（v2.1 实测：不分开时错误行只留 18/30，符号行留 93/150）。
  let pickedY = { picked: [], used };
  if (readMode && symAll.length) {
    const takenE = new Set(pickedS.picked.map(([i]) => i));
    const symCand = symAll.filter((i) => i < tailLo && !takenE.has(i));
    pickedY = fillRecent(
      pickSpread(symCand, adaptiveCount(capSkel, READ_SYMBOL_MIN_LINES)),
      lines,
      capSkel,
      used,
    );
    used = pickedY.used;
  }

  // 2) skeleton：不与 strong 抢位；条数上限随预算自适应 + 全区间等距取样（F2）
  const takenS = new Set(pickedS.picked.map(([i]) => i));
  for (const [i] of pickedY.picked) takenS.add(i);
  const skelCand = skelAll.filter((i) => i < tailLo && !takenS.has(i));
  const pickedK = fillRecent(
    pickSpread(skelCand, adaptiveCount(capSkel, MAX_SKEL_LINES)),
    lines,
    capSkel,
    used,
  );
  used = pickedK.used;
  const keyPicked = pickedS.picked
    .concat(pickedY.picked)
    .concat(pickedK.picked)
    .sort((a, b) => a[0] - b[0]);
  const taken = new Set(keyPicked.map(([i]) => i));

  // 3) 头段：跳过已作为关键行输出的行，避免重复
  const headIdx = [];
  for (let i = 0; i < headN; i += 1) if (!taken.has(i)) headIdx.push(i);
  let headFilled = fillForwardIdx(headIdx, lines, capHead, used);
  used = headFilled.used;

  // 3b) 尾段至少给「原文最后一行」留出完整空间（P1-7 第二形态）。
  //     尾段名义上只分到剩下的 13%，落盘目录很长时（标记预留被撑大）13% 连一行都放不下，
  //     于是最后一行被截在行中间、尾标记却仍声称「末尾 N 行」。这里从头段尾部回收空间。
  const lastIdx = total - 1;
  if (tailN > 0 && !taken.has(lastIdx)) {
    const lastWant = blen(displayLine(lines[lastIdx]).text) + 1;
    while (headFilled.shown.length > 0 && used + lastWant > budget) {
      const dropped = headFilled.shown.pop();
      used -= blen(dropped) + 1;
      if (used < 0) used = 0;
    }
    headFilled = { shown: headFilled.shown, used };
  }

  // 4) 尾段：同样跳过已输出的行；从尾往前挑、输出保持原序
  const tailIdx = [];
  for (let i = tailLo; i < total; i += 1) if (!taken.has(i)) tailIdx.push(i);
  const tailFilled = fillBackwardIdx(tailIdx, lines, budget, used);

  const shown = new Set(headIdx.slice(0, headFilled.shown.length));
  for (const i of taken) shown.add(i);
  if (tailFilled.shown.length) {
    for (const i of tailIdx.slice(tailIdx.length - tailFilled.shown.length)) shown.add(i);
  }

  let strongShown = 0;
  let skelShown = 0;
  for (const [i] of keyPicked) {
    const t = tier[i];
    if (readMode) {
      if (t === 4) strongShown += 1;
      else if (t === 3 || t === 2) skelShown += 1;
    } else if (t === 3) {
      strongShown += 1;
    } else if (t === 2) {
      skelShown += 1;
    }
  }
  let weakHidden = sampleStep > 1 ? -1 : 0;
  if (weakHidden === 0) {
    for (const i of weakAll) if (!shown.has(i)) weakHidden += 1;
  }

  const shownCount = headFilled.shown.length + keyPicked.length + tailFilled.shown.length;
  const silent = total - shownCount;
  if (silent <= 0) {
    // 没有任何整行被省略（只可能是行内被 MAX_LINE_BYTES 截断）：不出标记，
    // 也不该悄悄吞掉行内容——直接判退化透传。
    if (spillPath) deleteSpill(spillPath);
    return null;
  }

  let rngLo = 0;
  let rngHi = 0;
  let firstOmitted = -1;
  for (let i = 0; i < total; i += 1) {
    if (!shown.has(i)) {
      if (firstOmitted < 0) firstOmitted = i;
      rngHi = i + 1;
    }
  }
  if (firstOmitted < 0) {
    if (spillPath) deleteSpill(spillPath);
    return null;
  }
  rngLo = firstOmitted + 1;

  // P2-1：区间内可能夹着已保留的关键行，标记要说清楚，别让模型按 a..b 推断被删行。
  let inSpan = 0;
  for (const i of shown) {
    if (i >= rngLo - 1 && i <= rngHi - 1) inSpan += 1;
  }

  // ---- 组装 ----
  const meta = {
    k: strongShown,
    g: skelShown,
    w: weakHidden,
    p: spillPath ? 1 : 0,
  };

  const parts = headFilled.shown.slice();
  if (readMode) {
    const readSymbols = pickedY.picked.length;
    const readErrors = pickedS.picked.length;
    if (keyPicked.length) {
      parts.push(
        readMarker({
          silent,
          rngLo,
          rngHi,
          symbolCount: readSymbols,
          errorCount: readErrors,
          keyCount: keyPicked.length,
          kind: 'kept',
          inSpan,
        }),
      );
    } else if (strongDetected || symDetected || skelDetected) {
      parts.push(readMarker({ silent, rngLo, rngHi, kind: 'in_region', inSpan }));
    } else {
      parts.push(readMarker({ silent, rngLo, rngHi, kind: 'none', inSpan }));
    }
  } else if (keyPicked.length) {
    const detail = [];
    if (strongShown) {
      if (strongDetected > strongShown) {
        if (dedup.merged) {
          detail.push(
            `保留 ${strongShown} 条错误行（共检出 ${strongDetected} 条，${dedup.merged} 条同签名已归并）`,
          );
        } else {
          detail.push(`保留 ${strongShown} 条错误行（共检出 ${strongDetected} 条）`);
        }
      } else {
        detail.push(`保留 ${strongShown} 条错误行`);
      }
    }
    if (skelShown) detail.push(`保留 ${skelShown} 条关键值行`);
    if (weakHidden > 0) detail.push(`${weakHidden} 行弱关键词未展开`);
    parts.push(
      keptMarker({
        silent,
        rngLo,
        rngHi,
        detail: detail.join('；'),
        spillPath,
        inSpan,
      }),
    );
  } else if (strongDetected || skelDetected) {
    parts.push(plainMarker({ silent, rngLo, rngHi, kind: 'in_region', spillPath, inSpan }));
  } else {
    parts.push(plainMarker({ silent, rngLo, rngHi, kind: 'none', spillPath, inSpan }));
  }
  for (const [, display] of keyPicked) parts.push(display);
  if (tailFilled.shown.length) {
    parts.push(tailMarker({ shownCount: tailFilled.shown.length, total }));
    parts.push(...tailFilled.shown);
  }

  const out = finish(parts.join(eol), text, eff, meta, params);
  if (out === null && spillPath) deleteSpill(spillPath);
  return out;
}

/**
 * 统一收尾（SPEC §4.6）：退化透传、节省下限、预算硬上界。
 *
 * v2.1：调用方已经按「固定预留 + 落盘路径实长」把内容预算压到 eff 以内，
 * 正常路径不会再触发硬切。万一仍然超（理论上不可达），退化成「不裁」而不是
 * 硬切出与标记自相矛盾的文本（P1-7：标记里的省略字节数必须与真实一致）。
 *
 * @param {string} res
 * @param {string} text
 * @param {number} eff
 * @param {{k:number,g:number,w:number,p:0|1}} meta
 * @param {TrimParams} params
 */
export function finish(res, text, eff, meta, params) {
  const tbytes = blen(text);
  const rlen = blen(res);
  if (rlen >= tbytes) return null; // 退化：不比原文小就透传
  if (rlen > eff) return null; // 预算上界：宁可不动，也不输出与标记矛盾的内容
  const saved = tbytes - rlen;
  const minSaveBytes = Number.isFinite(params.minSaveBytes) ? params.minSaveBytes : MIN_SAVE_BYTES;
  const minSavePercent = Number.isFinite(params.minSavePercent)
    ? params.minSavePercent
    : MIN_SAVE_PCT;
  if (saved < minSaveBytes || saved * 100 < tbytes * minSavePercent) return null;
  return { text: res, meta, bytesAfter: rlen };
}
