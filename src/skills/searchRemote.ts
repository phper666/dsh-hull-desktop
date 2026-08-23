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

/**
 * 解析远程输出（O-1 实测协调项：`npx skills find` 实际输出 ANSI 彩色文本树，非 JSON）：
 * 1) 去 ANSI 色码；2) 优先 JSON（老/新版本兼容，数组或 {entries:[]}）；3) 否则按文本树解析——
 *    两行一组：`<owner/repo>@<skill>  <N>K installs` + `└ https://skills.sh/<owner>/<repo>/<skill>`；
 *    空行/头部提示行跳过。仍无法解析 → remote-search-failed（不影响本地列表）。
 */
function parseRemoteOutput(stdout: string): RemoteSkillEntry[] {
  const plain = String(stdout).replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!plain) return [];

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(plain);
  } catch {
    /* 非 JSON → 走文本树 */
  }
  if (parsed !== null) {
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { entries?: unknown }).entries)
        ? ((parsed as { entries: unknown[] }).entries as unknown[])
        : null;
    if (arr) {
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
  }

  // 文本树解析：两行一组（name-line / url-line），空行与头部提示跳过
  const lines = plain.split('\n').map((l) => l.trim()).filter((l) => l);
  const entries: RemoteSkillEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('Install with') || line.startsWith('└') || line.startsWith('✗')) continue;
    const nameMatch = line.match(/^(\S+@\S+)\s+(.*?)\s*$/);
    if (!nameMatch) continue; // 非条目行跳过
    const name = nameMatch[1];
    const url = lines[i + 1]?.startsWith('└') ? lines[i + 1].slice(1).trim() : null;
    if (url) i++; // 已消费 url 行
    entries.push({
      name,
      description: null,
      source: url && /^https:\/\/.+/.test(url) ? url : null,
      installs: parseInstalls(nameMatch[2]),
      installed: false,
    });
  }
  if (entries.length === 0) throw new RemoteSearchFailedError('远程输出不可解析（O-1 实测协调项）');
  return entries;
}

/** 解析安装数：`205.5K installs` / `12.3M installs` / 纯数字 → 数字；无法解析 → null */
function parseInstalls(text: string): number | null {
  const m = String(text).match(/([\d.]+)\s*([KM]?)/i);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  if (Number.isNaN(n)) return null;
  const mult = m[2].toUpperCase() === 'K' ? 1000 : m[2].toUpperCase() === 'M' ? 1_000_000 : 1;
  return Math.round(n * mult);
}
