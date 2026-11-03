/**
 * 分层裁剪算法主体（SPEC-1.1.1 §4）—— trim.py 的 `trim()` / `finish()` 逐条移植。
 *
 * 输出结构：开头行 → [省略标记] → 保留的关键行 → [末尾标记] → 结尾行
 *
 * 本模块假设调用方已完成 main() 的前置判定（persisted / read_off / bash_failed / idem），
 * 并把预算、门槛、开关都解析成参数传进来（引擎不读环境变量）。
 */

import {
  HEAD_LINES,
  MARKER_RESERVE,
  MAX_LINES,
  MAX_SKEL_LINES,
  MAX_STRONG_LINES,
  MIN_SAVE_BYTES,
  MIN_SAVE_PCT,
  READ_HEAD_LINES,
  READ_MIN_LINES,
  READ_TAIL_LINES,
  SECTION_HEAD,
  SECTION_SKEL_ADD,
  SECTION_STRONG,
  TAIL_LINES,
} from './constants.js';
import { blen, jsonSafePrefix, u8Suffix } from './bytes.js';
import { classifyLine, isSymbolLine } from './classify.js';
import { adaptiveCount, dedupStrong, pickSpread } from './dedup.js';
import { fillBackwardIdx, fillForwardIdx, fillRecent } from './display.js';
import {
  keptMarker,
  plainMarker,
  readMarker,
  shortLineMarker,
  tailMarker,
} from './marker.js';
import { spillOriginal } from './spill.js';

