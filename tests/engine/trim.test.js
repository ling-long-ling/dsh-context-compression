import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { blen } from '../../lib/engine/bytes.js';
import { callEngine } from './helpers.js';
import {
  cascadeText,
  chineseLogs,
  codeLines,
  eightDistinctErrors,
  jsonSingleLine,
  logLines,
  urls240,
} from './corpus.js';

/**
 * 造一个「长但跨平台可写」的 spill 目录：总长约 200 字符。
 *
 * 3b 场景需要一个把标记预留撑大的落盘路径；但路径也不能长到碰 Windows
 * MAX_PATH（CI 的 windows-latest 不一定开长路径支持），所以按 tmpdir 长度
 * 反向补足到 ~200 字符、分成两层子目录。spill 文件完整路径约 227 字符。
 * @param {string} tag - 目录标签（避免同文件内两个用例互相干扰）。
 * @returns {string} 绝对目录路径。
 */
function longSpillDir(tag) {
  const base = os.tmpdir();
  const top = `dsh-3b-${tag}-${'x'.repeat(80)}`;
  const rest = Math.max(20, 200 - base.length - top.length - 2);
  return path.join(base, top, 'y'.repeat(rest));
}

/**
 * 复刻 ipconfig 形态（恰好 3,256 字节，MAC 地址在中后段、第 41 行）。
 *
 * 对齐评测报告 P1-3 的实测样本（bench/raw/ipconfig.txt = 3,256 B），但不依赖
 * 仓库外的文件：内容按固定规则生成，任何机器上逐字节一致。
 * @returns {string} 恰好 3,256 字节的 ipconfig 风格输出。
 */
function ipconfigText() {
  const lines = [
    'Windows IP Configuration',
    '',
    'Ethernet adapter Ethernet:',
    '',
    '   Connection-specific DNS Suffix  . : corp.example.internal',
    '   Description . . . . . . . . . . . : Intel(R) Ethernet Connection I219-V',
    '   DHCP Enabled. . . . . . . . . . . : Yes',
    '   IPv4 Address. . . . . . . . . . . : 10.0.4.19',
    '   Subnet Mask . . . . . . . . . . . : 255.255.255.0',
    '   Default Gateway . . . . . . . . . : 10.0.4.1',
  ];
  const lease = (i) =>
    `   Lease Obtained. . . . . . . . . . : 2026-10-${String(20 + (i % 9)).padStart(2, '0')}T12:00:${String(i % 60).padStart(2, '0')}Z`;
  while (lines.length < 40) lines.push(lease(lines.length));
  lines.push('   Physical Address. . . . . . . . . : A0-AD-9F-9A-03-C8');
  while (blen(lines.join('\n')) < 3256 - 60) lines.push(lease(lines.length));
  let text = lines.join('\n');
  text += ' '.repeat(3256 - blen(text));
  return text;
}

/**
 * 少行分支的字节账：从输出反算「省略 N 字节」应等于 tbytes - 前段原文 - 尾段。
 * （头段里的「单行过长已截断」标注是插件加的字，不属于原文，要扣掉。）
 * @param {string} text
 * @param {{text: string}} result
 */
function shortBranchAccounting(text, result) {
  const out = result.text;
  const headEnd = out.indexOf('\n\u2026 [dsh-ctx \u7701\u7565 ');
  assert.ok(headEnd >= 0, out.slice(0, 200));
  const markerEnd = out.indexOf('] \u2026\n', headEnd);
  assert.ok(markerEnd >= 0, out.slice(headEnd, headEnd + 200));
  const head = out.slice(0, headEnd);
  const tail = out.slice(markerEnd + '] \u2026\n'.length);
  const omitted = Number(/\u7701\u7565 (\d+) \u5b57\u8282/.exec(out)[1]);
  const noteAt = head.lastIndexOf('\u2026\uff08\u5355\u884c\u8fc7\u957f\u5df2\u622a\u65ad');
  const headOriginal = noteAt >= 0 ? head.slice(0, noteAt) : head;
  return { omitted, expected: blen(text) - blen(headOriginal) - blen(tail) };
}

