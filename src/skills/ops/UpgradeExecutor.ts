/**
 * 升级执行器（CON-R-skills-004 + Q-033/Q-034，设计 D3）
 * 前置主进程强制：remoteHash=unknown → skills-upgrade-undetectable；非 upgradable → validation-error。
 * 执行分级：npx skills update（O-2 待实测，失败/无效果自动降级）→ git clone staging →
 * 两段 rename 原子替换（backup manifest 支持启动自愈）→ 失败回滚保留原版本。
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { NOOP_LOGGER, type RuntimeLogger } from '../../shared/types';

import type { SkillFsOps } from '../SkillFsOps';
import {
  SkillValidationError,
  SkillsIoError,
  SkillsNotFoundError,
  SkillsUpgradeFailedError,
  SkillsUpgradeUndetectableError,
} from '../errors';
import { computeDirHash } from '../hash';
import { parseFrontmatter } from '../frontmatter';
import type { SkillsScanner } from '../SkillsScanner';
import type { OperationLog } from './OperationLog';

const GIT_CLONE_TIMEOUT_MS = 120_000; // 契约：npx/git 子进程超时上限 120s

export interface UpgradeRunners {
  /** npx skills update 注入点（cwd=skill 所在目录；成功且内容变化才算命中，否则降级） */
  npxUpdate?: (cwd: string, skillName: string) => Promise<void>;
  /** git clone 注入点（测试 fake / 生产默认 spawn） */
  gitClone?: (repoUrl: string, dest: string, branch?: string) => Promise<void>;
}

export interface UpgradeExecutorDeps {
  ops: SkillFsOps;
  base: string; // <userData>/skills
  scanner: SkillsScanner;
  log: OperationLog;
  logger?: RuntimeLogger;
}

interface BackupManifest {
  version: number;
  entries: Array<{ backupDir: string; originalPath: string; at: string }>;
}

/** github URL → { repoUrl, branch, subPath }（tree URL 还原为可 clone 形态） */
export function parseGithubSource(src: string): { repoUrl: string; branch?: string; subPath?: string } {
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/tree\/([^/\s]+)((?:\/.*)?))?$/i.exec(src);
  if (m) {
    return {
      repoUrl: `https://github.com/${m[1]}/${m[2]}.git`,
      branch: m[3],
      subPath: m[4] ? m[4].replace(/^\//, '').replace(/\/$/, '') || undefined : undefined,
    };
  }
  if (/^https:\/\/.+/.test(src)) return { repoUrl: src }; // 非 github https 来源尽力 clone
  throw new Error(`无法解析的来源 URL: ${src}`);
}

