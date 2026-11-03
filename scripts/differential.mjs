#!/usr/bin/env node
/**
 * 开发期差分对拍：JS 引擎（lib/engine）↔ Python 参考实现（_dsh_port/reference/trim.py）。
 *
 * 用法：
 *   node scripts/differential.mjs                 # 固定语料 + 220 组随机载荷
 *   node scripts/differential.mjs --count 300     # 更多随机载荷
 *   node scripts/differential.mjs --seed 7        # 换随机种子
 *   node scripts/differential.mjs --update-golden # 重新生成 tests/engine/fixtures/golden.json
 *   node scripts/differential.mjs --fixed-only    # 只跑固定语料
 *
 * 本机沙箱禁止 Node 用 piped stdio 捕获子进程输出（EPERM），所以 Python 侧
 * **从文件读输入、把结果写到文件**，Node 用 `spawnSync(..., {stdio:'ignore'})`，
 * 再读文件比对。CI / 普通机器同样可用。
 *
 * 品牌差异：2.0 标记前缀是 `… [dsh-ctx `，参考实现是 `… [wb-ops `。对拍时把
 * 输入里的新前缀换成旧前缀再喂 Python，再把 Python 输出换回新前缀再比 ——
 * 幂等判定两侧才能落在同一个「行首标记」语义上。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_VERSION, trimToolText } from '../lib/engine/index.js';
import {
  cascadeText,
  chineseLogs,
  codeLines,
  diffText,
  goldenCases,
  jsonPretty,
  jsonSingleLine,
  logLines,
  mixedLines,
  tableLines,
  treeText,
} from '../tests/engine/corpus.js';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PYTHON = 'C:\\Users\\longl\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe';
const DEFAULT_REFERENCE = path.resolve(REPO_ROOT, '..', '_dsh_port', 'reference', 'trim.py');
const GOLDEN_PATH = path.join(REPO_ROOT, 'tests', 'engine', 'fixtures', 'golden.json');

const NEW_NEEDLE = '\u2026 [dsh-ctx ';
const OLD_NEEDLE = '\u2026 [wb-ops ';

// ---- 参考实现的环境变量解析语义（SPEC §2 / §4.1；引擎本身不读 env）----
const BUDGET_MIN = 2000;
const BUDGET_CAP = 131072;
const MIN_BYTES_FLOOR = 500;
const MIN_BYTES_CAP = 131072;
const MIN_BYTES_DEFAULT = 4000;
const DEFAULT_BUDGET = 8000;
const TOOL_BUDGET = { Bash: 4000 };
const TOOL_MIN_BYTES = { Bash: 3000, Grep: 6000, Glob: 6000, WebFetch: 6000, Read: 8000 };
const ENV_WS = ' \t\r\v\f';

function envRaw(env, name) {
  const value = env[name];
  return (typeof value === 'string' ? value : '').replace(
    new RegExp(`^[${ENV_WS}]+|[${ENV_WS}]+$`, 'g'),
    '',
  );
}

function isAsciiDigits(raw) {
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

/** 纯 ASCII 数字才有效；超过 9 位按 value=-1 表示「必然越界」。 */
function parseUint(raw) {
  if (!raw) return { ok: false, value: 0 };
  if (!isAsciiDigits(raw)) return { ok: false, value: 0 };
  if (raw.length > 9) return { ok: true, value: -1 };
  return { ok: true, value: Number(raw) };
}

function resolveBudget(tool, env) {
  const { ok, value } = parseUint(envRaw(env, 'WB_OPS_BUDGET'));
  if (!ok) return TOOL_BUDGET[tool] ?? DEFAULT_BUDGET;
  if (value < 0) return BUDGET_CAP;
  return Math.min(Math.max(value, BUDGET_MIN), BUDGET_CAP);
}

function resolveMinBytes(tool, env) {
  const { ok, value } = parseUint(envRaw(env, 'WB_OPS_MIN_BYTES'));
  if (!ok) return TOOL_MIN_BYTES[tool] ?? MIN_BYTES_DEFAULT;
  if (value === 0) return 0;
  if (value < 0) return MIN_BYTES_CAP;
  return Math.min(Math.max(value, MIN_BYTES_FLOOR), MIN_BYTES_CAP);
}

