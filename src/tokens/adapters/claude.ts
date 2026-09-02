/**
 * claude-code adapter（~/.claude/projects 递归 *.jsonl，支持 CLAUDE_CONFIG_DIR env）：
 * assistant 行 message.usage（官方 transcripts 结构，格式公开稳定）→ toRecord
 * 只读（CON-R002）。
 */
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PlatformSource, UsageRecord } from '../types';
import { safeJson, toRecord } from './shared';

/** claude-code 行：type=assistant 且 message.usage 存在 */
export function parseClaudeLine(line: string, fallbackTs: string): UsageRecord | null {
  const j = safeJson(line);
  if (!j || j.type !== 'assistant') return null;
  const msg = j.message as Record<string, unknown> | undefined;
  const usage = msg?.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return null;
  return toRecord(
    { ts: typeof j.timestamp === 'string' ? j.timestamp : fallbackTs, platform: 'claude-code', model: (msg?.model as string) || 'unknown' },
    usage
  );
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

export function createClaudeSource(home = homedir()): PlatformSource {
  const projectsDir = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, 'projects') : join(home, '.claude', 'projects');
  return {
    platform: 'claude-code',
    home: projectsDir,
    listFiles: () => {
      const out: string[] = [];
      listFilesRecursive(projectsDir, '.jsonl', out);
      return out;
    },
    parseLine: parseClaudeLine,
  };
}
