import test from 'node:test';
import assert from 'node:assert/strict';

import {
  blen,
  jsonSafePrefix,
  normalizeLoneSurrogates,
  u8Prefix,
  u8Suffix,
} from '../../lib/engine/bytes.js';

test('blen 按 UTF-8 字节计数', () => {
  assert.equal(blen(''), 0);
  assert.equal(blen('abc'), 3);
  assert.equal(blen('中文'), 6);
  assert.equal(blen('\u{1F600}'), 4);
  assert.equal(blen('a\u4e2d'), 4);
});

test('u8Prefix 落在 UTF-8 字符边界', () => {
  assert.equal(u8Prefix('中a', 2), '');
  assert.equal(u8Prefix('中a', 3), '中');
  assert.equal(u8Prefix('中a', 4), '中a');
  assert.equal(u8Prefix('中a', 10), '中a');
});

test('u8Suffix 落在 UTF-8 字符边界', () => {
  assert.equal(u8Suffix('a中', 2), '');
  assert.equal(u8Suffix('a中', 3), '中');
  assert.equal(u8Suffix('a中', 4), 'a中');
  assert.equal(u8Suffix('a中', 10), 'a中');
});

test('jsonSafePrefix 总是不超过 limit 字节（limit≥3；limit<3 按参考实现退化为 …）', () => {
  const s = JSON.stringify({
    data: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item-${i}`, state: i % 2 ? 'up' : 'down' })),
  });
  for (const limit of [3, 10, 17, 50, 100, 1000, 4000]) {
    const out = jsonSafePrefix(s, limit);
    assert.ok(blen(out) <= limit, `limit=${limit} got ${blen(out)}`);
  }
  assert.equal(jsonSafePrefix(s, 0), '\u2026');
  assert.equal(jsonSafePrefix('short', 100), 'short');
});

test('jsonSafePrefix 与参考实现逐字节一致（无标注空间时退化为纯 …）', () => {
  // 期望值由 reference/trim.py 1.1.1 生成
  assert.equal(
    jsonSafePrefix('{"alpha": 1, "beta": 2, "gamma": 3}', 20),
    '{"alpha": 1, "bet\u2026',
  );
  assert.equal(jsonSafePrefix('hello world this is a long line', 15), 'hello world \u2026');
  assert.equal(jsonSafePrefix('x'.repeat(40), 0), '\u2026');
  assert.equal(jsonSafePrefix('', 0), '');
});

test('jsonSafePrefix 优先截在 JSON 结构边界并补标注（期望值来自参考实现）', () => {
  const s = `{"msg":"${'a'.repeat(300)}","id":123}`;
  const out = jsonSafePrefix(s, 200);
  assert.equal(out, '{"msg":"\u2026\uff08\u5355\u884c\u8fc7\u957f\u5df2\u622a\u65ad\uff0c\u539f\u6587 319 \u5b57\u8282\uff09');
  assert.equal(blen(out), 58);
  // 截断点是结构字符 '"'（JSON 边界），不是任意字节
  assert.equal(out.split('\u2026\uff08')[0].slice(-1), '"');
});

test('normalizeLoneSurrogates 与 Python surrogatepass+replace 一致（每个孤立代理项 3 个 U+FFFD）', () => {
  assert.equal(normalizeLoneSurrogates('abc'), 'abc');
  assert.equal(normalizeLoneSurrogates('\ud800abc'), '\ufffd\ufffd\ufffdabc');
  assert.equal(
    normalizeLoneSurrogates('\ud83d\ude00'),
    '\ud83d\ude00', // 合法代理对原样保留
  );
  // 两个孤立代理项（JSON 里常见）各变 3 个替换符
  assert.equal(normalizeLoneSurrogates('\ud83d\ude00\ud800'), '\ud83d\ude00\ufffd\ufffd\ufffd');
});
