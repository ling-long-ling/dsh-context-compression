import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { blen } from '../../lib/engine/bytes.js';
import { callEngine } from './helpers.js';
import { logLines, mixedLines } from './corpus.js';

/** 10KB 输入：普通日志（分类谓词全量扫描的实际工作负载）。 */
const LOG_10K = logLines(90);
/** 10KB 输入：混合 KEY=VALUE / URL / 路径 / hex / JSON 键（最重的骨架扫描）。 */
const MIXED_10K = mixedLines(210);

function measure(text) {
  const options = { budgetBytes: 8000, minBytes: 0 };
  // 预热（JIT + 缓冲区分配）
  for (let i = 0; i < 5; i += 1) callEngine(text, 'Bash', options);
  const durations = [];
  for (let i = 0; i < 30; i += 1) {
    const start = performance.now();
    callEngine(text, 'Bash', options);
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  return {
    median: durations[Math.floor(durations.length / 2)],
    p95: durations[Math.floor(durations.length * 0.95)],
    max: durations[durations.length - 1],
  };
}

test('性能：10KB 输入单次裁剪 ≤ 30ms（日志）', () => {
  assert.ok(blen(LOG_10K) >= 9000 && blen(LOG_10K) <= 12000, `size=${blen(LOG_10K)}`);
  const stats = measure(LOG_10K);
  assert.ok(stats.median <= 30, `median=${stats.median.toFixed(2)}ms`);
  assert.ok(stats.max <= 30, `max=${stats.max.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms`);
});

test('性能：10KB 输入单次裁剪 ≤ 30ms（骨架行最重路径）', () => {
  assert.ok(blen(MIXED_10K) >= 9000 && blen(MIXED_10K) <= 13000, `size=${blen(MIXED_10K)}`);
  const stats = measure(MIXED_10K);
  assert.ok(stats.median <= 30, `median=${stats.median.toFixed(2)}ms`);
  assert.ok(stats.max <= 30, `max=${stats.max.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms`);
});
