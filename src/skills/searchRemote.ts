/**
 * 远程搜索封装（CON-R-skills-010 / Q-036 / T-2，设计 D6）
 * npx skills find <q> 子进程（main 侧独占——renderer sandbox 无进程能力）；
 * 参数数组传递不经 shell（防注入）；30s 超时 kill；失败 → remote-search-failed 不影响本地列表。
 * 输出结构实测协调项 O-1：JSON 数组或 {entries:[]}，缺字段置 null，非 JSON → 失败。
 */
import { spawn } from 'node:child_process';

import { RemoteSearchFailedError, SkillValidationError } from './errors';
import type { RemoteSkillEntry } from './types';

export const REMOTE_SEARCH_TIMEOUT_MS = 30_000;

export type RemoteRunner = (args: string[], signal?: AbortSignal) => Promise<{ code: number; stdout: string }>;

function defaultRunner(args: string[], signal?: AbortSignal): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', args, { signal });
    let stdout = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout }));
  });
}

export interface SearchRemoteOptions {
  runner?: RemoteRunner;
  timeoutMs?: number;
}

export async function searchRemote(query: string, opts: SearchRemoteOptions = {}): Promise<RemoteSkillEntry[]> {
  const q = (query ?? '').trim();
  if (!q) throw new SkillValidationError('搜索词不能为空', 'query');
  const runner = opts.runner ?? defaultRunner;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? REMOTE_SEARCH_TIMEOUT_MS);
  let res: { code: number; stdout: string };
  try {
    res = await runner(['skills', 'find', q], ac.signal);
  } catch (err) {
    throw new RemoteSearchFailedError(`远程搜索失败: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.code !== 0) throw new RemoteSearchFailedError(`npx skills find 退出码 ${res.code}`);
  return parseRemoteOutput(res.stdout);
}

function parseRemoteOutput(stdout: string): RemoteSkillEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new RemoteSearchFailedError('远程输出不可解析（O-1 实测协调项）');
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { entries?: unknown }).entries)
      ? ((parsed as { entries: unknown[] }).entries as unknown[])
      : null;
  if (!arr) throw new RemoteSearchFailedError('远程输出结构不符合预期');
  return arr
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as { name?: unknown }).name === 'string')
    .map((e) => ({
      name: e.name as string,
      description: typeof e.description === 'string' ? e.description : null,
      source: typeof e.source === 'string' && /^https:\/\/.+/.test(e.source) ? e.source : null,
      installs: typeof e.installs === 'number' ? e.installs : null,
      installed: false, // 恒 false：仅浏览不安装（Q-036）
    }));
}
