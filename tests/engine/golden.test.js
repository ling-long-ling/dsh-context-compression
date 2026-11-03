import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { trimToolText } from '../../lib/engine/index.js';
import { goldenCases } from './corpus.js';

/**
 * golden 夹具回归：期望输出由 reference/trim.py 1.1.1 生成（见
 * scripts/differential.mjs --update-golden），输入由 corpus.js 按用例名确定性重建。
 * CI 不需要 Python。
 */
const FIXTURE_URL = new URL('./fixtures/golden.json', import.meta.url);
const FIXTURE = JSON.parse(fs.readFileSync(FIXTURE_URL, 'utf8'));
const CORPUS = goldenCases();

test('golden 夹具：用例集合与 corpus 一致且元数据齐全', () => {
  const fixtureNames = FIXTURE.cases.map((c) => c.name).sort();
  const corpusNames = CORPUS.map((c) => c.name).sort();
  assert.deepEqual(fixtureNames, corpusNames);
  assert.ok(FIXTURE.cases.length >= 30, `cases=${FIXTURE.cases.length}`);
  for (const golden of FIXTURE.cases) {
    assert.ok('expectedText' in golden, golden.name);
    assert.ok(typeof golden.expectedReason === 'string', golden.name);
    assert.equal(golden.options.spillEnabled, false, golden.name);
  }
});

for (const corpusCase of CORPUS) {
  test(`golden: ${corpusCase.name}`, () => {
    const golden = FIXTURE.cases.find((c) => c.name === corpusCase.name);
    assert.ok(golden, `fixture 缺少 ${corpusCase.name}`);
    assert.equal(golden.tool, corpusCase.tool);

    const result = trimToolText(
      { text: corpusCase.text, tool: corpusCase.tool },
      golden.options,
    );
    assert.equal(result.reason, golden.expectedReason);
    assert.equal(result.text, golden.expectedText);
    if (golden.expectedText !== null) {
      assert.deepEqual(result.meta, golden.expectedMeta);
      assert.ok(
        Buffer.byteLength(result.text, 'utf8') <= golden.options.budgetBytes,
        `输出超过预算：${Buffer.byteLength(result.text, 'utf8')} > ${golden.options.budgetBytes}`,
      );
    }
  });
}