function envFlag(env, name) {
  return envRaw(env, name) === '1';
}

/** 与 trim.py main() 一致：把参考实现的文件名/长度等 env 解析成引擎 options。 */
function engineOptionsFor(tool, env, spillDir) {
  const readTrim = envFlag(env, 'WB_OPS_READ_TRIM');
  return {
    budgetBytes: resolveBudget(tool, env),
    minBytes: resolveMinBytes(tool, env),
    readMode: tool === 'Read' && readTrim,
    readTrim,
    spillEnabled: envRaw(env, 'WB_OPS_SPILL') !== '0',
    spillDir,
    spillDays: 7,
    sessionId: 'parity',
    minSaveBytes: 300,
    minSavePercent: 4,
  };
}

// ---- Python runner（生成在临时目录；不复制 reference/ 进仓库）----
const RUNNER_PY = String.raw`# -*- coding: utf-8 -*-
"""differential.mjs 生成的临时 runner：喂 stdin、抓 stdout、顺带导出 last-trim.json。"""
import io
import json
import os
import sys
import traceback

trim_py = sys.argv[3]
sys.path.insert(0, os.path.dirname(trim_py))
import trim as T


class _Stdin:
    def __init__(self, data):
        self.buffer = io.BytesIO(data)


def _run():
    payload = open(sys.argv[1], 'rb').read()
    sys.stdin = _Stdin(payload)
    sys.stdout = io.StringIO()
    T.main()
    out = sys.stdout.getvalue()
    sys.stdout = sys.__stdout__
    with open(sys.argv[2], 'w', encoding='utf-8', newline='') as f:
        f.write(out)
    try:
        base = os.environ.get('WB_OPS_STATS_DIR') or ''
        with open(os.path.join(base, 'last-trim.json'), encoding='utf-8') as f:
            rec = json.load(f)
        with open(sys.argv[2] + '.meta.json', 'w', encoding='utf-8') as f:
            json.dump(rec, f, ensure_ascii=False)
    except Exception:
        pass


try:
    _run()
except Exception:
    with open(sys.argv[2] + '.err', 'w', encoding='utf-8') as f:
        f.write(traceback.format_exc())
    raise
`;

function assertReferenceUsable(python, reference) {
  if (!fs.existsSync(python)) {
    throw new Error(
      `找不到 Python 解释器：${python}\n` +
        '用 --python 或 PARITY_PYTHON 指定；没有参考实现时不能伪造对拍结果。',
    );
  }
  if (!fs.existsSync(reference)) {
    throw new Error(
      `找不到参考实现：${reference}\n` +
        '用 --reference 指定（默认 ../_dsh_port/reference/trim.py，不会复制进仓库）。',
    );
  }
}

/** 创建临时工作目录与 runner。 */
function prepareSandbox(python, reference) {
  const tmpRoot = fs.mkdtempSync(path.join(process.env.DSH_PARITY_TMP || os.tmpdir(), 'dsh-parity-'));
  const runner = path.join(tmpRoot, 'runner.py');
  fs.writeFileSync(runner, RUNNER_PY, 'utf8');
  const dataDir = path.join(tmpRoot, 'data');
  const spillDir = path.join(tmpRoot, 'spill');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(spillDir, { recursive: true });
  return { tmpRoot, runner, dataDir, spillDir, reference };
}

function referenceEnv(sandbox, caseEnv) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('WB_OPS_')) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(caseEnv)) env[key] = value;
  env.WB_OPS_SPILL = '0';
  env.WB_OPS_STATS = '0';
  env.WB_OPS_SHADOW = '0';
  env.WB_OPS_STATS_DIR = sandbox.dataDir;
  env.WB_OPS_SPILL_DIR = sandbox.spillDir;
  return env;
}

/**
 * 跑一次 Python 参考实现；返回 { text, reason, meta }。
 * 无输出 → text = null。
 */
