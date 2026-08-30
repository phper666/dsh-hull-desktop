import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NOOP_LOGGER, type RuntimeLogger } from '../shared/types';
import { DOWNLOAD_RECORD_FILE, reconcileHullUpdaterCache, writeDownloadRecord } from './UpdaterCacheReconciler';

function makeCacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'hull-updater-cache-'));
}

/** 收集日志的 stub logger */
function makeLogger() {
  const lines: Array<{ level: string; msg: string }> = [];
  const logger: RuntimeLogger = {
    info: (m: string) => lines.push({ level: 'info', msg: m }),
    warn: (m: string) => lines.push({ level: 'warn', msg: m }),
    error: (m: string) => lines.push({ level: 'error', msg: m }),
    dshLog: () => {},
  };
  return { logger, lines };
}

/** 播种陈旧差分基（可选写下载记录） */
function seedStaleCache(dir: string, withRecord?: string): void {
  writeFileSync(join(dir, 'update.zip'), 'stale-zip');
  writeFileSync(join(dir, 'current.blockmap'), 'stale-blockmap');
  if (withRecord) writeFileSync(join(dir, DOWNLOAD_RECORD_FILE), JSON.stringify({ version: withRecord, at: 1 }));
}

test('① 未传 cacheDir / 目录不存在 → no-op 不抛', () => {
  reconcileHullUpdaterCache({ currentVersion: '0.1.6', logger: NOOP_LOGGER });
  reconcileHullUpdaterCache({ cacheDir: join(tmpdir(), `hull-none-${Date.now()}`), currentVersion: '0.1.6', logger: NOOP_LOGGER });
});

test('② 差分基存在 + 无下载记录 → 清（防陈旧基假回退）+ info 留痕', () => {
  const dir = makeCacheDir();
  seedStaleCache(dir);
  const { logger, lines } = makeLogger();
  reconcileHullUpdaterCache({ cacheDir: dir, currentVersion: '0.1.6', logger });
  equal(existsSync(join(dir, 'update.zip')), false);
  equal(existsSync(join(dir, 'current.blockmap')), false);
  ok(lines.some((l) => l.level === 'info' && l.msg.includes('不同源')), '应有清理 info 日志');
});

test('③ 记录版本 == 运行版本 → 保留差分基', () => {
  const dir = makeCacheDir();
  seedStaleCache(dir, '0.1.6');
  const { logger, lines } = makeLogger();
  reconcileHullUpdaterCache({ cacheDir: dir, currentVersion: '0.1.6', logger });
  equal(existsSync(join(dir, 'update.zip')), true);
  equal(existsSync(join(dir, 'current.blockmap')), true);
  equal(lines.length, 0, '同源不应有清理日志');
});

test('④ 记录版本 != 运行版本（手动重装跨版本）→ 清', () => {
  const dir = makeCacheDir();
  seedStaleCache(dir, '0.1.5');
  reconcileHullUpdaterCache({ cacheDir: dir, currentVersion: '0.1.6', logger: NOOP_LOGGER });
  equal(existsSync(join(dir, 'update.zip')), false);
});

test('⑤ 记录损坏 json → 按失配清', () => {
  const dir = makeCacheDir();
  seedStaleCache(dir);
  writeFileSync(join(dir, DOWNLOAD_RECORD_FILE), 'not-json{');
  reconcileHullUpdaterCache({ cacheDir: dir, currentVersion: '0.1.6', logger: NOOP_LOGGER });
  equal(existsSync(join(dir, 'update.zip')), false);
});

test('⑥ pending/ 不动（electron-updater 以 update-info.json+sha512 自校验）', () => {
  const dir = makeCacheDir();
  seedStaleCache(dir);
  mkdirSync(join(dir, 'pending'));
  writeFileSync(join(dir, 'pending', 'keep.txt'), 'x');
  reconcileHullUpdaterCache({ cacheDir: dir, currentVersion: '0.1.6', logger: NOOP_LOGGER });
  equal(existsSync(join(dir, 'pending', 'keep.txt')), true);
});

test('⑦ 仅 blockmap 无 zip → 也清', () => {
  const dir = makeCacheDir();
  writeFileSync(join(dir, 'current.blockmap'), 'stale-blockmap');
  reconcileHullUpdaterCache({ cacheDir: dir, currentVersion: '0.1.6', logger: NOOP_LOGGER });
  equal(existsSync(join(dir, 'current.blockmap')), false);
});

test('⑧ writeDownloadRecord：写入/空 version no-op/写失败告警不抛', () => {
  const dir = makeCacheDir();
  const { logger, lines } = makeLogger();
  writeDownloadRecord(dir, '0.2.0', logger);
  const rec = JSON.parse(readFileSync(join(dir, DOWNLOAD_RECORD_FILE), 'utf8')) as { version: string };
  equal(rec.version, '0.2.0');
  writeDownloadRecord(dir, null, logger); // 无版本 no-op
  writeDownloadRecord(null, '0.2.0', logger); // 无目录 no-op
  // 失败路径：cacheDir 指向文件 → writeFileSync 抛 → 捕获为 warn
  const filePath = join(dir, 'occupied');
  writeFileSync(filePath, 'x');
  writeDownloadRecord(filePath, '0.2.0', logger);
  ok(lines.some((l) => l.level === 'warn' && l.msg.includes('写下载记录失败')), '应有写失败 warn');
});