test('普通模式：超预算触发，输出 ≤ 预算，标记为 dsh-ctx', () => {
  const text = logLines(300, { errs: 8 });
  const result = callEngine(text, 'Bash');
  assert.equal(result.reason, 'trim');
  assert.ok(result.text !== null);
  assert.ok(blen(result.text) <= 4000, `out=${blen(result.text)}`);
  assert.ok(result.bytesBefore > result.bytesAfter);
  assert.ok(result.text.includes('\u2026 [dsh-ctx 省略 '), '标记前缀');
  assert.ok(result.text.includes('] \u2026'), '标记尾');
  assert.equal(result.meta.k, 8);
  assert.equal(result.meta.p, 0);
});

test('触发门槛解耦：60 行 6–7KB Bash 输出被裁到 ≤ 4400B', () => {
  const text = logLines(60);
  const bytes = blen(text);
  assert.ok(bytes >= 5000 && bytes <= 8000, `input=${bytes}`);
  const result = callEngine(text, 'Bash');
  assert.equal(result.reason, 'trim');
  assert.ok(blen(result.text) <= 4400, `out=${blen(result.text)}`);
});

test('不触发：低于预算/门槛/行数时返回 text=null 与 reason=short', () => {
  const text = Array.from({ length: 119 }, (_, i) => `row ${i}`).join('\n');
  const result = callEngine(text, 'Bash');
  assert.equal(result.reason, 'short');
  assert.equal(result.text, null);
  assert.equal(result.bytesAfter, result.bytesBefore);
  assert.deepEqual(result.meta, { k: 0, g: 0, w: 0, p: 0 });
});

test('v2.1 触发：行数触发已取消——预算充足时 5000 行也不裁', () => {
  const text = Array.from({ length: 5000 }, (_, i) => `row ${i}`).join('\n');
  const result = callEngine(text, 'Bash', { budgetBytes: 131072, minBytes: 0 });
  assert.equal(result.reason, 'short');
  assert.equal(result.text, null);
});

test('v2.1 R3：3,256 字节 ipconfig、预算 4000 不裁（MAC 等关键行不丢）', () => {
  const text = ipconfigText();
  assert.equal(blen(text), 3256);
  assert.ok(text.includes('A0-AD-9F-9A-03-C8'), '样本本身含 MAC');

  const result = callEngine(text, 'Bash');
  assert.equal(result.reason, 'short', '输入已在预算内，没有任何压缩空间');
  assert.equal(result.text, null);
  assert.equal(result.bytesAfter, result.bytesBefore);

  // 预算收紧到 2000 时确实会裁，且 MAC 行作为关键值行被保留（分类器 v2.1 新增 MAC 规则）
  const tight = callEngine(text, 'Bash', { budgetBytes: 2000, minBytes: 2000 });
  assert.equal(tight.reason, 'trim');
  assert.ok(tight.text.includes('A0-AD-9F-9A-03-C8'), 'MAC 行必须保留');
  assert.ok(tight.meta.g >= 1);
  assert.ok(tight.text.includes('关键值行'), tight.text.slice(0, 400));
});

test('Read 模式：readTrim=false 返回 read_off；默认 true 裁并报符号行', () => {
  const text = codeLines(900);
  const off = callEngine(text, 'Read', { readTrim: false });
  assert.equal(off.reason, 'read_off');
  assert.equal(off.text, null);

  // v2.1：Read 默认纳入裁剪，触发改按字节预算
  const on = callEngine(text, 'Read');
  assert.equal(on.reason, 'trim');
  assert.ok(on.text.includes('符号行'), 'Read 标记');
  assert.ok(blen(on.text) <= 8000);
  // Read 语义：无错误行时 meta.k=0，符号行计入 meta.g
  assert.equal(on.meta.k, 0, '无错误行时 meta.k=0');
  assert.ok(on.meta.g > 0, '符号行计入 meta.g');
});

test('v2.1 R2：Read 默认下 900 行日志的 TypeError/Traceback 保留并报错误行数', () => {
  const lines = Array.from(
    { length: 900 },
    (_, i) => `2026-11-01T00:00:${String(i % 60).padStart(2, '0')}Z step=${i} status=running heap=${i % 64}MB`,
  );
  lines[390] = "TypeError: Cannot read properties of undefined (reading 'id')";
  lines[450] = 'Traceback (most recent call last):';
  const result = callEngine(lines.join('\n'), 'Read');
  assert.equal(result.reason, 'trim');
  assert.ok(result.text.includes('TypeError: Cannot read'), '错误行必须保留');
  assert.ok(result.text.includes('Traceback (most recent call last):'), 'Traceback 必须保留');
  // Read 语义：meta.k 只数错误行，meta.g 只数符号行
  assert.equal(result.meta.k, 2);
  assert.equal(result.meta.g, 0);
  assert.match(result.text, /保留 2 条错误行/);
  assert.ok(blen(result.text) <= 8000);
});