function runReference(python, sandbox, tool, text, caseEnv) {
  const inPath = path.join(sandbox.tmpRoot, 'in.json');
  const outPath = path.join(sandbox.tmpRoot, 'out.json');
  const metaPath = `${outPath}.meta.json`;
  const errPath = `${outPath}.err`;
  const lastTrim = path.join(sandbox.dataDir, 'last-trim.json');
  fs.rmSync(outPath, { force: true });
  fs.rmSync(metaPath, { force: true });
  fs.rmSync(errPath, { force: true });
  fs.rmSync(lastTrim, { force: true });

  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: 'parity',
    tool_name: tool,
    tool_input: {},
    tool_response: text,
  });
  fs.writeFileSync(inPath, payload, 'utf8');

  const res = spawnSync(python, [sandbox.runner, inPath, outPath, sandbox.reference], {
    env: referenceEnv(sandbox, caseEnv),
    stdio: 'ignore',
    timeout: 30000,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const detail = fs.existsSync(errPath) ? fs.readFileSync(errPath, 'utf8') : '(无 stderr 文件)';
    throw new Error(`python runner 退出码 ${res.status}\n${detail}`);
  }

  const raw = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  let updated = null;
  if (raw.trim()) {
    const payloadOut = JSON.parse(raw);
    updated = payloadOut?.hookSpecificOutput?.updatedToolOutput ?? null;
  }
  let meta = null;
  if (fs.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
      meta = null;
    }
  }
  return { text: updated, reason: meta?.r ?? null, meta };
}

function toReferenceBrand(s) {
  return s.split(NEW_NEEDLE).join(OLD_NEEDLE);
}

function fromReferenceBrand(s) {
  return s.split(OLD_NEEDLE).join(NEW_NEEDLE);
}

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return n;
}

function describeMismatch(expected, actual) {
  if (expected === null || actual === null) {
    return `expected=${expected === null ? 'null' : 'text'} actual=${actual === null ? 'null' : 'text'}`;
  }
  const idx = firstDifference(expected, actual);
  const from = Math.max(0, idx - 40);
  const expectedChunk = JSON.stringify(expected.slice(from, idx + 40));
  const actualChunk = JSON.stringify(actual.slice(from, idx + 40));
  return (
    `first diff at char ${idx}; expected[${expected.length}B] ${expectedChunk} ` +
    `vs actual[${actual.length}B] ${actualChunk}`
  );
}

/** 对拍时强制关闭落盘/记账/影子模式（与 referenceEnv 保持一致）。 */
function effectiveCaseEnv(caseEnv) {
  return { ...caseEnv, WB_OPS_SPILL: '0', WB_OPS_STATS: '0', WB_OPS_SHADOW: '0' };
}

/** 跑一个用例，返回问题列表（空 = 一致）。 */
function checkCase(python, sandbox, name, tool, text, caseEnv) {
  const referenceText = toReferenceBrand(text);
  const effectiveEnv = effectiveCaseEnv(caseEnv);
  const reference = runReference(python, sandbox, tool, referenceText, effectiveEnv);
  const expectedText = reference.text === null ? null : fromReferenceBrand(reference.text);
  const options = engineOptionsFor(tool, effectiveEnv, sandbox.spillDir);
  let actual;
  try {
    actual = trimToolText({ text, tool }, options);
  } catch (error) {
    return [`${name}: JS 引擎抛异常：${error?.stack ?? error}`];
  }
  const problems = [];
  if (expectedText !== actual.text) {
    problems.push(
      `${name}: 文本不一致 (tool=${tool}) ${describeMismatch(expectedText, actual.text)}`,
    );
  }
  if (reference.reason !== null && reference.reason !== actual.reason) {
    problems.push(`${name}: reason 不一致 python=${reference.reason} js=${actual.reason}`);
  }
  if (reference.reason === 'trim' && actual.text !== null && reference.meta) {
    const pm = reference.meta;
    if (
      pm.k !== actual.meta.k ||
      pm.g !== actual.meta.g ||
      pm.w !== actual.meta.w ||
      (pm.p === 1) !== (actual.meta.p === 1)
    ) {
      problems.push(
        `${name}: meta 不一致 python=${JSON.stringify({ k: pm.k, g: pm.g, w: pm.w, p: pm.p })} ` +
          `js=${JSON.stringify(actual.meta)}`,
      );
    }
  }
  return problems;
}

