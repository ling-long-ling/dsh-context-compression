import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { ENGINE_VERSION, trimToolText } from '../../lib/engine/index.js';
import { goldenCases } from './corpus.js';

/**
 * golden 夹具回归：v2.1 自观测回归基线（不再是 Python 对拍）。
 *
 * 期望输出由 `scripts/update-golden.mjs` 用当前 `lib/engine` 生成：它读本目录
 * `corpus.js` 的 `goldenCases()`，把用例的 env 覆盖项翻译成 `lib/config.js` 的
 * 配置后调用 `trimToolText()`，把 expectedText / expectedMeta / expectedReason
 * 写回 `fixtures/golden.json`。输入由 corpus.js 按用例名确定性重建，CI 不需要
 * Python；任何引擎行为变化都会在这组固定输入上暴露成文本差异。
 */
const FIXTURE_URL = new URL('./fixtures/golden.json', import.meta.url);
const FIXTURE = JSON.parse(fs.readFileSync(FIXTURE_URL, 'utf8'));
const CORPUS = goldenCases();

test('golden 夹具：v2.1 自观测基线，用例集合与 corpus 一致且元数据齐全', () => {
  const fixtureNames = FIXTURE.cases.map((c) => c.name).sort();
  const corpusNames = CORPUS.map((c) => c.name).sort();
  assert.deepEqual(fixtureNames, corpusNames);
  assert.ok(FIXTURE.cases.length >= 30, `cases=${FIXTURE.cases.length}`);
  assert.equal(FIXTURE.meta.engineVersion, ENGINE_VERSION, '夹具必须由当前引擎版本生成');
  assert.match(FIXTURE.meta.source, /自观测|update-golden/, '夹具来源标注');
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