test('v2.1 P1-2：Read 标记条数 = meta.g（符号行）/ meta.k（错误行）', () => {
  const lines = codeLines(900).split('\n');
  lines[2500] = 'TypeError: boom';
  lines[2520] = 'Traceback (most recent call last):';
  const result = callEngine(lines.join('\n'), 'Read');
  assert.equal(result.reason, 'trim');
  const match = /保留 (\d+) 条符号行、(\d+) 条错误行/.exec(result.text);
  assert.ok(match, result.text.slice(0, 400));
  const symbols = Number(match[1]);
  const errors = Number(match[2]);
  // 行为调整：Read 两档语义 —— 错误行 tier4 计入 meta.k，符号行 tier3 计入 meta.g
  assert.equal(errors, result.meta.k, '错误行数计入 meta.k');
  assert.equal(symbols, result.meta.g, '符号行数计入 meta.g');
  assert.equal(errors, 2);
  assert.ok(symbols > 0);
});

test('行为调整：尾段区间里的错误行不再被挤出关键行候选（普通 + Read）', () => {
  // change 1：以前 strong 候选固定 `i < tailLo`，落在最后 25 行里的错误行
  // 只剩尾段填充一条路，尾段预算不够就整条丢。现在它们照常参与关键行挑选。
  const plain = Array.from({ length: 300 }, (_, i) => `plain ${i} line content about rollout waves`);
  plain[288] = 'ERROR root cause: upstream dns failed for payments-db.internal';
  const bash = callEngine(plain.join('\n'), 'Bash', { budgetBytes: 2000, minBytes: 2000 });
  assert.equal(bash.reason, 'trim');
  assert.equal(bash.meta.k, 1);
  assert.ok(bash.text.includes('root cause'), '普通模式尾段错误行必须作为关键行保留');

  const src = Array.from({ length: 400 }, (_, i) => `line ${i}: plain source padding text here`);
  src[370] = 'TypeError: cannot read id of undefined';
  const read = callEngine(src.join('\n'), 'Read', { budgetBytes: 2000, minBytes: 2000 });
  assert.equal(read.reason, 'trim');
  assert.equal(read.meta.k, 1);
  assert.ok(read.text.includes('TypeError'), 'Read 模式尾段错误行必须保留');
});

test('行为调整：Read 错误行先占 45% 额度，符号行仍拿大头（150 符号 + 30 错误）', () => {
  // change 2：错误行（tier4）先用 capStrong，符号行（tier3）用 capSkel 剩余额度。
  // 以前两档混在一个 strong 候选池里按 capStrong 截断，符号行会把错误行挤掉。
  const lines = Array.from({ length: 600 }, (_, i) => `line ${i}: plain source padding text here`);
  for (let i = 0; i < 150; i += 1) lines[i * 2] = `def symbol_${i}(a, b):`;
  for (let i = 0; i < 30; i += 1) lines[300 + i] = `TypeError: failure ${i}: cannot read property`;
  const result = callEngine(lines.join('\n'), 'Read', { budgetBytes: 8000, minBytes: 8000 });
  assert.equal(result.reason, 'trim');
  assert.equal(result.meta.k, 30, '30 条错误行必须全保留');
  assert.ok(result.meta.g >= 100, `符号行只保留了 ${result.meta.g} 条`);
  assert.equal((result.text.match(/TypeError: failure/g) || []).length, 30);
  const match = /保留 (\d+) 条符号行、(\d+) 条错误行/.exec(result.text);
  assert.ok(match, result.text.slice(0, 400));
  assert.equal(Number(match[1]), result.meta.g, '标记里的符号行数 = meta.g');
  assert.equal(Number(match[2]), result.meta.k, '标记里的错误行数 = meta.k');
});

test('少行分支：单行超长 JSON 截断并带标注、不超预算、优先截在 JSON 边界', () => {
  const text = jsonSingleLine(1500);
  const result = callEngine(text, 'Bash');
  assert.equal(result.reason, 'trim');
  const out = result.text;
  assert.ok(blen(out) <= 4000, `out=${blen(out)}`);
  assert.ok(out.includes('\u5355\u884c\u8fc7\u957f\u5df2\u622a\u65ad'), '截断标注');
  const head = out.split('\u2026\uff08\u5355\u884c\u8fc7\u957f\u5df2\u622a\u65ad')[0];
  assert.ok([',', '}', ']', '"'].includes(head.slice(-1)), JSON.stringify(head.slice(-30)));
  assert.equal(result.meta.k, 0);
  assert.equal(result.meta.g, 0);
});