function defaultGitClone(repoUrl: string, dest: string, branch?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['clone', '--depth', '1', ...(branch ? ['--branch', branch] : []), repoUrl, dest];
    const child = spawn('git', args, { signal: AbortSignal.timeout(GIT_CLONE_TIMEOUT_MS) });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git clone 退出码 ${code}: ${stderr.slice(-200)}`))));
  });
}

export class UpgradeExecutor {
  private readonly ops: SkillFsOps;
  private readonly stagingDir: string;
  private readonly manifestFile: string;
  private readonly logger: RuntimeLogger;
  private readonly runners: UpgradeRunners;

  constructor(
    private readonly deps: UpgradeExecutorDeps,
    runners?: UpgradeRunners
  ) {
    this.ops = deps.ops;
    this.stagingDir = deps.ops.join(deps.base, 'staging');
    this.manifestFile = deps.ops.join(this.stagingDir, 'backups.json');
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.runners = runners ?? {};
  }

  private findEntry(physPath: string) {
    return this.deps.scanner.snapshot().entries.find((e) => e.paths.some((p) => p.path === physPath));
  }

  // ── backup manifest（两段 rename 窗口崩溃的自愈依据）──

  private loadManifest(): BackupManifest {
    try {
      if (this.ops.existsSync(this.manifestFile)) {
        const parsed = JSON.parse(this.ops.readFileSync(this.manifestFile)) as BackupManifest;
        if (parsed && Array.isArray(parsed.entries)) return parsed;
      }
    } catch {
      /* 损坏按空重建 */
    }
    return { version: 1, entries: [] };
  }

  private saveManifest(m: BackupManifest): void {
    this.ops.writeFileSyncAtomic(this.manifestFile, JSON.stringify(m));
  }

  /** 启动自愈：backup 残留 + 原路径空缺 → 自动还原 + 日志（设计 §4.1） */
  selfHeal(): void {
    const m = this.loadManifest();
    for (const item of m.entries) {
      try {
        if (!this.ops.existsSync(item.originalPath) && this.ops.existsSync(item.backupDir)) {
          this.ops.renameSync(item.backupDir, item.originalPath);
          this.deps.log.append({
            ts: new Date().toISOString(),
            action: 'restore',
            paths: [item.originalPath],
            result: 'success',
            detail: { selfHeal: true, backupDir: item.backupDir },
          });
        } else {
          this.logger.warn(`[skills] staging backup 残留（原路径占用或缺失），留待人工处理: ${item.backupDir}`);
        }
      } catch (err) {
        this.logger.warn(`[skills] 自愈失败: ${(err as Error).message}`);
      }
    }
    this.saveManifest({ version: 1, entries: [] });
  }

  /**
   * 升级一个物理路径。调用方（SkillsOps 门面）已完成路径校验+单飞+mtime 守卫。
   * 返回 { path, method, newHash }；失败一律抛具名错误（已回滚）。
   */
  async upgrade(physPath: string): Promise<{ path: string; method: 'npx-skills-update' | 'git-staging'; newHash: string }> {
    const entry = this.findEntry(physPath);
    if (!entry) throw new SkillsNotFoundError('目标路径不存在，请刷新');
    if (!entry.remoteHash) throw new SkillsUpgradeUndetectableError('无法检测版本（无 source 且无 lock），升级入口禁用');
    if (entry.upgradable !== 'upgradable') {
      throw new SkillValidationError('当前不是可升级状态（本地与远端一致），请刷新', 'path');
    }

    // 分级 a：npx skills update（O-2 单路径语义待实测——失败或无效果都降级 git-staging）
    if (this.runners.npxUpdate) {
      try {
        await this.runners.npxUpdate(this.ops.dirname(physPath), entry.name);
        const hashAfterNpx = await computeDirHash(this.ops, physPath).catch(() => null);
        if (hashAfterNpx && hashAfterNpx !== entry.localHash) {
          this.deps.log.append({
            ts: new Date().toISOString(),
            action: 'upgrade',
            paths: [physPath],
            result: 'success',
            detail: { method: 'npx-skills-update' },
          });
          return { path: physPath, method: 'npx-skills-update', newHash: hashAfterNpx };
        }
        this.logger.warn('[skills] npx update 无内容变化，降级 git-staging');
      } catch (err) {
        this.logger.warn(`[skills] npx update 失败，降级 git-staging: ${(err as Error).message}`);
      }
    }

    // 分级 b/c：git clone 到 staging → 原子替换（source-fetch 与 git-staging 同为 clone 实现，
    // method 记 git-staging；纯非 git http 来源 v1 不支持——见方案偏离记录）
    const workdir = this.ops.join(this.stagingDir, `u_${randomUUID()}`);
    try {
      if (!entry.source) throw new Error('无可获取的来源 URL');
      const { repoUrl, branch, subPath } = parseGithubSource(entry.source);
      // 🔴2：subPath 段白名单——恶意 SKILL.md metadata.source 可携 ../ 逃逸 staging（Q-038）
      if (subPath && subPath.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
        throw new SkillValidationError('来源 URL 含非法路径段（..）', 'source');
      }
      const repoDest = this.ops.join(workdir, 'repo');
      const clone = this.runners.gitClone ?? defaultGitClone;
      this.ops.mkdirSync(workdir);
      await clone(repoUrl, repoDest, branch);

      // 完整性校验：SKILL.md 存在 + frontmatter name 一致（契约 ③）
      const payload = subPath ? this.ops.join(repoDest, subPath) : repoDest;
      // 🔴2 纵深防御：realpath(payload) 必须落于 realpath(repoDest) 域内
      const realPayload = await this.ops.realpath(payload).catch(() => null);
      const realRepo = await this.ops.realpath(repoDest).catch(() => null);
      if (!realPayload || !realRepo || !(realPayload === realRepo || realPayload.startsWith(realRepo + '/'))) {
        throw new Error('payload 越出 staging 克隆域（路径校验失败）');
      }
      const skillMdPath = this.ops.join(payload, 'SKILL.md');
      if (!this.ops.existsSync(skillMdPath)) throw new Error('新版本缺少 SKILL.md');
      const fmName = parseFrontmatter(await this.ops.readFile(skillMdPath)).name;
      if (fmName !== entry.name) throw new Error(`新版本 name 不一致（${fmName} ≠ ${entry.name}）`);

      // 原子替换：原目录 rename → backup（manifest 登记）；staging payload rename → 原路径
      const backupDir = `${workdir}.backup`;
      const manifest = this.loadManifest();
      manifest.entries.push({ backupDir, originalPath: physPath, at: new Date().toISOString() });
      this.saveManifest(manifest);
      this.ops.renameSync(physPath, backupDir); // ① 原版让位（严格 rename，禁 copy）
      try {
        this.ops.renameSync(payload, physPath); // ② 新版就位
      } catch (err) {
        // 🟡5：回滚自身失败 → skills-io-error（不虚报 rolledBack），manifest 条目保留供自愈
        try {
          this.ops.renameSync(backupDir, physPath); // 回滚原版本
        } catch (rbErr) {
          this.deps.log.append({
            ts: new Date().toISOString(),
            action: 'upgrade',
            paths: [physPath],
            result: 'failed',
            detail: { method: 'git-staging', rolledBack: false, rollbackFailed: true, error: (err as Error).message, rollbackError: (rbErr as Error).message },
          });
          throw new SkillsIoError(
            `升级失败且自动回滚失败，请手动处理（原版备份于 ${backupDir}）: ${(rbErr as Error).message}`
          );
        }
        manifest.entries = manifest.entries.filter((e) => e.backupDir !== backupDir);
        this.saveManifest(manifest);
        this.ops.rmRecursiveSync(workdir);
        this.deps.log.append({
          ts: new Date().toISOString(),
          action: 'upgrade',
          paths: [physPath],
          result: 'failed',
          detail: { method: 'git-staging', rolledBack: true, error: (err as Error).message },
        });
        throw new SkillsUpgradeFailedError(`升级替换失败已回滚: ${(err as Error).message}`, 'git-staging', true);
      }
      manifest.entries = manifest.entries.filter((e) => e.backupDir !== backupDir);
      this.saveManifest(manifest);
      this.ops.rmRecursiveSync(backupDir);
      this.ops.rmRecursiveSync(workdir);

      const newHash = (await computeDirHash(this.ops, physPath))!;
      this.deps.log.append({
        ts: new Date().toISOString(),
        action: 'upgrade',
        paths: [physPath],
        result: 'success',
        detail: { method: 'git-staging' },
      });
      return { path: physPath, method: 'git-staging', newHash };
    } catch (err) {
      if (err instanceof SkillsUpgradeFailedError || err instanceof SkillsUpgradeUndetectableError || err instanceof SkillValidationError || err instanceof SkillsNotFoundError || err instanceof SkillsIoError) {
        throw err; // SkillsIoError：回滚自身失败语义（🟡5），不得包装成 rolledBack=true
      }
      this.ops.rmRecursiveSync(workdir); // 清理半成品
      this.deps.log.append({
        ts: new Date().toISOString(),
        action: 'upgrade',
        paths: [physPath],
        result: 'failed',
        detail: { method: 'git-staging', rolledBack: true, error: (err as Error).message },
      });
      throw new SkillsUpgradeFailedError(`升级失败已回滚: ${(err as Error).message}`, 'git-staging', true);
    }
  }
}
