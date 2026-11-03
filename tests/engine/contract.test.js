import test from 'node:test';
import assert from 'node:assert/strict';

import { ENGINE_VERSION, trimToolText } from '../../lib/engine/index.js';
import { hasTrimMarker, MARKER_NEEDLE } from '../../lib/engine/marker.js';
import { callEngine } from './helpers.js';
import { logLines } from './corpus.js';

const NOOP_FIELDS = ['reason', 'text', 'meta', 'bytesBefore', 'bytesAfter'];

test('ENGINE_VERSION 与包版本一致', () => {
  assert.equal(ENGINE_VERSION, '2.0.0');
});

test('返回形状：不裁剪时 text=null、bytesAfter=bytesBefore、meta 全 0', () => {
  const result = callEngine('short output', 'Bash');
  for (const field of NOOP_FIELDS) assert.ok(field in result, field);
  assert.equal(result.text, null);
  assert.equal(result.reason, 'short');
  assert.equal(result.bytesBefore, result.bytesAfter);
  assert.deepEqual(result.meta, { k: 0, g: 0, w: 0, p: 0 });
});

test('返回形状：裁剪时 text 为字符串、bytesAfter 为压缩后字节数', () => {
  const text = logLines(300, { errs: 8 });
  const result = callEngine(text, 'Bash');
  assert.equal(result.reason, 'trim');
  assert.equal(typeof result.text, 'string');
  assert.equal(result.bytesAfter, Buffer.byteLength(result.text, 'utf8'));
  assert.equal(result.bytesBefore, Buffer.byteLength(text, 'utf8'));
});

test('非法输入（text 不是字符串）返回 reason=error 的对象而不是抛异常', () => {
  for (const input of [{ text: 42, tool: 'Bash' }, { text: null, tool: 'Bash' }, {}, null]) {
    const result = trimToolText(input, {});
    assert.equal(result.reason, 'error');
    assert.equal(result.text, null);
    assert.equal(result.bytesBefore, 0);
  }
});

test('P1-3：前 4000 字节出现 <persisted-output> 时透传', () => {
  const big = logLines(400);
  const head = callEngine(`<persisted-output>\n${big}`, 'Bash');
  assert.equal(head.reason, 'persisted');
  assert.equal(head.text, null);
  const embedded = callEngine(`Output too large\n<persisted-output path="x">\n${big}`, 'Bash');
  assert.equal(embedded.reason, 'persisted');
  assert.equal(callEngine(big, 'Bash').reason, 'trim');
});

test('P1-3：<persisted-output> 在第 4000 字节之后不算', () => {
  const prefix = 'a'.repeat(4100);
  const result = callEngine(`${prefix}<persisted-output>\n${logLines(300)}`, 'Bash');
  assert.notEqual(result.reason, 'persisted');
});

test('P1-1：Bash 文本 Exit Code 非 0 整段透传，0 仍裁剪', () => {
  const big = logLines(400);
  assert.equal(callEngine(`${big}\nExit Code: 1`, 'Bash').reason, 'bash_failed');
  assert.equal(callEngine(`${big}\nExit Code: 2`, 'Bash').reason, 'bash_failed');
  assert.equal(callEngine(`${big}\nExit Code: -3`, 'Bash').reason, 'bash_failed');
  assert.equal(callEngine(`${big}\nExit Code: 0`, 'Bash').reason, 'trim');
  // 非 Bash 工具不看 Exit Code
  assert.equal(callEngine(`${big}\nExit Code: 2`, 'Grep').reason, 'trim');
});

test('F6 幂等：只认行首的新品牌标记；正文裸子串与旧品牌不算', () => {
  const markerLine = '\u2026 [dsh-ctx \u7701\u7565 100 \u884c\uff08\u7b2c 1\u2013100 \u884c\uff09] \u2026';
  assert.equal(hasTrimMarker(markerLine), true);
  assert.equal(hasTrimMarker(`line 0\n${markerLine}\nline 2`), true);
  assert.equal(hasTrimMarker(`prefix ${markerLine}`), false);
  assert.equal(hasTrimMarker('\u2026 [wb-ops \u7701\u7565 100 \u884c]'), false, '旧品牌 v2 不认');

  const text = ['line 0', markerLine, ...Array.from({ length: 300 }, (_, i) => `line ${i + 2}: content`)].join('\n');
  const result = callEngine(text, 'Bash');
  assert.equal(result.reason, 'idem');
  assert.equal(result.text, null);
});

test('F6：正文里的裸 [dsh-ctx 子串仍会裁剪', () => {
  const lines = logLines(300, { errs: 4 }).split('\n');
  lines[60] = 'shell line 61: payload includes bare \u2026 [dsh-ctx token] substring';
  const result = callEngine(lines.join('\n'), 'Bash');
  assert.equal(result.reason, 'trim');
});

test('品牌：标记 needle 的 UTF-8 字节序列固定为 DESIGN §7 的 dsh-ctx 版本', () => {
  assert.equal(MARKER_NEEDLE, '\u2026 [dsh-ctx ');
  assert.equal(
    Buffer.from(MARKER_NEEDLE, 'utf8').toString('hex'),
    'e280a6205b6473682d63747820',
  );
  const result = callEngine(logLines(520, { errs: 4 }), 'Bash');
  assert.equal(result.reason, 'trim');
  assert.equal(result.text.includes('wb-ops'), false);
  assert.equal(result.text.includes('[dsh-ctx '), true);
});

test('Read 未开裁剪且正文含行首标记 -> read_off（不是 idem）', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i}: some source code here for padding`);
  lines[100] = '\u2026 [dsh-ctx \u7701\u7565 100 \u884c\uff08\u7b2c 1\u2013100 \u884c\uff09] \u2026';
  const result = callEngine(lines.join('\n'), 'Read', { readTrim: false });
  assert.equal(result.reason, 'read_off');
});

test('异常兜底：内部抛错时返回 reason=error 且不向调用方抛出', () => {
  const options = {
    budgetBytes: 4000,
    minBytes: 3000,
    readMode: false,
    get spillEnabled() {
      throw new Error('boom');
    },
    spillDir: '',
    spillDays: 7,
    sessionId: 'x',
  };
  const result = trimToolText({ text: logLines(300, { errs: 4 }), tool: 'Bash' }, options);
  assert.equal(result.reason, 'error');
  assert.equal(result.text, null);
});