test('少行分支：total<=3 时标记带「单行过长已截断，原文 N 字节」', () => {
  const text = Array.from({ length: 3 }, (_, i) => `${'y'.repeat(1400)}_${i}`).join('\n');
  const result = callEngine(text, 'Bash');
  assert.equal(result.reason, 'trim');
  assert.ok(result.text.includes('\u5355\u884c\u8fc7\u957f\u5df2\u622a\u65ad'), result.text);
  assert.ok(result.text.includes(`\u539f\u6587 ${blen(text)} \u5b57\u8282`));
});

test('v2.1 P1-7：少行分支「省略 N 字节」= tbytes - 前段原文 - 尾段', () => {
  const samples = [
    Array.from({ length: 20 }, (_, i) => `PAYLOAD_${String(i).padStart(2, '0')}=${'x'.repeat(280)}`).join('\n'),
    Array.from({ length: 3 }, (_, i) => `${'y'.repeat(1400)}_${i}`).join('\n'),
    `${'z'.repeat(6000)}_end`,
  ];
  for (const text of samples) {
    const result = callEngine(text, 'Bash');
    assert.equal(result.reason, 'trim', `in=${blen(text)}`);
    const { omitted, expected } = shortBranchAccounting(text, result);
    assert.equal(omitted, expected, `省略字节失真：marker=${omitted} 实算=${expected}`);
    assert.ok(blen(result.text) <= 4000, `out=${blen(result.text)}`);
  }
});

test('3b：长 spill 目录下尾段仍完整保留最后一行（不截断、尾标记行号真实）', () => {
  const spillDir = longSpillDir('tail');
  try {
    // 3b 场景：落盘路径很长 → 标记预留被撑大 → 尾段名义预算连最后一行都放不下。
    // 旧行为：fillBackwardIdx 会把最后一行截在行中间（尾标记却仍声称「末尾 N 行」）。
    // 新行为：3b 从头段尾部回收预算，保证原文最后一行完整留在输出里。
    const lastLine = `FINAL_LAST_LINE ${'z'.repeat(160)} END_OF_OUTPUT`;
    const lines = Array.from({ length: 99 }, (_, i) => `plain line ${i} ${'q'.repeat(20)}`);
    lines.push(lastLine);
    const text = lines.join('\n');
    const result = callEngine(text, 'Bash', {
      budgetBytes: 2000,
      minBytes: 2000,
      spillEnabled: true,
      spillDir,
      sessionId: '3b-session',
    });
    assert.equal(result.reason, 'trim');
    assert.ok(blen(result.text) <= 2000, `out=${blen(result.text)}`);
    assert.equal(result.meta.p, 1, '长目录必须真的落盘（标记预留才会被撑大）');
    assert.ok(result.text.includes('可 Grep 回查'));
    assert.ok(result.text.includes(spillDir), '标记里带超长深目录的原文路径');
    assert.ok(result.text.includes(lastLine), '原文最后一行必须完整出现（旧行为会截在中途）');
    const tail = /以下为原文末尾 (\d+) 行（第 (\d+)–(\d+) 行）/.exec(result.text);
    assert.ok(tail, result.text);
    const shown = Number(tail[1]);
    const lo = Number(tail[2]);
    const hi = Number(tail[3]);
    assert.equal(hi, lines.length, '尾标记 hi 必须等于真实行数');
    assert.equal(lo, lines.length - shown + 1, '尾标记 lo/hi 与 shown 自洽');
  } finally {
    try {
      fs.rmSync(path.dirname(spillDir), { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不影响判定 */
    }
  }
});

test('3b 同参数：单行超长时「省略 N 字节」按长目录标记实长与输出反算一致', () => {
  const spillDir = longSpillDir('single');
  try {
    const text = `SINGLE_${'w'.repeat(6990)}_END`;
    const result = callEngine(text, 'Bash', {
      budgetBytes: 2000,
      minBytes: 2000,
      spillEnabled: true,
      spillDir,
      sessionId: '3b-single',
    });
    assert.equal(result.reason, 'trim');
    assert.ok(blen(result.text) <= 2000, `out=${blen(result.text)}`);
    assert.equal(result.meta.p, 1, '长目录必须真的落盘');
    assert.ok(result.text.includes('可 Grep 回查'));
    const { omitted, expected } = shortBranchAccounting(text, result);
    assert.equal(omitted, expected, `省略字节失真：marker=${omitted} 实算=${expected}`);
    assert.ok(omitted > 5000);
  } finally {
    try {
      fs.rmSync(path.dirname(spillDir), { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不影响判定 */
    }
  }
});

test('v2.1 P1-8：200 行以 \\n 结尾 → 尾标记「第 176–200 行」（不再 +1）', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `row ${i}: payload padding text here`);
  for (const text of [lines.join('\n') + '\n', lines.join('\n')]) {
    const result = callEngine(text, 'Bash');
    assert.equal(result.reason, 'trim');
    assert.ok(result.text.includes('\u7b2c 176\u2013200 \u884c'), result.text);
    assert.equal(result.text.includes('\u7b2c 176\u2013201 \u884c'), false, '行号不能被末尾换行 +1');
  }
});

test('v2.1 P2-9：CRLF 输入 → 输出统一 CRLF，行号一致', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `row ${i}: payload padding text here`);
  const result = callEngine(lines.join('\r\n') + '\r\n', 'Bash');
  assert.equal(result.reason, 'trim');
  assert.ok(result.text.includes('\u7b2c 176\u2013200 \u884c'), result.text);
  assert.ok(result.text.includes('\r\n'), '输出必须是 CRLF');
  assert.equal(/\n/.test(result.text.replace(/\r\n/g, '')), false, '不能混入裸 LF');
});

