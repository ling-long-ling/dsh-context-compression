/**
 * 确定性语料（golden 回归 + 开发期差分对拍共用）。
 *
 * 只用字符串拼接与整数运算生成内容，保证任何机器、任何 Node 版本上
 * 得到逐字节一致的输入；golden 夹具只存「Python 参考实现生成的期望输出」，
 * 输入由本模块按用例名重建，因此仓库里不需要塞几十 KB 的原文。
 *
 * 注意：2.0 的标记前缀是 `… [dsh-ctx `；差分脚本会在喂给 Python 参考实现前
 * 把新品牌替换成旧的 `… [wb-ops `，再把期望输出换回新品牌（见 differential.mjs）。
 */

function pad(n, width) {
  return String(n).padStart(width, '0');
}

function hex8(n) {
  return (n >>> 0).toString(16).padStart(8, '0');
}

/**
 * 参考 acceptance.py 的 log_lines()：n 行日志，errs 条 ERROR 行，needles 覆盖指定行。
 * @param {number} n
 * @param {{ errs?: number, needles?: Array<[number, string]> }} [opts]
 * @returns {string}
 */
export function logLines(n, opts = {}) {
  const errs = opts.errs ?? 0;
  const needles = opts.needles ?? [];
  const out = [];
  let e = errs;
  for (let i = 0; i < n; i += 1) {
    if (e > 0 && i % Math.max(1, Math.floor(n / Math.max(1, errs))) === 7) {
      e -= 1;
      out.push(
        `2026-10-20T12:${pad(Math.floor(i / 60) % 60, 2)}:${pad(i % 60, 2)}.${pad(i % 1000, 3)}Z ` +
          `ERROR [worker-${pad(i % 8, 2)}] step=${i} job=${hex8(0x8f2a1c + i)} ` +
          `connect failed: ECONNREFUSED 10.0.4.19:5432 retry=${i % 5}/5`,
      );
    } else {
      out.push(
        `2026-10-20T12:${pad(Math.floor(i / 60) % 60, 2)}:${pad(i % 60, 2)}.${pad(i % 1000, 3)}Z ` +
          `INFO  [worker-${pad(i % 8, 2)}] step=${i} job=${hex8(0x8f2a1c + i)} ` +
          `status=running elapsed=${(i * 0.37).toFixed(1)}s queue=${i % 4} heap=${512 + (i % 64)}MB`,
      );
    }
  }
  for (const [pos, txt] of needles) out[pos] = txt;
  return out.join('\n');
}

/** docker ps 风格表格（12 位 hex ID）。 */
export function tableLines(n) {
  const out = ['CONTAINER ID   IMAGE                    STATUS          PORTS                    NAMES'];
  for (let i = 0; i < n; i += 1) {
    out.push(
      `| ${hex8(0x9d1f7c2a + i)} | payments/api:${pad(i % 40, 2)} | Up ${(i % 72) + 1} hours | 0.0.0.0:${8000 + (i % 100)}->8080/tcp | prod-api-${pad(i % 24, 2)} |`,
    );
  }
  return out.join('\n');
}

/** 统一 diff 片段。 */
export function diffText(n) {
  const out = ['diff --git a/src/app.js b/src/app.js', '--- a/src/app.js', '+++ b/src/app.js'];
  for (let i = 0; i < n; i += 1) {
    out.push(`@@ -${i + 1},3 +${i + 1},4 @@ function handler_${i}(req) {`);
    out.push(`-  const value = old_value_${i};`);
    out.push(`+  const value = new_value_${i};`);
    out.push(`+  audit(\`changed field \${i}\`, 200);`);
  }
  return out.join('\n');
}

/** 多行 pretty JSON。 */
export function jsonPretty(n) {
  const items = [];
  for (let i = 0; i < n; i += 1) {
    items.push(
      `    {\n      "id": ${i},\n      "name": "item-${i}",\n      "state": "${i % 3 === 0 ? 'running' : 'stopped'}",\n      "port": ${8000 + (i % 500)}\n    }`,
    );
  }
  return `{\n  "items": [\n${items.join(',\n')}\n  ],\n  "total": ${n}\n}`;
}

/** 单行 JSON（触发超长单行分支）。 */
export function jsonSingleLine(n) {
  const items = [];
  for (let i = 0; i < n; i += 1) items.push(`{"id":${i},"name":"item-${i}"}`);
  return `{"data":[${items.join(',')}],"total":${n}}`;
}

/** 中文日志（错误关键词 + 中文标记保真）。 */
export function chineseLogs(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(
      `2026-10-20 第 ${i} 行：数据库连接超时，正在重试（错误：连接被拒绝，第 ${i % 7} 次）`,
    );
  }
  return out.join('\n');
}