// ---- 随机语料 ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function randomText(rng) {
  const category = Math.floor(rng() * 20);
  const lines = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  switch (category) {
    case 0:
      return logLines(lines(10, 700), { errs: lines(0, 12) });
    case 1:
      return tableLines(lines(5, 300));
    case 2: {
      const n = lines(20, 400);
      return Array.from(
        { length: n },
        (_, i) => `SERVICE_ENV_${String(i % 90).padStart(3, '0')}=value-${i}-${'x'.repeat(i % 40)}`,
      ).join('\n');
    }
    case 3:
      return diffText(lines(5, 150));
    case 4:
      return jsonPretty(lines(5, 200));
    case 5:
      return jsonSingleLine(lines(20, 2000));
    case 6:
      return chineseLogs(lines(10, 400));
    case 7: {
      // 级联错误：随机根因位置 + 随机级联条数
      const total = lines(150, 800);
      const root = lines(20, total - 60);
      const cascades = lines(5, 150);
      const out = [];
      for (let i = 0; i < total; i += 1) {
        out.push(
          `2026-10-20T12:00:${String(i % 60).padStart(2, '0')}.${String(i % 1000).padStart(3, '0')}Z ` +
            `INFO step=${i} status=running heap=${500 + (i % 64)}MB`,
        );
      }
      out[root] = 'ERROR root cause: upstream DNS resolution failed for payments-db.internal';
      for (let k = 0; k < cascades && root + 1 + k < total; k += 1) {
        out[root + 1 + k] =
          `2026-10-20T12:00:${String(k % 60).padStart(2, '0')}.${String(k % 1000).padStart(3, '0')}Z ` +
          `ERROR [worker-${k % 8}] step=${40 + k} connect failed: ECONNREFUSED 10.0.4.19:5432 retry=${k % 5}/5`;
      }
      return out.join('\n');
    }
    case 8:
      return treeText(lines(5, 120));
    case 9:
      return mixedLines(lines(30, 500));
    case 10:
      return Array.from(
        { length: lines(20, 400) },
        (_, i) => `The rollout for region ${i} proceeds in three waves and drains traffic from zone ${i % 9}.`,
      ).join('\n');
    case 11: {
      const n = lines(2000, 60000);
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789 =,:{}[]"\\';
      let s = '';
      for (let i = 0; i < n; i += 1) s += chars[Math.floor(rng() * chars.length)];
      return s;
    }
    case 12:
      return Array.from(
        { length: lines(100, 140) },
        (_, i) => `row ${i}: ${'z'.repeat(lines(10, 60))}`,
      ).join('\n');
    case 13:
      return codeLines(lines(400, 1200));
    case 14:
      return Array.from(
        { length: lines(100, 500) },
        (_, i) => `line ${i}: crlf content for padding ${'p'.repeat(i % 40)}`,
      ).join('\r\n');
    case 15: {
      // 大量同签名错误（触发 O1b 归并）
      const n = lines(60, 400);
      return Array.from(
        { length: n },
        (_, i) => `ERROR [worker-${i % 8}] step=${i} job=0x${(0x8f2a1c + i).toString(16)} connect failed: ECONNREFUSED 10.0.4.19:5432 retry=${i % 5}/5`,
      ).join('\n');
    }
    case 16: {
      const n = lines(30, 300);
      return Array.from(
        { length: n },
        (_, i) =>
          i % 4 === 0
            ? `commit ${(0x9d1f7c2ab34e + i).toString(16).padStart(13, '0')} artifacts_${i}.bin`
            : `ARTIFACT_SHA_${i}=${(0x9d1f7c2 + i).toString(16)}`,
      ).join('\n');
    }
    case 17: {
      const n = lines(30, 300);
      return Array.from(
        { length: n },
        (_, i) => `visit https://example.com/build/${i}/logs?token=${i} for the artifact manifest`,
      ).join('\n');
    }
    case 18: {
      const n = lines(30, 300);
      return Array.from(
        { length: n },
        (_, i) => `wrote C:\\Users\\dev\\AppData\\Local\\Temp\\artifact_${i}.txt in ${i * 3} ms`,
      ).join('\n');
    }
    default: {
      // 少行分支：几行超长单行
      const n = lines(1, 12);
      return Array.from({ length: n }, (_, i) => `${'w'.repeat(lines(100, 4000))}_${i}`).join('\n');
    }
  }
}