/**
 * @typedef {object} TrimParams
 * @property {string} tool - 规范化工具类（仅用于日志语义，判定已在 main 层）
 * @property {boolean} readMode - Read 裁剪模式
 * @property {number} budgetBytes - 已解析的字节预算（触发后的目标恒为它）
 * @property {number} minBytes - 已解析的触发门槛；0 = 关闭按门槛触发
 * @property {boolean} spillEnabled
 * @property {string} spillDir
 * @property {number} spillDays
 * @property {string} sessionId
 * @property {number} [minSaveBytes]
 * @property {number} [minSavePercent]
 * @property {() => number} [now]
 */

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
  const minBytes = readMode ? 0 : params.minBytes;
  const headN0 = readMode ? READ_HEAD_LINES : HEAD_LINES;
  const tailN0 = readMode ? READ_TAIL_LINES : TAIL_LINES;

  const lines = text.split('\n');
  const total = lines.length;
  const tbytes = blen(text);

  const spill = (value) =>
    spillOriginal(value, {
      enabled: params.spillEnabled === true,
      dir: typeof params.spillDir === 'string' ? params.spillDir : '',
      days: params.spillDays,
      sessionId: typeof params.sessionId === 'string' ? params.sessionId : '',
      now: params.now,
    });

  // ---- 触发条件（O2：门槛与目标分离）----
  let eff;
  if (readMode) {
    if (total <= READ_MIN_LINES || tbytes <= budgetBytes) return null;
    eff = budgetBytes;
  } else {
    // 一旦触发，目标恒为预算；eff 对输入规模单调（修 F1 预算反转）
    eff = -1;
    if (tbytes > budgetBytes) eff = budgetBytes;
    else if (minBytes > 0 && tbytes > minBytes) eff = budgetBytes;
    else if (total > MAX_LINES) eff = budgetBytes;
    if (eff < 0) return null;
  }

  // ---- 少行分支 ----
  let headN = headN0;
  let tailN = tailN0;
  if (total <= headN + tailN + 5) {
    const avg = Math.floor(tbytes / (total > 0 ? total : 1));
    if (avg > 200 || total <= 3) {
      const lh = Math.floor((eff * 5) / 8);
      const lt = Math.floor((eff * 3) / 10);
      const head = jsonSafePrefix(text, lh);
      const tail = u8Suffix(text, lt);
      const omitted = tbytes - blen(head) - blen(tail);
      const spillPath = spill(text);
      const marker = shortLineMarker({
        omitted,
        tbytes,
        singleLineOversize: total <= 3,
        spillPath,
      });
      return finish(head + marker + tail, text, eff, { k: 0, g: 0, w: 0, p: spillPath ? 1 : 0 }, params);
    }
    headN = Math.max(1, Math.floor((total * 50) / 100));
    tailN = Math.max(1, Math.floor((total * 25) / 100));
  }

  // ---- 分类 ----
  const tier = new Array(total);
  if (readMode) {
    for (let i = 0; i < total; i += 1) tier[i] = isSymbolLine(lines[i]) ? 3 : 0;
  } else {
    for (let i = 0; i < total; i += 1) tier[i] = classifyLine(lines[i]);
  }
  const strongAll = [];
  const skelAll = [];
  const weakAll = [];
  for (let i = 0; i < total; i += 1) {
    if (tier[i] === 3) strongAll.push(i);
    else if (tier[i] === 2) skelAll.push(i);
    else if (tier[i] === 1) weakAll.push(i);
  }
  const strongDetected = strongAll.length;
  const skelDetected = skelAll.length;

  let budget = eff - MARKER_RESERVE;
  if (budget < 500) budget = 500;

  // ---- 分层预算（strong 45% → skeleton 累计 57% → 头段累计 87%）----
  const capStrong = Math.floor((budget * SECTION_STRONG) / 100);
  const capSkel = capStrong + Math.floor((budget * SECTION_SKEL_ADD) / 100);
  const capHead = capSkel + Math.floor((budget * SECTION_HEAD) / 100);

  let used = 0;
  const tailLo = total - tailN;

  // 1) strong：同签名级联「超上限才归并」（O1b）；归并时每组首条（根因）排到候选末尾，
  //    fill_recent 从后往前挑 -> 首因拿到最高填充优先级（O3）。
  const strongCand = strongAll.filter((i) => i < tailLo);
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

  // 2) skeleton：不与 strong 抢位；条数上限随预算自适应 + 全区间等距取样（F2）
  const takenS = new Set(pickedS.picked.map(([i]) => i));
  const skelCand = skelAll.filter((i) => i < tailLo && !takenS.has(i));
  const pickedK = fillRecent(
    pickSpread(skelCand, adaptiveCount(capSkel, MAX_SKEL_LINES)),
    lines,
    capSkel,
    used,
  );
  used = pickedK.used;
  const keyPicked = pickedS.picked.concat(pickedK.picked).sort((a, b) => a[0] - b[0]);
  const taken = new Set(keyPicked.map(([i]) => i));

  // 3) 头段：跳过已作为关键行输出的行，避免重复
  const headIdx = [];
  for (let i = 0; i < headN; i += 1) if (!taken.has(i)) headIdx.push(i);
  const headFilled = fillForwardIdx(headIdx, lines, capHead, used);
  used = headFilled.used;

  // 4) 尾段：同样跳过已输出的行；从尾往前挑、输出保持原序
  const tailIdx = [];
  for (let i = tailLo; i < total; i += 1) if (!taken.has(i)) tailIdx.push(i);
  const tailFilled = fillBackwardIdx(tailIdx, lines, budget, used);

  const shown = new Set(headIdx.slice(0, headFilled.shown.length));
  for (const i of taken) shown.add(i);
  if (tailFilled.shown.length) {
    for (const i of tailIdx.slice(tailIdx.length - tailFilled.shown.length)) shown.add(i);
  }

  const strongShown = keyPicked.filter(([i]) => tier[i] === 3).length;
  const skelShown = keyPicked.filter(([i]) => tier[i] === 2).length;
  let weakHidden = 0;
  for (const i of weakAll) if (!shown.has(i)) weakHidden += 1;

  const shownCount = headFilled.shown.length + keyPicked.length + tailFilled.shown.length;
  const silent = total - shownCount;

  let rngLo = 0;
  let rngHi = 0;
  let firstOmitted = -1;
  for (let i = 0; i < total; i += 1) {
    if (!shown.has(i)) {
      if (firstOmitted < 0) firstOmitted = i;
      rngHi = i + 1;
    }
  }
  if (firstOmitted >= 0) rngLo = firstOmitted + 1;

  // ---- 落盘 + 组装 ----
  const spillPath = keyPicked.length && !readMode ? spill(text) : null;
  const meta = {
    k: strongShown,
    g: skelShown,
    w: weakHidden,
    p: spillPath ? 1 : 0,
  };

  const parts = headFilled.shown.slice();
  if (readMode) {
    if (keyPicked.length) {
      parts.push(
        readMarker({
          silent,
          rngLo,
          rngHi,
          symbolCount: keyPicked.length,
          kind: 'kept',
        }),
      );
    } else if (strongDetected) {
      parts.push(readMarker({ silent, rngLo, rngHi, kind: 'in_region' }));
    } else {
      parts.push(readMarker({ silent, rngLo, rngHi, kind: 'none' }));
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
    if (weakHidden) detail.push(`${weakHidden} 行弱关键词未展开`);
    parts.push(
      keptMarker({ silent, rngLo, rngHi, detail: detail.join('；'), spillPath }),
    );
  } else if (strongDetected || skelDetected) {
    parts.push(plainMarker({ silent, rngLo, rngHi, kind: 'in_region' }));
  } else {
    parts.push(plainMarker({ silent, rngLo, rngHi, kind: 'none' }));
  }
  for (const [, display] of keyPicked) parts.push(display);
  if (tailFilled.shown.length) {
    parts.push(tailMarker({ shownCount: tailFilled.shown.length, total }));
    parts.push(...tailFilled.shown);
  }

  const res = parts.join('\n');
  return finish(res, text, eff, meta, params);
}

/**
 * 统一收尾（SPEC §4.6）：退化透传、节省下限、硬上界。
 * @param {string} res
 * @param {string} text
 * @param {number} eff
 * @param {{k:number,g:number,w:number,p:number}} meta
 * @param {TrimParams} params
 */
export function finish(res, text, eff, meta, params) {
  const tbytes = blen(text);
  const rlen = blen(res);
  if (rlen >= tbytes) return null; // 退化：不比原文小就透传
  const saved = tbytes - rlen;
  const minSaveBytes = Number.isFinite(params.minSaveBytes) ? params.minSaveBytes : MIN_SAVE_BYTES;
  const minSavePercent = Number.isFinite(params.minSavePercent)
    ? params.minSavePercent
    : MIN_SAVE_PCT;
  if (saved < minSaveBytes || saved * 100 < tbytes * minSavePercent) return null;
  let out = res;
  if (rlen > eff) out = jsonSafePrefix(out, eff);
  return { text: out, meta, bytesAfter: blen(out) };
}
