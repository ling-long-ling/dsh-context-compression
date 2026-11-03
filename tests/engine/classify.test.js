import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyLine,
  exitCodeNonzero,
  isSkeletonLine,
  isStrongLine,
  isSymbolLine,
  isWeakLine,
} from '../../lib/engine/classify.js';

test('真错误信号 15/15 进 strong（acceptance P0-1）', () => {
  const good = [
    'ERROR x',
    'Error: boom',
    'Traceback (most recent call last):',
    'npm ERR! code ELIFECYCLE',
    'error[E0432]: unresolved import',
    "src/a.ts(3,5): error TS2322: Type 'string' is not assignable",
    'fatal: not a git repository',
    'panic: runtime error',
    'bash: foo: No such file or directory',
    'warning: unused variable',
    'WARNING: deprecated',
    '2026-10-20 12:00:00 错误：连接失败',
    'Exception in thread main',
    'permission denied: EACCES',
    'Exit Code: 2',
  ];
  for (const line of good) assert.equal(isStrongLine(line), true, line);
  for (const line of good) assert.equal(classifyLine(line), 3, line);
});

test('误命中词不进 strong（acceptance P0-1 红线）', () => {
  const probes = [
    'const failover = true;',
    'isError: false,',
    'errorCode: 0,',
    'warningLevel: 3,',
    'timeout_ms = 3000',
    'cannot_parse = null',
  ];
  for (const probe of probes) assert.equal(isStrongLine(probe), false, probe);
});

test('strong 细节：整词 / 告警前缀 / error 代码 / Exit Code 符号与数值', () => {
  assert.equal(isStrongLine('ERRORS are listed'), false, 'ERROR 整词不命中 ERRORS');
  assert.equal(isStrongLine('errorCode'), false);
  assert.equal(isStrongLine('warning:unused'), false, 'warning: 后必须紧跟空白或行尾');
  assert.equal(isStrongLine('warning:'), true);
  assert.equal(isStrongLine('  WARNING: x'), true);
  assert.equal(isStrongLine('error[E12]'), true);
  assert.equal(isStrongLine('error[E]'), false);
  assert.equal(isStrongLine('error TS99'), true);
  assert.equal(isStrongLine('error TSx'), false);
  assert.equal(exitCodeNonzero('Exit Code: 0'), false);
  assert.equal(exitCodeNonzero('Exit Code: 1'), true);
  assert.equal(exitCodeNonzero('Exit Code:   -7'), true);
  assert.equal(exitCodeNonzero('Exit Code: -0'), false);
  assert.equal(exitCodeNonzero('Exit Code: abc'), false);
  // 全文最后一处为准
  assert.equal(exitCodeNonzero('Exit Code: 1\n...\nExit Code: 0'), false);
  assert.equal(exitCodeNonzero('Exit Code: 0\n...\nExit Code: 9'), true);
  assert.equal(isStrongLine('Segmentation fault (core dumped)'), true);
  assert.equal(isStrongLine('\u9519\u8bef\u7ec8\u7aef'), true);
});

test('骨架判定 14/14 符合预期（acceptance P0-2）', () => {
  const cases = [
    ['FINAL_ANSWER=42', true],
    ['DB_HOST=prod-db-01.internal', true],
    ['| id | name | state |', true],
    ['diff --git a/x b/x', true],
    ['--- a/src/main.py', true],
    ['@@ -1,3 +1,4 @@', true],
    ['see https://example.com/a/b for details', true],
    ['loading config from /etc/wb/ops.conf', true],
    ['wrote C:\\Users\\dev\\AppData\\Local\\Temp\\x.txt', true],
    ['commit 9d1f7c2ab34e5f60', true],
    ['artifact sha=9d1f7c2', true],
    ['  "model": "gpt",', true],
    ["total += item['price'] * item['qty']", false],
    ['The rollout proceeds in three waves across zones.', false],
  ];
  for (const [line, want] of cases) assert.equal(isSkeletonLine(line), want, line);
});

test('普通代码的骨架误报率低（30 行代码命中 ≤3）', () => {
  const code = [
    'import os',
    'import sys',
    '',
    'def handler(request):',
    '    data = request.get_json()',
    '    if not data:',
    '        return None',
    '    total = 0',
    '    for item in data["items"]:',
    '        total += item["price"] * item["qty"]',
    '    result = {"total": total, "ok": True}',
    '    return result',
    '',
    'class Service:',
    '    def __init__(self, name):',
    '        self.name = name',
    '        self.items = []',
    '',
    '    def add(self, item):',
    '        self.items.append(item)',
    '',
    '    def run(self):',
    '        return [x for x in self.items if x]',
  ].join('\n');
  const hit = code.split('\n').filter((line) => isSkeletonLine(line));
  assert.ok(hit.length <= 3, JSON.stringify(hit));
});

test('WEAK：词首前缀 / 整词 / 中文子串', () => {
  for (const line of [
    'warningLevel: 3,',
    'const failover = true;',
    'timeout_ms = 3000',
    'request timed out',
    'cannot connect',
    'error here',
    'errors here',
    '\u8b66\u544a\uff1a\u5bb9\u91cf\u4e0d\u8db3',
    '\u8d85\u65f6\u91cd\u8bd5',
  ]) {
    assert.equal(isWeakLine(line), true, line);
  }
  assert.equal(isWeakLine('cannot_parse = null'), false, 'cannot 整词');
  assert.equal(isWeakLine('errorCode: 0'), false, 'error 整词');
  assert.equal(isWeakLine('plain text'), false);
});

test('Read 符号行', () => {
  for (const line of [
    'import os',
    'from x import y',
    'def foo(a):',
    'class Service:',
    '#include <stdio.h>',
    'export const x = 1',
    'pub fn run()',
    'typedef struct node',
  ]) {
    assert.equal(isSymbolLine(line), true, line);
    assert.equal(classifyLine(line) === 3, false, 'isSymbolLine 不是 classifyLine 的 tier 3');
  }
  assert.equal(isSymbolLine('const x = 1;'), false);
});
