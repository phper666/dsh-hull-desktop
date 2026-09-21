import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { previewBundle, type PackResult, type PreviewOptions } from './manifest';

function mkTemp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** previewUnavailable 标记断言（lane types.ts 落地前字段有无均兼容） */
const flag = (p: object): boolean => (p as Record<string, unknown>).previewUnavailable === true;

/** 写一个假 npm 包（含 package/ 前缀，模拟 npm pack 解包结果） */
function writePkg(targetDir: string, files: Record<string, string>): void {
  mkdirSync(join(targetDir, 'package'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(targetDir, 'package', rel), content);
  }
}

test('previewBundle：pack 解析 → 摘要 + 可用标记 + 临时目录清理', async () => {
  const tmpRoot = mkTemp('hull-mf-');
  const pack: PreviewOptions['pack'] = async (_spec, targetDir) => {
    writePkg(targetDir, {
      'package.json': JSON.stringify({ name: 'demo-plugin', version: '1.2.3', dsh: { bundle: 'cordis.patch.yml' } }),
      'cordis.patch.yml': '- path: a/b.ts\n- path: c/d.ts\n- path: e/f.ts\n- path: g/h.ts\n',
    });
    return { ok: true, dir: join(targetDir, 'package') };
  };
  try {
    const preview = await previewBundle('https://npm.example/demo.tgz', tmpRoot, { pack });
    equal(preview.id, 'demo-plugin');
    equal(preview.version, '1.2.3');
    equal(preview.sourceUrl, 'https://npm.example/demo.tgz');
    ok(preview.patchSummary !== null);
    ok(preview.patchSummary.includes('4'), `摘要含修改处数：${preview.patchSummary}`);
    ok(preview.patchSummary.includes('a/b.ts'), `摘要含文件路径：${preview.patchSummary}`);
    equal(flag(preview), false);
    equal(readdirSync(tmpRoot).length, 0, '临时目录用完即清');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('previewBundle：无 dsh.bundle/cordis.patch.yml → previewUnavailable（不阻断，id/version 仍可读）', async () => {
  const tmpRoot = mkTemp('hull-mf-');
  const pack: PreviewOptions['pack'] = async (_spec, targetDir) => {
    writePkg(targetDir, { 'package.json': JSON.stringify({ name: 'demo-plugin', version: '1.2.3' }) });
    return { ok: true, dir: join(targetDir, 'package') };
  };
  try {
    const preview = await previewBundle('https://npm.example/demo.tgz', tmpRoot, { pack });
    equal(preview.id, 'demo-plugin');
    equal(preview.version, '1.2.3');
    equal(preview.patchSummary, null);
    equal(flag(preview), true);
    equal(readdirSync(tmpRoot).length, 0);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('previewBundle：package.json 无法解析 → previewUnavailable + 清理（不抛）', async () => {
  const tmpRoot = mkTemp('hull-mf-');
  const pack: PreviewOptions['pack'] = async (_spec, targetDir) => {
    writePkg(targetDir, { 'package.json': '{ not json' });
    return { ok: true, dir: join(targetDir, 'package') };
  };
  try {
    const preview = await previewBundle('https://npm.example/demo.tgz', tmpRoot, { pack });
    equal(preview.id, 'unknown');
    equal(preview.patchSummary, null);
    equal(flag(preview), true);
    equal(readdirSync(tmpRoot).length, 0);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('previewBundle：pack 执行失败 → previewUnavailable + 清理（不抛）', async () => {
  const tmpRoot = mkTemp('hull-mf-');
  const pack: PreviewOptions['pack'] = async () => ({ ok: false, dir: null, message: 'npm ERR! 404' });
  try {
    const preview = await previewBundle('https://npm.example/nope.tgz', tmpRoot, { pack });
    equal(preview.patchSummary, null);
    equal(flag(preview), true);
    equal(readdirSync(tmpRoot).length, 0);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

/** 路径穿越用例：dsh.bundle 指向包根外 → 拒绝读取（patchSummary null + previewUnavailable），不越界 */
const TRAVERSAL_CASES: Array<[string, string]> = [
  ['../穿越（..）', '../evil.yml'],
  ['深层穿越（../../..）', '../../../etc/passwd'],
  ['绝对路径', '/etc/passwd'],
];

for (const [label, rel] of TRAVERSAL_CASES) {
  test(`previewBundle：dsh.bundle 恶意路径 ${label} → 拒绝（patchSummary null + previewUnavailable，id/version 仍可读）`, async () => {
    const tmpRoot = mkTemp('hull-mf-');
    const pack: PreviewOptions['pack'] = async (_spec, targetDir) => {
      writePkg(targetDir, {
        'package.json': JSON.stringify({ name: 'evil-plugin', version: '1.0.0', dsh: { bundle: rel } }),
        // 包根外不落文件：被拒后不应读到任何内容
      });
      return { ok: true, dir: join(targetDir, 'package') };
    };
    try {
      const preview = await previewBundle('https://npm.example/evil.tgz', tmpRoot, { pack });
      equal(preview.id, 'evil-plugin', `${label}：id 仍可读`);
      equal(preview.version, '1.0.0', `${label}：version 仍可读`);
      equal(preview.patchSummary, null, `${label}：patch 拒绝读取`);
      equal(flag(preview), true, `${label}：previewUnavailable 标记`);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
}

test('previewBundle：dsh.bundle 合法相对路径（子目录）→ 正常读取', async () => {
  const tmpRoot = mkTemp('hull-mf-');
  const pack: PreviewOptions['pack'] = async (_spec, targetDir) => {
    mkdirSync(join(targetDir, 'package', 'patches'), { recursive: true });
    writePkg(targetDir, {
      'package.json': JSON.stringify({ name: 'ok-plugin', version: '1.0.0', dsh: { bundle: 'patches/patch.yml' } }),
      'patches/patch.yml': '- path: a.ts\n- path: b.ts\n',
    });
    return { ok: true, dir: join(targetDir, 'package') };
  };
  try {
    const preview = await previewBundle('https://npm.example/ok.tgz', tmpRoot, { pack });
    equal(preview.id, 'ok-plugin');
    ok(preview.patchSummary !== null);
    equal(flag(preview), false);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
