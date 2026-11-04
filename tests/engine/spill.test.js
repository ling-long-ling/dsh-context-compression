import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32 as zlibCrc32 } from 'node:zlib';

import { crc32, safeSidDir } from '../../lib/engine/spill.js';
import { callEngine } from './helpers.js';
import { logLines } from './corpus.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spill-'));
}

function engineWithSpill(text, spillDir, overrides = {}) {
  return callEngine(text, 'Bash', {
    spillEnabled: true,
    spillDir,
    sessionId: 'sess-1234',
    ...overrides,
  });
}

test('crc32 与 zlib（C 实现）逐值一致', () => {
  const samples = [
    Buffer.from(''),
    Buffer.from('a'),
    Buffer.from('hello world'),
    Buffer.from(logLines(50, { errs: 2 }), 'utf8'),
    Buffer.from('\u4e2d\u6587\u9519\u8bef\uff0c\u8d85\u65f6', 'utf8'),
    Buffer.from([0, 1, 2, 0xff, 0x80, 0x00]),
  ];
  for (const sample of samples) {
    assert.equal(crc32(sample) >>> 0, zlibCrc32(sample) >>> 0, sample.length.toString());
  }
});

test('落盘：内容寻址文件名 %08x-%x.txt、目录为 sid8、内容逐字节一致', () => {
  const dir = tempDir();
  try {
    const text = logLines(300, { errs: 4 });
    const result = engineWithSpill(text, dir);
    assert.equal(result.reason, 'trim');
    assert.equal(result.meta.p, 1);
    const match = result.text.match(/\u539f\u6587 (.*?)\uff0c\u53ef Grep \u56de\u67e5/);
    assert.ok(match, result.text.slice(0, 200));
    const filePath = match[1];
    assert.ok(fs.existsSync(filePath), filePath);
    assert.deepEqual(fs.readFileSync(filePath), Buffer.from(text, 'utf8'));
    assert.equal(path.dirname(filePath), path.join(dir, 'sess-123'));
    const base = path.basename(filePath);
    assert.match(base, /^[0-9a-f]{8}-[0-9a-f]+\.txt$/);
    const expected = `${crc32(Buffer.from(text, 'utf8')).toString(16).padStart(8, '0')}-${Buffer.byteLength(text, 'utf8').toString(16)}.txt`;
    assert.equal(base, expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('落盘：同内容同名（内容寻址去重）', () => {
  const dir = tempDir();
  try {
    const text = logLines(300, { errs: 4 });
    const first = engineWithSpill(text, dir);
    const second = engineWithSpill(text, dir);
    const p1 = first.text.match(/\u539f\u6587 (.*?)\uff0c/)[1];
    const p2 = second.text.match(/\u539f\u6587 (.*?)\uff0c/)[1];
    assert.equal(p1, p2);
    assert.equal(fs.readdirSync(path.join(dir, 'sess-123')).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('落盘关闭：不写文件、标记不带路径、meta.p=0', () => {
  const dir = tempDir();
  try {
    const text = logLines(300, { errs: 4 });
    const result = callEngine(text, 'Bash', {
      spillEnabled: false,
      spillDir: dir,
      sessionId: 'sess-1234',
    });
    assert.equal(result.reason, 'trim');
    assert.equal(result.meta.p, 0);
    assert.equal(result.text.includes('\u53ef Grep \u56de\u67e5'), false);
    assert.equal(fs.readdirSync(dir).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('落盘清理：删除超过 7 天的文件，保留新文件', () => {
  const dir = tempDir();
  try {
    const sidDir = path.join(dir, 'sess-123');
    fs.mkdirSync(sidDir, { recursive: true });
    const oldFile = path.join(sidDir, 'deadbeef-1.txt');
    const freshFile = path.join(sidDir, 'deadbeef-2.txt');
    fs.writeFileSync(oldFile, 'old');
    fs.writeFileSync(freshFile, 'fresh');
    const oldDate = new Date(Date.now() - 8 * 86400 * 1000);
    fs.utimesSync(oldFile, oldDate, oldDate);
    engineWithSpill(logLines(300, { errs: 4 }), dir);
    assert.equal(fs.existsSync(oldFile), false, '超期文件应被清理');
    assert.equal(fs.existsSync(freshFile), true, '新文件应保留');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('落盘失败不影响裁剪：目录不可用时静默降级为不落盘', () => {
  const dir = tempDir();
  try {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a dir');
    const result = engineWithSpill(logLines(300, { errs: 4 }), blocker);
    assert.equal(result.reason, 'trim');
    assert.equal(result.meta.p, 0);
    assert.equal(result.text.includes('\u53ef Grep \u56de\u67e5'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sid8：前 8 字节 + 安全字符集过滤，空则 nosid', () => {
  assert.equal(safeSidDir('sess-1234'), 'sess-123');
  assert.equal(safeSidDir(''), 'nosid');
  assert.equal(safeSidDir('!!!@@@'), 'nosid');
  assert.equal(safeSidDir('\u4f1a\u8bdd\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b'), 'nosid');
  assert.equal(safeSidDir('abc/def\\ghi'), 'abcdef');
});

test('落盘 fail-soft：spillDays 非法时按 7 天处理', () => {
  const dir = tempDir();
  try {
    const sidDir = path.join(dir, 'sess-123');
    fs.mkdirSync(sidDir, { recursive: true });
    const oldFile = path.join(sidDir, 'deadbeef-3.txt');
    fs.writeFileSync(oldFile, 'old');
    const oldDate = new Date(Date.now() - 8 * 86400 * 1000);
    fs.utimesSync(oldFile, oldDate, oldDate);
    engineWithSpill(logLines(300, { errs: 4 }), dir, { spillDays: 0 });
    assert.equal(fs.existsSync(oldFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 递归列出目录下的普通文件（目录本身不算孤儿文件）。 */
function filesUnder(dir) {
  return fs
    .readdirSync(dir, { recursive: true })
    .map((entry) => path.join(dir, String(entry)))
    .filter((filePath) => {
      try {
        return fs.statSync(filePath).isFile();
      } catch {
        return false;
      }
    });
}

test('v2.1 R4：没有关键行也落盘，标记带原文路径', () => {
  const dir = tempDir();
  try {
    // 普通 prose：既没有 STRONG 也没有 SKELETON → keyPicked 为空
    const text = Array.from(
      { length: 400 },
      (_, i) => `plain prose line ${i}: the rollout proceeds in waves across zones`,
    ).join('\n');
    const result = engineWithSpill(text, dir);
    assert.equal(result.reason, 'trim');
    assert.equal(result.meta.k, 0);
    assert.equal(result.meta.g, 0);
    assert.equal(result.meta.p, 1, '无关键行也要落盘');
    assert.ok(result.text.includes('\u672a\u53d1\u73b0\u9519\u8bef/\u5173\u952e\u503c\u884c'), 'plainMarker 文案');
    const match = result.text.match(/\u539f\u6587 (.*?)\uff0c\u53ef Grep \u56de\u67e5/);
    assert.ok(match, result.text.slice(0, 200));
    assert.ok(fs.existsSync(match[1]), match[1]);
    assert.deepEqual(fs.readFileSync(match[1]), Buffer.from(text, 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v2.1 P2-4：finish 判定退化时删除已落盘的原文（不留孤儿文件）', () => {
  const dir = tempDir();
  try {
    // 节省量达不到 minSaveBytes → finish 返回 null，但原文此前已经落盘
    const text = logLines(300, { errs: 4 });
    const normal = engineWithSpill(text, dir);
    assert.equal(normal.reason, 'trim');
    assert.ok(filesUnder(dir).length > 0, '正常路径应有落盘文件');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const noGain = engineWithSpill(text, dir, { minSaveBytes: 1e9 });
    assert.equal(noGain.reason, 'short');
    assert.equal(noGain.text, null);
    assert.deepEqual(filesUnder(dir), [], '退化的原文必须删除');

    // 少行分支的退化同样要删（v2.1 两处 finish 调用都做了清理）
    const shortNoGain = engineWithSpill('z'.repeat(6000), dir, { minSaveBytes: 1e9 });
    assert.equal(shortNoGain.reason, 'short');
    assert.deepEqual(filesUnder(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

