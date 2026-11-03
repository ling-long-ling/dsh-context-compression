import test from 'node:test';
import assert from 'node:assert/strict';

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

test('按行数触发：minBytes=0、预算很大时，>120 行仍触发', () => {
  const text = Array.from({ length: 121 }, (_, i) => `row ${i} ${'q'.repeat(100)}`).join('\n');
  const result = callEngine(text, 'Bash', { budgetBytes: 131072, minBytes: 0 });
  assert.equal(result.reason, 'trim');
  assert.ok(result.text !== null);
});

test('Read 模式：未开 readTrim 返回 read_off；开了才裁并报符号行', () => {
  const text = codeLines(900);
  const off = callEngine(text, 'Read', { readTrim: false });
  assert.equal(off.reason, 'read_off');
  assert.equal(off.text, null);

  const on = callEngine(text, 'Read', { readTrim: true, minBytes: 0 });
  assert.equal(on.reason, 'trim');
  assert.ok(on.text.includes('\u4fdd\u7559') && on.text.includes('\u7b26\u53f7\u884c'), 'Read 标记');
  assert.ok(blen(on.text) <= 8000);
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

test('F1：预算轴单调不减', () => {
  const text = urls240();
  const a = callEngine(text, 'Bash', { budgetBytes: 20000 });
  const b = callEngine(text, 'Bash', { budgetBytes: 24000 });
  assert.equal(a.reason, 'trim');
  assert.equal(b.reason, 'trim');
  assert.ok(blen(a.text) <= 20000);
  assert.ok(blen(b.text) <= 24000);
  assert.ok(blen(b.text) >= blen(a.text), `${blen(a.text)} vs ${blen(b.text)}`);
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
  const text = Array.from({ length: 121 }, (_, i) => `row ${i}`).join('\n');
  const result = callEngine(text, 'Bash', { minBytes: 0, budgetBytes: 131072 });
  assert.equal(result.text, null);
  assert.equal(result.reason, 'short');
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
