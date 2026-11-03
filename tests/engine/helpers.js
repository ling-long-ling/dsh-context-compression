/**
 * 引擎单测共用的调用助手：显式传 options（引擎不读环境变量）。
 *
 * 默认预算 / 门槛取自 DSH 插件配置的默认值（DESIGN §4）：
 *   budgets  bash 4000 / grep 8000 / glob 8000 / webFetch 8000 / read 8000
 *   minBytes bash 3000 / grep 6000 / glob 6000 / webFetch 6000 / read 8000
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
  Bash: 3000,
  Grep: 6000,
  Glob: 6000,
  WebFetch: 6000,
  Read: 8000,
});

/**
 * 调一次引擎。
 * @param {string} text
 * @param {string} [tool]
 * @param {object} [overrides]
 */
export function callEngine(text, tool = 'Bash', overrides = {}) {
  const readTrim = overrides.readTrim === true;
  return trimToolText(
    { text, tool },
    {
      budgetBytes: DEFAULT_BUDGETS[tool] ?? 8000,
      minBytes: DEFAULT_MIN_BYTES[tool] ?? 4000,
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
