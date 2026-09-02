/**
 * kimi code 平台适配器（T1 JSONL 型）：
 * - 路径 ~/.kimi/sessions 下递归 wire.jsonl
 * - 格式内部未公开——防御式：findUsageShape 深找 usage 形态 + findString('model') + timestamp
 */
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PlatformSource, UsageRecord } from '../types';
import { findString, findUsageShape, safeJson, toRecord } from './shared';

/** 逐行解析：防御式深找 usage 形态 → UsageRecord；否则 null */
export function parseKimiLine(line: string, fallbackTs: string): UsageRecord | null {
  const j = safeJson(line);
  if (!j) return null;
  const usage = findUsageShape(j);
  if (!usage) return null;
  const model = findString(j, 'model', 4) || 'unknown';
  const ts = typeof j.timestamp === 'string' ? j.timestamp : typeof j.timestamp === 'number' ? new Date(j.timestamp).toISOString() : fallbackTs;
  return toRecord({ ts, platform: 'kimi', model }, usage);
}

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 子目录 EPERM/ENOENT → 跳过不中断
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === 'wire.jsonl') out.push(p);
  }
}

export function createKimiSource(home: string = homedir()): PlatformSource {
  const sessionsDir = join(home, '.kimi', 'sessions');
  return {
    platform: 'kimi',
    home: sessionsDir,
    listFiles: () => {
      const files: string[] = [];
      walk(sessionsDir, files);
      return files;
    },
    parseLine: parseKimiLine,
  };
}
