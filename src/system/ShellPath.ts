import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute } from 'node:path';

/**
 * 读取用户交互 shell 的 PATH（设置页“Shell 环境变量”区块 / shell.html lane 消费）。
 * 走 `-ilc` 让 shell 自身加载 rc（用户 PATH 通常在 .zshrc/.bashrc 里追加），耗时计入 elapsedMs。
 * 安全：SHELL 来自环境变量不可信 → 必须绝对路径且存在，否则回退 /bin/zsh。
 */

const MARKER = '__HULL_PATH__';
const DEFAULT_SHELL = '/bin/zsh';
const DEFAULT_TIMEOUT_MS = 3000;

/** 注入用最小 fs 面（测试替换；默认 node:fs） */
export interface ShellPathFs {
  existsSync(path: string): boolean;
  statSync(path: string): { isDirectory(): boolean };
}

export interface ShellPathDeps {
  spawnFn?: typeof spawn;
  shell?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  fs?: ShellPathFs;
}

export interface ShellPathResult {
  shell: string;
  dirs: string[];
  elapsedMs: number;
}

/** 读取 shell PATH；失败（超时/无输出/无有效目录）reject，由 IPC 层转 { ok: false } */
export async function readShellPath(deps: ShellPathDeps = {}): Promise<ShellPathResult> {
  const started = Date.now();
  const fs = deps.fs ?? { existsSync, statSync };
  const requested = deps.shell ?? process.env.SHELL ?? DEFAULT_SHELL;
  const shell = isAbsolute(requested) && fs.existsSync(requested) ? requested : DEFAULT_SHELL;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn = deps.spawnFn ?? spawn;

  const stdout = await new Promise<string>((resolve, reject) => {
    let out = '';
    let settled = false;
    const child = spawnFn(shell, ['-ilc', 'printf "__HULL_PATH__%s" "$PATH"'], {
      env: deps.env ?? process.env,
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      reject(new Error(`读取 shell PATH 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      out += chunk.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out);
    });
  });

  // rc 文件可能在命令前后打印噪声：取最后一个标记之后的内容
  const at = stdout.lastIndexOf(MARKER);
  if (at < 0) throw new Error('shell 未返回 PATH');

  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const part of stdout.slice(at + MARKER.length).split(delimiter)) {
    const dir = part.trim();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) dirs.push(dir);
    } catch {
      /* 权限/竞态：跳过 */
    }
  }
  if (dirs.length === 0) throw new Error('shell 未返回可用 PATH');
  return { shell, dirs, elapsedMs: Date.now() - started };
}
