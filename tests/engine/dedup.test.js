import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adaptiveCount,
  dedupStrong,
  pickSpread,
  strongSignature,
} from '../../lib/engine/dedup.js';

test('strongSignature：数字折叠 / 空白折叠 / ASCII 小写（期望值来自参考实现）', () => {
  assert.equal(
    strongSignature('2026-10-20T12:00:01.123Z ERROR [worker-03] step=42 job=0x8f2a1c retry=2/5').toString('hex'),
    '232d232d2374233a233a232e237a206572726f72205b776f726b65722d235d20737465703d23206a6f623d23782366236123632072657472793d232f23',
  );
  assert.equal(
    strongSignature('  Mixed   CASE  \t Values 123 456 ').toString('utf8'),
    'mixed case values # #',
  );
  assert.equal(strongSignature('ERROR x').toString('utf8'), 'error x');
});

test('strongSignature：非 ASCII 原样拷贝、96 字节前缀不 decode、不补 U+FFFD', () => {
  assert.equal(
    strongSignature('\u4e2d\u6587\u9519\u8bef 123 \u53f7').toString('hex'),
    'e4b8ade69687e99499e8afaf202320e58fb7',
  );
  const long = `${'a'.repeat(90)}${'\u4e2d'.repeat(10)}`;
  const sig = strongSignature(long);
  assert.equal(sig.length, 96);
  // 96 字节 = 90 个 'a' + 两个完整「中」；按字节前缀截断，不做 UTF-8 解码
  assert.deepEqual(sig, Buffer.from(`${'a'.repeat(90)}\u4e2d\u4e2d`, 'utf8'));
  // 截断点之后不同的多字节字符 → 不同签名（不能被误并）
  const a = strongSignature(`${'a'.repeat(95)}\u4e2d`);
  const b = strongSignature(`${'a'.repeat(95)}\u6587`);
  assert.notDeepEqual(a, b);
});

test('dedupStrong：未超上限完全不动（8/8 红线）', () => {
  const lines = Array.from({ length: 8 }, (_, i) => `ERROR real failure step=${i + 1}: disk full`);
  const { kept, merged, firsts } = dedupStrong([0, 1, 2, 3, 4, 5, 6, 7], lines, 40);
  assert.deepEqual(kept, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(merged, 0);
  assert.equal(firsts.size, 0);
});

test('dedupStrong：超上限按组配额等距取样（期望值来自参考实现）', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `ERROR step=${i} failed`);
  const { kept, merged, firsts } = dedupStrong(
    Array.from({ length: 100 }, (_, i) => i),
    lines,
    10,
  );
  assert.deepEqual(kept, [0, 11, 22, 33, 44, 55, 66, 77, 88, 99]);
  assert.equal(merged, 90);
  assert.deepEqual([...firsts], [0]);
});

test('dedupStrong：多组按大小分配额，首因集合只含被保留的组首条', () => {
  const lines = [
    ...Array.from({ length: 10 }, (_, i) => `ERROR alpha failure step=${i}`),
    ...Array.from({ length: 90 }, (_, i) => `ERROR beta cascade step=${i + 10}`),
  ];
  const { kept, merged, firsts } = dedupStrong(
    Array.from({ length: 100 }, (_, i) => i),
    lines,
    10,
  );
  assert.deepEqual(kept, [0, 10, 21, 32, 43, 54, 65, 76, 87, 99]);
  assert.equal(merged, 90);
  assert.deepEqual([...firsts].sort((a, b) => a - b), [0, 10]);
});

test('adaptiveCount：基线 / //32 / 硬顶 128（期望值来自参考实现）', () => {
  assert.equal(adaptiveCount(100, 40), 40);
  assert.equal(adaptiveCount(4000, 40), 125);
  assert.equal(adaptiveCount(100000, 24), 128);
  assert.equal(adaptiveCount(0, 24), 24);
});

test('pickSpread：全区间等距取样（期望值来自参考实现）', () => {
  assert.deepEqual(pickSpread(Array.from({ length: 100 }, (_, i) => i), 10), [
    5, 15, 25, 35, 45, 55, 65, 75, 85, 95,
  ]);
  assert.deepEqual(pickSpread([1, 2, 3], 5), [1, 2, 3]);
  assert.deepEqual(pickSpread([], 10), []);
  assert.deepEqual(pickSpread([1, 2, 3], 0), []);
});
