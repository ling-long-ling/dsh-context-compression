/**
 * 引擎单测共用的调用助手：显式传 options（引擎不读环境变量）。
 *
 * 默认预算 / 门槛取自 DSH 插件配置的 v2.1 默认值（lib/config.js）：
 *   budgets  bash 4000 / grep 8000 / glob 8000 / webFetch 8000 / read 8000
 *   minBytes 与 budgets 完全一致（v2.1：门槛不得低于预算，否则触发即白裁）
 *   readTrim 默认 true（v2.1：Read 结果默认纳入裁剪）
 */

import { trimToolText } from '../../lib/engine/index.js';

export const DEFAULT_BUDGETS = Object.freeze({
  Bash: 4000,
  Grep: 8000,
  Glob: 8000,
  WebFetch: 8000,
  Read: 8000,
});

export const DEFAULT_MIN_BYTES = Object.freeze({
  Bash: 4000,
  Grep: 8000,
  Glob: 8000,
  WebFetch: 8000,
  Read: 8000,
});

/**
 * 调一次引擎。
 * @param {string} text
 * @param {string} [tool]
 * @param {object} [overrides]
 */
export function callEngine(text, tool = 'Bash', overrides = {}) {
  // v2.1：readTrim 默认开启，只有显式传 false 才走 read_off。
  const readTrim = overrides.readTrim !== false;
  return trimToolText(
    { text, tool },
    {
      budgetBytes: DEFAULT_BUDGETS[tool] ?? 8000,
      minBytes: DEFAULT_MIN_BYTES[tool] ?? 8000,
      readMode: tool === 'Read',
      readTrim,
      spillEnabled: false,
      spillDir: '',
      spillDays: 7,
      sessionId: 'test-session',
      minSaveBytes: 300,
      minSavePercent: 4,
      ...overrides,
    },
  );
}
