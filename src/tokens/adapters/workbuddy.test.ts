import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkbuddySource, parseWorkbuddySource, workbuddyDbPath } from './workbuddy';

/** 建 session_usage fixture → db 路径 */
function makeWorkbuddyDb(dir: string, rows: Array<{ session_id: string; used: number; size: number; updated_at: number }>): string {
  const dbPath = join(dir, 'workbuddy.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE session_usage (session_id TEXT PRIMARY KEY, used INTEGER, size INTEGER, updated_at INTEGER, credit_json TEXT)');
    const ins = db.prepare('INSERT INTO session_usage (session_id, used, size, updated_at, credit_json) VALUES (?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(r.session_id, r.used, r.size, r.updated_at, '{}');
  } finally {
    db.close();
  }
  return dbPath;
}

test('workbuddy：session_usage 总量映射（used→输出侧、updated_at→ISO）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-workbuddy-'));
  try {
    const dbPath = makeWorkbuddyDb(dir, [
      { session_id: 's1', used: 81420, size: 168000, updated_at: 1787642132430 },
      { session_id: 's2', used: 94514, size: 1000000, updated_at: 1781256397050 },
    ]);
    const recs = parseWorkbuddySource(dbPath);
    equal(recs.length, 2);
    equal(recs[0].platform, 'workbuddy');
    equal(recs[0].model, 'unknown', '模型哈希不可拆 → unknown');
    equal(recs[0].outputTokens, 81420, 'used 全记输出侧（无拆分信息）');
    equal(recs[0].inputTokens, 0);
    ok(recs[0].ts.startsWith('2026'), 'updated_at unix ms → ISO');
    ok(recs[1].ts < recs[0].ts, '行序按插入序（时间语义在 ts）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workbuddy：db 缺失/表缺失/used 或 updated_at 为空 → [] 不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-workbuddy-emp-'));
  try {
    equal(parseWorkbuddySource(join(dir, 'no-such.db')).length, 0, 'db 缺失 → []');
    const dbPath = join(dir, 'empty.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE session_usage (session_id TEXT, used INTEGER, updated_at INTEGER, size INTEGER, credit_json TEXT)');
    } finally {
      db.close();
    }
    equal(parseWorkbuddySource(dbPath).length, 0, '空表 → []');
    const db2 = makeWorkbuddyDb(dir, [{ session_id: 's3', used: 100, size: 10, updated_at: 0 }]);
    equal(parseWorkbuddySource(db2).length, 1, 'updated_at=0（unix 1970）是合法时间戳 → 计入');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workbuddy：createWorkbuddySource 平台源形态（listFiles 仅 db 存在时返回）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-workbuddy-src-'));
  try {
    const src = createWorkbuddySource(dir);
    equal(src.platform, 'workbuddy');
    equal(src.home, join(dir, '.workbuddy', 'workbuddy.db'));
    equal(workbuddyDbPath(dir), src.home);
    equal(src.listFiles().length, 0, 'db 不存在 → 空文件集（scanAllSources 跳过）');
    mkdirSync(join(dir, '.workbuddy'), { recursive: true });
    makeWorkbuddyDb(join(dir, '.workbuddy'), [{ session_id: 's4', used: 77, size: 10, updated_at: 1787642132430 }]);
    equal(src.listFiles().length, 1, 'db 存在 → 列入扫描');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