function randomEnv(rng, tool) {
  const env = {};
  const budgetChoices = [
    '2000',
    '3000',
    '4000',
    '6000',
    '8000',
    '10000',
    '12000',
    '20000',
    '30000',
    '60000',
    '131072',
    '0',
    '150000',
    'abc',
    '9999999999',
    ' 8000 ',
  ];
  const minChoices = ['0', '1000', '2000', '3000', '6000', '20000', 'abc', '0', '9999999999'];
  if (rng() < 0.55) env.WB_OPS_BUDGET = pick(rng, budgetChoices);
  if (rng() < 0.4) env.WB_OPS_MIN_BYTES = pick(rng, minChoices);
  if (tool === 'Read') env.WB_OPS_READ_TRIM = rng() < 0.55 ? '1' : '0';
  return env;
}

function randomCorpus(count, seed) {
  const rng = mulberry32(seed);
  const tools = ['Bash', 'Bash', 'Bash', 'Bash', 'Bash', 'Bash', 'Grep', 'Grep', 'Glob', 'WebFetch', 'WebFetch', 'Read'];
  const cases = [];
  for (let i = 0; i < count; i += 1) {
    const tool = pick(rng, tools);
    cases.push({
      name: `random-${String(i).padStart(3, '0')}`,
      tool,
      text: randomText(rng),
      env: randomEnv(rng, tool),
    });
  }
  // 预算/门槛解析的边界组合（文本固定，专门对拍 resolve_* 语义）
  const edgeTexts = [
    ['edge-budget-zero', 'Bash', logLines(300, { errs: 4 }), { WB_OPS_BUDGET: '0' }],
    ['edge-budget-huge', 'Bash', logLines(300, { errs: 4 }), { WB_OPS_BUDGET: '9999999999' }],
    ['edge-budget-invalid', 'Grep', logLines(300, { errs: 4 }), { WB_OPS_BUDGET: '8k' }],
    ['edge-budget-space', 'Bash', logLines(300, { errs: 4 }), { WB_OPS_BUDGET: ' 12000 ' }],
    ['edge-min-zero-budget-8000', 'Bash', logLines(60), { WB_OPS_MIN_BYTES: '0', WB_OPS_BUDGET: '8000' }],
    ['edge-min-invalid', 'Bash', logLines(60), { WB_OPS_MIN_BYTES: 'xx' }],
    ['edge-min-floor', 'Bash', logLines(60), { WB_OPS_MIN_BYTES: '100' }],
    ['edge-min-huge', 'Bash', logLines(300, { errs: 4 }), { WB_OPS_MIN_BYTES: '9999999999' }],
    ['edge-read-off', 'Read', codeLines(900), {}],
    ['edge-read-on', 'Read', codeLines(900), { WB_OPS_READ_TRIM: '1' }],
  ];
  for (const [name, tool, text, env] of edgeTexts) cases.push({ name, tool, text, env });
  return cases;
}

