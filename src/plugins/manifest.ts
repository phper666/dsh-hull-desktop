/**
 * P3 安装预览（设计 §1.5 / 契约 §PluginPreview，Q-106）：
 *   npm pack <url> 到临时目录（只读解析，不安装）→ 读 package.json#dsh.bundle + cordis.patch.yml
 *   → 摘要 PluginPreview。解析失败 → previewUnavailable 标记（不阻断安装，R4）；临时目录用完即清（finally）。
 * 安全：不传任何放开 build script 的参数（设计 §4.4）；预览只读，不落 DSH_HOME。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import type { PluginPreview } from './types';

/** 解析结果 = PluginPreview + 可用性标记（契约 §PluginPreview 约束列；类型以 lane types.ts 为准，交集兼容字段有无） */
type PreviewResult = PluginPreview & { previewUnavailable: boolean };

export interface PackResult {
  ok: boolean;
  /** 解包后的内容根（npm tarball 含 package/ 前缀） */
  dir: string | null;
  message?: string;
}

export interface PreviewOptions {
  /** npm pack + 解包执行器（注入可测；缺省走真实 npm/tar，无新依赖） */
  pack?: (spec: string, targetDir: string) => Promise<PackResult>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
let packSeq = 0;

export async function previewBundle(url: string, tmpRoot: string, opts: PreviewOptions = {}): Promise<PluginPreview> {
  const pack = opts.pack ?? defaultPack(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const workDir = join(tmpRoot, `plugin-preview-${Date.now()}-${++packSeq}`);
  try {
    mkdirSync(workDir, { recursive: true });
    const r = await pack(url, workDir);
    if (!r.ok || !r.dir) return unavailable(url, r.message);
    const pkg = readPackageJson(r.dir);
    if (!pkg) return unavailable(url, 'package.json 缺失或无法解析');

    const patchFile = locatePatchYml(pkg, r.dir);
    const patchSummary = patchFile ? summarizePatch(readFileSync(patchFile, 'utf8')) : null;

    return {
      id: pkg.name ?? 'unknown',
      version: pkg.version ?? 'unknown',
      patchSummary,
      sourceUrl: url,
      previewUnavailable: patchSummary === null,
    };
  } catch (err) {
    return unavailable(url, err instanceof Error ? err.message : String(err));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function unavailable(sourceUrl: string, message?: string): PreviewResult {
  return { id: 'unknown', version: 'unknown', patchSummary: null, sourceUrl, previewUnavailable: true };
}

/** package.json 容错读取（JSON 解析失败 → null） */
function readPackageJson(pkgRoot: string): { name?: string; version?: string; dsh?: unknown } | null {
  const p = join(pkgRoot, 'package.json');
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    return {
      name: typeof raw.name === 'string' ? raw.name : undefined,
      version: typeof raw.version === 'string' ? raw.version : undefined,
      dsh: raw.dsh,
    };
  } catch {
    return null;
  }
}

/**
 * 定位 patch 定义文件：优先 package.json#dsh.bundle（string=文件路径 / object.cordisPatch），
 * 缺省回退包根 cordis.patch.yml（dsh-market 惯例）。不存在 → null（预览不可用，不阻断）。
 * 路径穿越防护（🟡）：resolve 后必须落在 pkgRoot 内（拒 `..` / 绝对路径越界）。
 */
function locatePatchYml(pkg: { dsh?: unknown }, pkgRoot: string): string | null {
  const dsh = pkg.dsh;
  let rel: unknown = 'cordis.patch.yml';
  if (typeof dsh === 'string') rel = dsh;
  else if (typeof dsh === 'object' && dsh !== null) {
    const bundle = (dsh as Record<string, unknown>).bundle;
    if (typeof bundle === 'string') rel = bundle;
    else if (typeof bundle === 'object' && bundle !== null) {
      rel = (bundle as Record<string, unknown>).cordisPatch ?? rel;
    }
  }
  if (typeof rel !== 'string' || rel.length === 0) return null;
  const root = resolve(pkgRoot);
  const p = resolve(root, rel);
  // resolve 归一后仍须在包根内（pkgRoot 本身或子路径）；`..`/绝对路径越界 → 拒绝
  if (p !== root && !p.startsWith(root + sep)) return null;
  return existsSync(p) ? p : null;
}

/**
 * cordis.patch.yml 摘要：收集 `- path:` 修改条目 → 文件清单摘要。
 * ponytail: 行扫描启发式（项目禁新增 yaml 依赖）；结构无法识别 → null（previewUnavailable），安装不阻断。
 */
function summarizePatch(yamlText: string): string | null {
  const paths: string[] = [];
  for (const line of yamlText.split('\n')) {
    const m = /^\s*-\s*path:\s*['"]?([^'"]+)['"]?\s*$/.exec(line);
    if (m) paths.push(m[1]);
  }
  if (paths.length === 0) return null;
  const shown = paths.slice(0, 3).join('、');
  return paths.length > 3 ? `将修改 ${shown} 等 ${paths.length} 处` : `将修改 ${shown}（共 ${paths.length} 处）`;
}

/** 默认 pack 执行器：npm pack --json → tar 解包（macOS/Linux 原生 tar；Win10+ 自带 bsdtar） */
function defaultPack(timeoutMs: number) {
  return async (spec: string, targetDir: string): Promise<PackResult> => {
    try {
      mkdirSync(targetDir, { recursive: true });
      const stdout = await execFileOut('npm', ['pack', spec, '--pack-destination', targetDir, '--json'], timeoutMs);
      const parsed = JSON.parse(stdout) as unknown;
      const filename =
        Array.isArray(parsed) && parsed.length > 0 ? (parsed[0] as { filename?: unknown }).filename : null;
      if (typeof filename !== 'string') return { ok: false, dir: null, message: 'npm pack 输出无法解析（无 tarball 名）' };
      await execFileOut('tar', ['-xzf', join(targetDir, filename), '-C', targetDir], timeoutMs);
      return { ok: true, dir: join(targetDir, 'package') };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, dir: null, message };
    }
  };
}

/** execFile 严格类型包装（encoding=utf8 → stdout 为 string；错误含 stderr 摘要） */
function execFileOut(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES, encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        const message = err instanceof Error ? `${err.message}${'stderr' in err ? `：${String((err as { stderr?: string | Buffer }).stderr ?? '')}` : ''}` : String(err);
        reject(new Error(message));
      } else {
        resolve(stdout);
      }
    });
  });
}
