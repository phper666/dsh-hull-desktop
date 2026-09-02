/**
 * roo code 平台适配器（T1 JSONL/JSON 型，cline fork 同构）：
 * - 路径 VS Code globalStorage/rooveterinaryinc.roo-cline/tasks/<taskId>/api_conversation_history.json
 * - 只扫已知编辑器具体 globalStorage 路径（不宽扫 ~/Library/Application Support，避免 TCC 保护目录 EPERM）+ ~/.vscode* 变体
 * - 格式与 cline 完全同构（anthropic usage）
 * 参考：docs/research/2026-09-02-agent-token-format-research.md §5
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PlatformSource, UsageRecord } from '../types';
import { findString, safeJson, toRecord } from './shared';

/** 单条 assistant 消息 → UsageRecord（非 assistant / 无 usage → null） */
export function parseRooMessage(j: Record<string, unknown>, fallbackTs: string): UsageRecord | null {
  if (j.role !== 'assistant') return null;
  const usage = j.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return null;
  const tsNum = typeof j.ts === 'number' ? j.ts : typeof j.timestamp === 'number' ? j.timestamp : NaN;
  const ts = Number.isFinite(tsNum) ? new Date(tsNum).toISOString() : typeof j.timestamp === 'string' ? j.timestamp : fallbackTs;
  const model = (j.model as string) || findString(j, 'model', 3) || 'unknown';
  return toRecord({ ts, platform: 'roo', model }, usage);
}

/** 逐行解析（单条消息对象） */
export function parseRooLine(line: string, fallbackTs: string): UsageRecord | null {
  const j = safeJson(line);
  if (!j || Array.isArray(j)) return null;
  return parseRooMessage(j, fallbackTs);
}

/** 整文件解析：兼容 JSONL 与单行 JSON 数组两种版本（同 cline） */
export function parseRooFile(text: string, fallbackTs: string): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const j = safeJson(line);
    if (!j) continue;
    if (Array.isArray(j)) {
      for (const m of j) {
        const r = parseRooMessage(m as Record<string, unknown>, fallbackTs);
        if (r) out.push(r);
      }
    } else {
      const r = parseRooMessage(j, fallbackTs);
      if (r) out.push(r);
    }
  }
  return out;
}

/** 递归找 tasks/**&#47;api_conversation_history.json；子目录 EPERM/ENOENT → 跳过不中断 */
function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 单个子目录读不了（TCC EPERM 等）→ 跳过
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === 'api_conversation_history.json') out.push(p);
  }
}

/** 已知编辑器 roo-cline globalStorage 根（存在才加入；逐个 existsSync，不宽扫） */
function rooBases(home: string): string[] {
  const bases: string[] = [];
  const appSupport = join(home, 'Library', 'Application Support');
  const gs = join('User', 'globalStorage', 'rooveterinaryinc.roo-cline');
  for (const editor of ['Code', 'Cursor', 'Windsurf']) {
    const b = join(appSupport, editor, gs);
    if (existsSync(b)) bases.push(b);
  }
  // Trae* 等命名变体
  try {
    for (const e of readdirSync(appSupport, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith('Trae')) {
        const b = join(appSupport, e.name, gs);
        if (existsSync(b)) bases.push(b);
      }
    }
  } catch {
    // appSupport 读不了 → 跳过 Trae 变体
  }
  // ~/.vscode* 变体
  try {
    for (const e of readdirSync(home, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith('.vscode')) {
        const b = join(home, e.name, 'User', 'globalStorage', 'rooveterinaryinc.roo-cline');
        if (existsSync(b)) bases.push(b);
      }
    }
  } catch {
    // home 读不了 → 跳过 .vscode 变体
  }
  return bases;
}

export function createRooSource(home: string = homedir()): PlatformSource {
  const bases = rooBases(home);
  return {
    platform: 'roo',
    home: join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline'),
    listFiles: () => {
      const files: string[] = [];
      for (const b of bases) walk(b, files);
      return files;
    },
    parseFile: parseRooFile,
  };
}