/** tree 命令风格输出。 */
export function treeText(n) {
  const out = ['project/', '├── src/', '│   ├── index.js', '│   └── util.js'];
  for (let i = 0; i < n; i += 1) {
    const dir = `module_${pad(i % 18, 2)}`;
    out.push(`├── ${dir}/`);
    out.push(`│   ├── handler_${i}.js`);
    out.push(`│   ├── handler_${i}.test.js`);
    out.push(`│   └── fixtures/`);
    out.push(`└── docs/README_${i}.md`);
  }
  return out.join('\n');
}

/** 混合 KEY=VALUE / URL / 路径 / hex / JSON 键 / 弱关键词 / 普通行。 */
export function mixedLines(n) {
  const pool = [
    (i) => `ENV_KEY_${pad(i % 100, 3)}=value_${pad(i, 3)}_padding_text`,
    (i) => `DB_REPLICA_${pad(i % 12, 2)}_URL=postgresql://ops:secret@db-${i % 9}.internal:5432/main`,
    (i) => `wrote C:\\Users\\dev\\AppData\\Local\\Temp\\artifact_${i}.txt in ${i} ms`,
    (i) => `loading config from /etc/app/conf.d/site_${i}.conf`,
    (i) => `commit ${(0x9d1f7c2ab34e + i).toString(16).padStart(13, '0')}`,
    (i) => `  "model_${i}": "gpt",`,
    (i) => `warning: retry budget exhausted at attempt ${i} (timeout_ms=${i})`,
    (i) => `failover candidate ${i} promoted; cannot_parse=false`,
    (i) => `2026-10-20T12:00:00Z INFO step=${i} status=running elapsed=${(i * 0.37).toFixed(1)}s`,
    (i) => `visit https://example.com/build/${i}/logs for details`,
    (i) => `| ${pad(i, 3)} | fast | 200 |`,
    (i) => `plain prose line ${i}: the rollout proceeds in waves across zones.`,
    (i) => `ERROR real failure step=${i}: disk full on /dev/sda1`,
  ];
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(pool[i % pool.length](i));
  return out.join('\n');
}

/** 函数/类/import 代码（Read 模式符号行）。 */
export function codeLines(funcs) {
  const out = ['import os', 'import sys', ''];
  for (let i = 0; i < funcs; i += 1) {
    out.push(`def func_${i}(a, b):`);
    out.push(`    return a + b  # ${i}`);
    out.push('');
  }
  out.push('class Service:', '    def run(self):', '        return None');
  return out.join('\n');
}

/** 621 行级联：第 151 行是根因，其后 120 条同签名级联 ERROR。 */
export function cascadeText() {
  const lines = [];
  for (let i = 0; i < 621; i += 1) {
    lines.push(
      `2026-10-20T12:00:${pad(i % 60, 2)}.${pad(i % 1000, 3)}Z INFO  [worker-${pad(i % 8, 2)}] ` +
        `step=${i} job=${hex8(0x8f2a1c + i)} status=running queue=${i % 4} heap=${512 + (i % 64)}MB`,
    );
  }
  lines[150] = 'ERROR root cause: upstream DNS resolution failed for payments-db.internal';
  for (let k = 0; k < 120; k += 1) {
    lines[151 + k] =
      `2026-10-20T12:00:${pad(k % 60, 2)}.${pad(k % 1000, 3)}Z ERROR [worker-${pad(k % 8, 2)}] ` +
      `step=${40 + k} job=${hex8(0x8f2a1c + k)} connect failed: ECONNREFUSED 10.0.4.19:5432 retry=${k % 5}/5`;
  }
  return lines.join('\n');
}

/** 240 条 postgres URL（F1 预算轴样本，约 22.4KB）。 */
export function urls240() {
  return Array.from(
    { length: 240 },
    (_, i) =>
      `DATABASE_REPLICA_${pad(i, 3)}_URL=postgresql://ops_user:secret@db-replica-${pad(i % 12, 2)}.internal:5432/ledger_main`,
  ).join('\n');
}

/** 400 行日志里埋 8 条「不同 step」的真错误（同签名红线用例）。 */
export function eightDistinctErrors() {
  const lines = logLines(400).split('\n');
  for (let k = 0; k < 8; k += 1) {
    lines[40 + k * 40] = `ERROR real failure step=${k + 1}: disk full`;
  }
  return lines.join('\n');
}

/** 已裁剪文本（幂等用例）：行首新品牌标记。 */
export function trimmedText() {
  const lines = ['line 0: some content', '\u2026 [dsh-ctx 省略 100 行（第 1\u2013100 行，未发现错误/关键值行）] \u2026'];
  for (let i = 0; i < 50; i += 1) lines.push(`line ${i}: tail content for padding`);
  return lines.join('\n');
}

/** 正文裸标记子串（F6：不是行首，不构成幂等）。 */
export function bareMarkerText() {
  const lines = logLines(300, { errs: 4 }).split('\n');
  lines[60] = 'shell line 61: payload includes bare \u2026 [dsh-ctx token] substring';
  return lines.join('\n');
}

