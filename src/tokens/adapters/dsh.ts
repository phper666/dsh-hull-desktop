/**
 * dsh adapter（~/.dsh/sessions 递归 *.jsonl.zstd，支持 DSH_HOME env）：
 * - readFile 用 node:zlib zstdDecompressSync 解压（Node ≥22.15/23.8 内置；不可用抛错由调用方隔离）
 * - 行解析：message.usage 优先 + findUsageShape 兜底；session 头跳过；时间戳缺省用会话头 createdAt
 * 只读（CON-R002 红线：绝不写 DSH_HOME）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as nodeZlib from 'node:zlib';

import type { PlatformSource, UsageRecord } from '../types';
import { findString, findUsageShape, safeJson, toRecord } from './shared';

/** zstd 解压（Node ≥22.15/23.8 内置；不可用 → dsh 源抛错由调用方隔离） */
function zstdDecompress(buf: Buffer): string {
  const zstd = (nodeZlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
  if (typeof zstd !== 'function') throw new Error('当前 Node 无内置 zstd 解压能力');
  return zstd(buf).toString('utf8');
}

/** dsh 行（zstd 解压后）：优先 message.usage（dsh 会话结构与 CC 同源），退化防御式深找；会话头无用量跳过 */
export function parseDshLine(line: string, fallbackTs: string): UsageRecord | null {
  const j = safeJson(line);
  if (!j) return null;
  if (j.type === 'session') return null; // 会话头无用量
  const msg = j.message as Record<string, unknown> | undefined;
  let usage: Record<string, unknown> | undefined = (msg?.usage as Record<string, unknown> | undefined) || (j.usage as Record<string, unknown> | undefined) || undefined;
  if (!usage) usage = findUsageShape(j) ?? undefined;
  if (!usage) return null;
  const model = (msg?.model as string) || findString(j, 'model', 3) || 'unknown';
  return toRecord({ ts: typeof j.timestamp === 'string' ? j.timestamp : fallbackTs, platform: 'dsh', model }, usage);
}

function listFilesRecursive(dir: string, ext: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 子目录 EPERM/ENOENT → 跳过不中断
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) listFilesRecursive(p, ext, out);
    else if (entry.name.endsWith(ext)) out.push(p);
  }
}

export function createDshSource(home = homedir()): PlatformSource {
  const sessionsDir = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : join(home, '.dsh', 'sessions');
  return {
    platform: 'dsh',
    home: sessionsDir,
    listFiles: () => {
      const out: string[] = [];
      listFilesRecursive(sessionsDir, '.jsonl.zstd', out);
      return out;
    },
    parseLine: parseDshLine,
    readFile: (path) => zstdDecompress(readFileSync(path)),
  };
}
