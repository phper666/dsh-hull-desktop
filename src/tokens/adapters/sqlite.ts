/**
 * SQLite 只读工具（T2 SQLite 型平台适配器共用）：
 * - querySqlite：node:sqlite DatabaseSync readonly 打开 + 查询；打开失败/查询失败 → null（单源隔离，由调用方跳过该源）
 * - 绝不写（readOnly: true；CON-R002 精神）
 */
import { DatabaseSync } from 'node:sqlite';

/** 只读查询 SQLite；返回行数组（Record），失败返回 null（不抛） */
export function querySqlite(dbPath: string, sql: string): Record<string, unknown>[] | null {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const stmt = db.prepare(sql);
      const rows = stmt.all() as Record<string, unknown>[];
      return rows ?? [];
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** 表是否存在（防御式：避免 schema 缺失直接失败；表名来自代码常量非用户输入，内联安全） */
export function hasTable(dbPath: string, table: string): boolean {
  const rows = querySqlite(dbPath, `SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`);
  return rows !== null && rows.length > 0;
}