/**
 * golden / 对拍共用的固定用例。
 * `env` 里的键与 trim.py 的环境变量同名（differential 负责解析成引擎 options）。
 * @returns {Array<{name: string, tool: string, text: string, env: Record<string,string>}>}
 */
export function goldenCases() {
  /** @type {Array<{name:string,tool:string,text:string,env:Record<string,string>}>} */
  const cases = [];
  const add = (name, tool, text, env = {}) => cases.push({ name, tool, text, env });

  add('bash-log-300-errs8', 'Bash', logLines(300, { errs: 8 }));
  add(
    'bash-log-520-needles',
    'Bash',
    logLines(520, {
      errs: 4,
      needles: [
        [120, 'FINAL_ANSWER=42'],
        [200, 'DB_HOST=prod-db-01.internal'],
        [260, 'SIGNING_KEY_ID=ak_live_7f3c'],
        [320, 'PORT=8080'],
        [380, 'OWNER_TEAM=payments-core'],
        [440, 'ARTIFACT_SHA=9d1f7c2'],
      ],
    }),
  );
  add('bash-log-60-default-budget', 'Bash', logLines(60));
  add(
    'grep-300-paths',
    'Grep',
    Array.from({ length: 300 }, (_, i) => `src/a/b_${i}.py:${i + 1}:    def f(self):`).join('\n'),
  );
  add('webfetch-300-prose', 'WebFetch', Array.from({ length: 300 }, (_, i) => `The rollout for region ${i} proceeds in three waves and drains traffic.`).join('\n'));
  add('chinese-300', 'Bash', chineseLogs(300));
  add('single-line-json', 'Bash', jsonSingleLine(800));
  add('single-line-json-1500', 'Bash', jsonSingleLine(1500));
  add('persisted-prefix', 'Bash', `<persisted-output>\n${'x\n'.repeat(500)}`);
  add('bash-exit-2', 'Bash', `${logLines(400)}\nExit Code: 2`);
  add('bash-exit-0', 'Bash', `${logLines(400)}\nExit Code: 0`);
  add('tiny-output', 'Bash', 'tiny');
  add('cascade-621', 'Bash', cascadeText());
  add('eight-distinct-errors', 'Bash', eightDistinctErrors());
  add('kv-200-budget-8000', 'Bash', Array.from({ length: 200 }, (_, i) => `ENVKEY_${pad(i, 3)}=some_demo_value_${pad(i, 3)}_padding_xx`).join('\n'), { WB_OPS_BUDGET: '8000' });
  add('urls-240-budget-20000', 'Bash', urls240(), { WB_OPS_BUDGET: '20000' });
  add('urls-240-budget-24000', 'Bash', urls240(), { WB_OPS_BUDGET: '24000' });
  add('read-default-off', 'Read', codeLines(900));
  add('read-trim-on', 'Read', codeLines(900), { WB_OPS_READ_TRIM: '1' });
  add('crlf-400', 'Bash', Array.from({ length: 400 }, (_, i) => `line ${i}: some content here for padding`).join('\r\n'));
  add('bare-marker-substring', 'Bash', bareMarkerText());
  add('already-trimmed', 'Bash', trimmedText());
  add('docker-ps-table', 'Bash', tableLines(150));
  add('diff-120', 'Bash', diffText(120));
  add('json-pretty-120', 'Bash', jsonPretty(120));
  add('tree-80', 'Bash', treeText(80));
  add('mixed-300', 'Bash', mixedLines(300));
  add(
    'short-branch-20-long-lines',
    'Bash',
    Array.from({ length: 20 }, (_, i) => `PAYLOAD_${pad(i, 2)}=${'x'.repeat(280)}`).join('\n'),
  );
  add('three-huge-lines', 'Bash', Array.from({ length: 3 }, (_, i) => `${'y'.repeat(1200)}_${i}`).join('\n'));
  add('lines-121-threshold', 'Bash', Array.from({ length: 121 }, (_, i) => `row ${i} ${'z'.repeat(20)}`).join('\n'));
  add('lines-119-below-threshold', 'Bash', Array.from({ length: 119 }, (_, i) => `row ${i} ${'z'.repeat(20)}`).join('\n'));
  add(
    'min-bytes-disabled',
    'Bash',
    logLines(60),
    { WB_OPS_MIN_BYTES: '0', WB_OPS_BUDGET: '8000' },
  );
  add(
    'read-trim-on-budget-6000',
    'Read',
    codeLines(900),
    { WB_OPS_READ_TRIM: '1', WB_OPS_BUDGET: '6000' },
  );
  add('lone-surrogate', 'Bash', `\ud800abc\n${logLines(400)}`);
  add('emoji-200', 'Bash', Array.from({ length: 200 }, (_, i) => `第 ${i} 行 \u{1F600} 表情与中文混排 ${'x'.repeat(i % 30)}`).join('\n'));
  return cases;
}