// ---- golden 生成 ----
function updateGolden(python, sandbox) {
  const cases = [];
  const problems = [];
  for (const golden of goldenCases()) {
    const referenceText = toReferenceBrand(golden.text);
    const effectiveEnv = effectiveCaseEnv(golden.env);
    const reference = runReference(python, sandbox, golden.tool, referenceText, effectiveEnv);
    const expectedText = reference.text === null ? null : fromReferenceBrand(reference.text);
    const options = {
      ...engineOptionsFor(golden.tool, effectiveEnv, sandbox.spillDir),
      // fixture 里不写临时目录；落盘在对拍/golden 中是关闭的
      spillDir: '',
      sessionId: 'golden',
    };
    const actual = trimToolText({ text: golden.text, tool: golden.tool }, options);
    if (expectedText !== actual.text) {
      problems.push(`${golden.name}: ${describeMismatch(expectedText, actual.text)}`);
    }
    if (reference.reason !== actual.reason) {
      problems.push(`${golden.name}: reason python=${reference.reason} js=${actual.reason}`);
    }
    const meta = reference.meta
      ? { k: reference.meta.k, g: reference.meta.g, w: reference.meta.w, p: reference.meta.p }
      : { k: 0, g: 0, w: 0, p: 0 };
    cases.push({
      name: golden.name,
      tool: golden.tool,
      options,
      expectedText,
      expectedReason: reference.reason,
      expectedMeta: meta,
    });
  }
  if (problems.length > 0) {
    console.error(`✗ golden 生成失败：${problems.length} 处 JS 与参考实现不一致`);
    for (const p of problems.slice(0, 10)) console.error(`  - ${p}`);
    process.exitCode = 1;
    return { cases: cases.length, problems: problems.length };
  }
  const fixture = {
    meta: {
      source: `reference/trim.py (${path.basename(sandbox.reference)}) via scripts/differential.mjs --update-golden`,
      engineVersion: ENGINE_VERSION,
    },
    cases,
  };
  fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
  fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  console.log(`✓ 写出 ${cases.length} 条 golden 夹具：${path.relative(REPO_ROOT, GOLDEN_PATH)}`);
  return { cases: cases.length, problems: 0 };
}

// ---- CLI ----
function parseArgs(argv) {
  const args = {
    python: process.env.PARITY_PYTHON || DEFAULT_PYTHON,
    reference: process.env.PARITY_REFERENCE || DEFAULT_REFERENCE,
    count: 220,
    seed: 20251103,
    updateGolden: false,
    fixedOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--python') args.python = argv[++i];
    else if (arg === '--reference') args.reference = argv[++i];
    else if (arg === '--count') args.count = Number.parseInt(argv[++i], 10);
    else if (arg === '--seed') args.seed = Number.parseInt(argv[++i], 10);
    else if (arg === '--update-golden') args.updateGolden = true;
    else if (arg === '--fixed-only') args.fixedOnly = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/differential.mjs [--count N] [--seed S] [--update-golden] [--fixed-only] [--python PATH] [--reference PATH]');
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!Number.isFinite(args.count) || args.count < 0) throw new Error('--count 必须是非负整数');
  if (!Number.isFinite(args.seed)) throw new Error('--seed 必须是整数');
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  assertReferenceUsable(args.python, args.reference);
  const sandbox = prepareSandbox(args.python, args.reference);
  let failure = 0;
  try {
    if (args.updateGolden) {
      const result = updateGolden(args.python, sandbox);
      if (result.problems > 0) failure = 1;
      return failure;
    }

    const fixed = goldenCases();
    const random = args.fixedOnly ? [] : randomCorpus(args.count, args.seed);
    const all = fixed.concat(random);
    console.log(
      `对拍 ${all.length} 组（固定 ${fixed.length} + 随机 ${random.length}，seed=${args.seed}）\n` +
        `python: ${args.python}\nreference: ${args.reference}`,
    );
    let mismatches = 0;
    let firstMismatchAt = -1;
    for (let i = 0; i < all.length; i += 1) {
      const c = all[i];
      const problems = checkCase(args.python, sandbox, c.name, c.tool, c.text, c.env);
      if (problems.length > 0) {
        mismatches += 1;
        if (firstMismatchAt < 0) firstMismatchAt = i;
        if (mismatches <= 10) {
          console.error(`✗ ${c.name}`);
          for (const p of problems) console.error(`    ${p}`);
        }
      }
      if ((i + 1) % 25 === 0) console.log(`  ... ${i + 1}/${all.length}，差异 ${mismatches}`);
    }
    console.log(
      `\n结果：${all.length} 组，${mismatches} 组差异` +
        (firstMismatchAt >= 0 ? `（首个差异 index=${firstMismatchAt}）` : ''),
    );
    if (mismatches > 0) {
      failure = 1;
    } else {
      console.log('✓ 逐字节一致');
    }
  } finally {
    try {
      fs.rmSync(sandbox.tmpRoot, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不影响结果 */
    }
  }
  return failure;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`✗ 对拍无法进行：${error?.message ?? error}`);
  process.exitCode = 2;
}
