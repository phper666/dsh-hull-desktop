/**
 * 远程 skill 安装（O-3 实测协调项 / Q-036 扩展：仅浏览 → 可安装）
 * npx skills add <owner/repo> -s <skill> -a <agent> 子进程（main 侧独占）；
 * 参数数组传递不经 shell（防注入）；120s 超时 kill；失败 → remote-install-failed 不影响本地。
 * 来源守卫：只接受 owner/repo@skill（搜索结果形态），agent 白名单枚举。
 */
import { spawn } from 'node:child_process';

import { RemoteInstallFailedError, SkillValidationError } from './errors';

export const REMOTE_INSTALL_TIMEOUT_MS = 120_000;

/** 支持安装的 agent（对齐 skills.sh 工具识别名；'*' = 全部） */
export const INSTALL_AGENTS = ['claude-code', 'opencode', 'codex', 'gemini-cli', 'cursor'] as const;
export type InstallAgent = (typeof INSTALL_AGENTS)[number];

export type InstallRunner = (args: string[], signal?: AbortSignal) => Promise<{ code: number; stdout: string }>;

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

export interface InstallRemoteOptions {
  runner?: InstallRunner;
  timeoutMs?: number;
}

/** 解析 owner/repo@skill → {repo, skill}；非法格式抛 validation-error（防注入：只许白名单字符） */
export function parseSkillRef(ref: string): { repo: string; skill: string } {
  const m = String(ref ?? '').trim().match(/^([\w.-]+\/[\w.-]+)@([\w.-]+)$/);
  if (!m) throw new SkillValidationError('skill 引用格式非法，应为 owner/repo@skill', 'skillRef');
  return { repo: m[1], skill: m[2] };
}

export async function installRemote(
  skillRef: string,
  agent: string,
  opts: InstallRemoteOptions = {}
): Promise<{ installedRef: string; agent: string }> {
  const { repo, skill } = parseSkillRef(skillRef);
  const a = String(agent ?? '').trim();
  if (!INSTALL_AGENTS.includes(a as InstallAgent)) {
    throw new SkillValidationError('agent 不在支持列表（claude-code/opencode/codex/gemini-cli/cursor）', 'agent');
  }
  const runner = opts.runner ?? defaultRunner;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? REMOTE_INSTALL_TIMEOUT_MS);
  let res: { code: number; stdout: string };
  try {
    res = await runner(['skills', 'add', repo, '-s', skill, '-a', a], ac.signal);
  } catch (err) {
    throw new RemoteInstallFailedError(`远程安装失败: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.code !== 0) throw new RemoteInstallFailedError(`npx skills add 退出码 ${res.code}`);
  return { installedRef: `${repo}@${skill}`, agent: a };
}