test('v2.1 P2-1：区间夹着已保留关键行时标记说明「该区间内另有 N 行已保留在上/下文」', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `plain ${i} line content about rollout waves`);
  lines[150] = 'ERROR root cause: upstream dns failed for payments-db.internal';
  const result = callEngine(lines.join('\n'), 'Bash');
  assert.equal(result.reason, 'trim');
  assert.equal(result.meta.k, 1);
  assert.ok(result.text.includes('\u8be5\u533a\u95f4\u5185\u53e6\u6709 1 \u884c'), result.text);
  assert.ok(result.text.includes('\u4fdd\u7559 1 \u6761\u9519\u8bef\u884c'));
});

test('v2.1 R9/P1-6：26 万行密集输入仍裁剪，输出 ≤ 预算且标记行号自洽', () => {
  const total = 260000;
  const lines = new Array(total);
  for (let i = 0; i < total; i += 1) lines[i] = `l${i}`;
  const result = callEngine(lines.join('\n'), 'Bash');
  assert.equal(result.reason, 'trim');
  assert.ok(blen(result.text) <= 4000, `out=${blen(result.text)}`);
  // 中段抽样分类时弱关键词计数未知（v2.1: meta.w = -1）
  assert.equal(result.meta.w, -1);
  assert.equal(result.meta.k, 0);
  const shownLines = result.text.split('\n').filter((line) => /^l\d+$/.test(line));
  assert.equal(shownLines.length, 75, 'HEAD_LINES 50 + TAIL_LINES 25');
  const silent = Number(/\u7701\u7565 (\d+) \u884c/.exec(result.text)[1]);
  assert.equal(silent + shownLines.length, total, 'silent 必须是真实未显示行数');
  // 行号自洽：首段后第一行省略、末段前最后一行省略
  assert.ok(result.text.includes('\u7b2c 51\u2013259975 \u884c'), result.text);
  assert.ok(result.text.includes('\u4ee5\u4e0b\u4e3a\u539f\u6587\u672b\u5c3e 25 \u884c\uff08\u7b2c 259976\u2013260000 \u884c\uff09'));
});

