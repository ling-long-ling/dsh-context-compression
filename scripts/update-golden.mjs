#!/usr/bin/env node
/**
 * v2.1 golden 夹具生成器（自观测回归基线）。
 *
 * 用法：
 *   node scripts/update-golden.mjs
 *
 * 读 `tests/engine/corpus.js` 的 `goldenCases()`，用当前 `lib/engine`（在固定
 * options 上）生成 expectedText / expectedMeta / expectedReason，写回
 * `tests/engine/fixtures/golden.json`。
 *
 * v2.1 起 golden 不再调用 Python 参考实现：它是「引擎自观测基线」——冻结当前
 * 行为，任何后续改动都会在同样的确定性输入上暴露成文本差异。输入由 corpus.js
 * 按用例名重建，因此 CI 只需要 Node。
 *
 * 用例 env 里的 `WB_OPS_*` 键是历史命名，这里翻译成 `lib/config.js` 的配置再走
 * `lib/mapping.js` 的 `engineOptions()`：
 *   WB_OPS_BUDGET     -> budgets[<tool>]
 *   WB_OPS_MIN_BYTES  -> minBytes[<tool>]（resolveConfig 会把它抬到 >= 预算）
 *   WB_OPS_READ_TRIM  -> readTrim（'1' = true，其它 = false；缺省用 v2.1 默认 true）
 *
 * 生成前会自检三条不变量：同一输入两次运行逐字节一致、裁剪输出不超过预算、
 * fixture 关闭落盘（否则夹具会带上机器相关的临时路径）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveConfig } from '../lib/config.js';
import { ENGINE_VERSION, trimToolText } from '../lib/engine/index.js';
import { configKey, engineOptions } from '../lib/mapping.js';
import { goldenCases } from '../tests/engine/corpus.js';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GOLDEN_PATH = path.join(REPO_ROOT, 'tests', 'engine', 'fixtures', 'golden.json');

/**
 * 读取用例 env 里的非负整数覆盖项。
 * @param {Record<string, string>} env
 * @param {string} name
 * @returns {number|undefined}
 */
function envInteger(env, name) {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`golden 用例覆盖项 ${name} 不是非负整数："${raw}"`);
  }
  return value;
}

/**
 * 把用例 env 翻译成插件配置，再解析成引擎 options。
 * @param {{tool: string, env?: Record<string, string>}} corpusCase
 * @returns {object} trimToolText 的 options。
 */
function optionsFor(corpusCase) {
  const env = corpusCase.env ?? {};
  const key = configKey(corpusCase.tool);
  const raw = { spill: { enabled: false } };

  const budget = envInteger(env, 'WB_OPS_BUDGET');
  if (budget !== undefined) raw.budgets = { [key]: budget };
  const minBytes = envInteger(env, 'WB_OPS_MIN_BYTES');
  if (minBytes !== undefined) raw.minBytes = { [key]: minBytes };
  if (env.WB_OPS_READ_TRIM !== undefined) raw.readTrim = env.WB_OPS_READ_TRIM === '1';

  const config = resolveConfig(raw);
  const options = engineOptions(config, corpusCase.tool, 'golden');
  // 夹具必须与机器无关：落盘关闭后 spillDir 不参与运算，但仍要置空避免路径入库。
  options.spillDir = '';
  return options;
}

/**
 * 用当前引擎生成整个夹具，并自检不变量。
 * @returns {{fixture: object, problems: string[]}}
 */
function buildFixture() {
  const cases = [];
  const problems = [];
  for (const corpusCase of goldenCases()) {
    const options = optionsFor(corpusCase);
    const first = trimToolText({ text: corpusCase.text, tool: corpusCase.tool }, options);
    const second = trimToolText({ text: corpusCase.text, tool: corpusCase.tool }, options);

    if (first.text !== second.text || first.reason !== second.reason) {
      problems.push(`${corpusCase.name}: 同一输入两次运行结果不一致（非确定性）`);
    }
    if (options.spillEnabled !== false) {
      problems.push(`${corpusCase.name}: golden 夹具必须关闭落盘`);
    }
    if (first.text !== null) {
      const outBytes = Buffer.byteLength(first.text, 'utf8');
      if (outBytes > options.budgetBytes) {
        problems.push(`${corpusCase.name}: 输出 ${outBytes}B 超过预算 ${options.budgetBytes}B`);
      }
    }
    cases.push({
      name: corpusCase.name,
      tool: corpusCase.tool,
      options,
      expectedText: first.text,
      expectedReason: first.reason,
      expectedMeta: { ...first.meta },
    });
  }
  const fixture = {
    meta: {
      source:
        'v2.1 自观测基线：lib/engine 直接生成，不再对拍 Python（scripts/update-golden.mjs）',
      engineVersion: ENGINE_VERSION,
    },
    cases,
  };
  return { fixture, problems };
}

function main() {
  const { fixture, problems } = buildFixture();
  if (problems.length > 0) {
    console.error(`✗ golden 生成失败：${problems.length} 处问题`);
    for (const problem of problems.slice(0, 10)) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
  fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  const trimmed = fixture.cases.filter((item) => item.expectedText !== null).length;
  console.log(
    `✓ 写出 ${fixture.cases.length} 条 golden 夹具` +
      `（${trimmed} 条裁剪 / ${fixture.cases.length - trimmed} 条不裁）→ ` +
      path.relative(REPO_ROOT, GOLDEN_PATH),
  );
}

try {
  main();
} catch (error) {
  console.error(`✗ golden 生成无法完成：${error?.stack ?? error}`);
  process.exitCode = 2;
}