test('F2：200 行 KEY=VALUE 保留 >24 条且覆盖全文', () => {
  const text = Array.from(
    { length: 200 },
    (_, i) => `ENVKEY_${String(i).padStart(3, '0')}=some_demo_value_${String(i).padStart(3, '0')}_padding_xx`,
  ).join('\n');
  const result = callEngine(text, 'Bash', { budgetBytes: 8000 });
  assert.equal(result.reason, 'trim');
  const out = result.text;
  assert.ok(out.includes('ENVKEY_010='), '头段关键值');
  assert.ok(out.includes('ENVKEY_120='), '中段关键值');
  // 关键行区 = 头段标记之后、尾段标记之前
  const lines = out.split('\n');
  const keyStart = lines.findIndex((line) => line.startsWith('\u2026 [dsh-ctx \u7701\u7565'));
  const tailStart = lines.findIndex((line) => line.startsWith('\u2026 [dsh-ctx \u4ee5\u4e0b'));
  assert.ok(keyStart >= 0);
  const keyLines = lines
    .slice(keyStart + 1, tailStart < 0 ? undefined : tailStart)
    .filter((line) => line.startsWith('ENVKEY_'));
  assert.ok(keyLines.length > 24, `keyLines=${keyLines.length}`);
  assert.equal(keyLines.length, result.meta.g);
  const firstIndex = Number(keyLines[0].slice(7, 10));
  assert.ok(firstIndex <= 100, `firstIndex=${firstIndex}`);
});

test('O1b/O3：级联错误超上限归并后根因仍在，并报告同签名归并', () => {
  const text = cascadeText();
  const result = callEngine(text, 'Bash');
  assert.equal(result.reason, 'trim');
  assert.ok(result.text.includes('root cause'), '根因必须保留');
  assert.ok(result.text.includes('\u540c\u7b7e\u540d\u5df2\u5f52\u5e76'), '归并文案');
});

test('O1b 红线：8 条不同 step 的真错误 8/8 保留（未超上限不归并）', () => {
  const text = eightDistinctErrors();
  const result = callEngine(text, 'Bash');
  assert.equal(result.reason, 'trim');
  assert.equal(result.text.split('disk full').length - 1, 8);
});

test('v2.1 F1：预算轴单调不减，且预算覆盖输入时直接不裁（R3）', () => {
  const text = urls240();
  assert.ok(blen(text) > 20_000, `input=${blen(text)}`);
  const a = callEngine(text, 'Bash', { budgetBytes: 16_000 });
  const b = callEngine(text, 'Bash', { budgetBytes: 20_000 });
  assert.equal(a.reason, 'trim');
  assert.equal(b.reason, 'trim');
  assert.ok(blen(a.text) <= 16_000);
  assert.ok(blen(b.text) <= 20_000);
  assert.ok(blen(b.text) >= blen(a.text), `${blen(a.text)} vs ${blen(b.text)}`);
  const huge = callEngine(text, 'Bash', { budgetBytes: 131072, minBytes: 0 });
  assert.equal(huge.reason, 'short');
  assert.equal(huge.text, null);
});

test('meta.w：未展开的弱关键词行计数（weak 行不进输出）', () => {
  const lines = [];
  for (let i = 0; i < 200; i += 1) {
    lines.push(
      i % 4 === 0
        ? `warningLevel: 3, // weak line ${i} padding padding`
        : `data row ${i} status=running padding padding padding`,
    );
  }
  const text = lines.join('\n');
  const result = callEngine(text, 'Bash');
  assert.equal(result.reason, 'trim');
  assert.ok(result.meta.w > 0, `meta.w=${result.meta.w}`);
  assert.ok(result.bytesAfter < result.bytesBefore);
});

test('中文日志：被裁剪、标记完整、错误行保留', () => {
  const text = chineseLogs(300);
  const result = callEngine(text, 'Bash');
  assert.equal(result.reason, 'trim');
  assert.ok(result.text.includes('\u7701\u7565'), '中文标记');
  assert.ok(result.text.includes('\u9519\u8bef'), '中文错误行');
  assert.ok(result.meta.k > 0);
});

test('收益不足 MIN_SAVE_BYTES 时不裁', () => {
  const text = logLines(300, { errs: 8 });
  const normal = callEngine(text, 'Bash');
  assert.equal(normal.reason, 'trim');
  const noGain = callEngine(text, 'Bash', { minSaveBytes: 1e9 });
  assert.equal(noGain.text, null);
  assert.equal(noGain.reason, 'short');
});

test('尾段标记：保留原文末尾若干行', () => {
  const text = logLines(300);
  const result = callEngine(text, 'Bash');
  assert.ok(result.text.includes('\u2026 [dsh-ctx \u4ee5\u4e0b\u4e3a\u539f\u6587\u672b\u5c3e '));
  assert.ok(
    result.text.endsWith(
      '2026-10-20T12:04:59.299Z INFO  [worker-03] step=299 job=008f2b47 status=running elapsed=110.6s queue=3 heap=555MB',
    ),
  );
});
