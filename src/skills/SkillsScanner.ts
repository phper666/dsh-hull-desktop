/**
 * Skills 扫描管线门面（设计 D2/D4/§4.1/§4.2，契约 §核心流程）
 * 状态机 idle→scanning→ready/error；幂等触发；快照原子替换（旧快照持续可读）；
 * 七步管线：注册表遍历 → realpath 解析去重 → frontmatter 解析 → 来源三级降级 →
 * 本地哈希（mtime 缓存）→ 远端哈希 → 按 name 聚合。
 * 单目录/单条目异常 = 降级跳过不阻塞；仅致命错误（userData 不可写）→ status=error 保留旧快照。
 */
import { NOOP_LOGGER, type RuntimeLogger } from '../shared/types';

import { HashCache, computeDirHash } from './hash';
import { isValidSkillName, isWithinRoots } from './pathGuard';
import { parseFrontmatter } from './frontmatter';
import { REGISTRY, SHARED_DIR } from './registry';
import { createNodeFsOps, type SkillFsOps } from './SkillFsOps';
import { parseSkillsLock, resolveSource, type LockEntry } from './sourceResolver';
import { searchRemote as searchRemoteImpl, type SearchRemoteOptions } from './searchRemote';
import { loadDisabledEntries } from './ops/DisableManager';
import type { PathInfo, ScanSnapshot, SkillEntry, StatusCounts } from './types';

export interface SkillsScannerOptions {
  /** 注入点（Q-037）：生产 os.homedir()，测试 mkdtemp 临时目录树 */
  homeDir: string;
  /** userData 根（hash-cache.json 落点 <userData>/skills/hash-cache.json） */
  userDataPath: string;
  logger?: RuntimeLogger;
  /** lock 数据注入（默认读 <homeDir>/AI/skills-lock.json，防御性解析） */
  lockProvider?: () => Record<string, LockEntry>;
}

interface DraftLocation {
  physPath: string;
  isSymlink: boolean;
  mtimeMs: number;
  affectedPlatforms: string[];
}

interface Draft {
  name: string;
  realPath: string;
  description: string | null;
  source: string | null;
  locations: DraftLocation[];
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class SkillsScanner {
  private readonly ops: SkillFsOps;
  private readonly homeDir: string;
  private readonly logger: RuntimeLogger;
  private readonly cache: HashCache;
  private readonly userDataPath: string;
  private readonly lockProvider?: () => Record<string, LockEntry>;
  private lockCache: Record<string, LockEntry> | null = null;

  private snap: ScanSnapshot = { status: 'idle', entries: [], lastScanAt: null, error: null };
  private scanPromise: Promise<ScanSnapshot> | null = null;

  constructor(options: SkillsScannerOptions) {
    this.ops = createNodeFsOps();
    this.homeDir = options.homeDir;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.lockProvider = options.lockProvider;
    this.cache = new HashCache(this.ops.join(options.userDataPath, 'skills', 'hash-cache.json'));
    this.userDataPath = options.userDataPath;
  }

  /** 当前快照（内存读；scanning 中返回上次 ready 快照或空） */
  snapshot(): ScanSnapshot {
    return this.snap;
  }

  /** 状态栏计数（快照派生；未就绪全 0） */
  statusCounts(): StatusCounts {
    const entries = this.snap.entries;
    return {
      total: entries.length,
      upgradable: entries.filter((e) => e.upgradable === 'upgradable').length,
      disabled: entries.filter((e) => !e.enabled).length,
      global: entries.filter((e) => e.scope === 'global').length,
    };
  }

  /** 触发后台扫描（幂等：scanning 中重复调用返回同一管线结果，不重启） */
  async scan(): Promise<ScanSnapshot> {
    if (this.scanPromise) return this.scanPromise;
    this.snap = { ...this.snap, status: 'scanning', error: null };
    this.scanPromise = this.runPipeline().finally(() => {
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  /** 远程搜索委托（renderer 经 IPC 消费；runner 仅测试/主进程内部可注入） */
  searchRemote(query: string, opts?: SearchRemoteOptions) {
    return searchRemoteImpl(query, opts);
  }

  // ─────────────────────────── 管线 ───────────────────────────

  private async runPipeline(): Promise<ScanSnapshot> {
    try {
      await this.cache.load();
      const lock = this.loadLock();
      // macOS tmpdir 经 /var→/private/var symlink——scope 判定基准目录须同样 realpath 规范化
      const agentsDir = await this.ops
        .realpath(this.ops.join(this.homeDir, SHARED_DIR))
        .catch(() => this.ops.join(this.homeDir, SHARED_DIR));

      // ①②③ 遍历注册表 → realpath 解析去重 → frontmatter 解析
      const draftsByReal = new Map<string, Draft>();
      for (const reg of REGISTRY) {
        const absDir = this.ops.join(this.homeDir, reg.dir);
        let children: string[];
        try {
          children = (await this.ops.readdir(absDir)).sort();
        } catch {
          continue; // 目录不存在/不可读 → 跳过（UI 计数 0 标「未安装」，降级非错误）
        }
        for (const child of children) {
          try {
            if (!isValidSkillName(child)) {
              this.logger.warn(`[skills] 非法目录名跳过: ${child}`);
              continue;
            }
            const phys = this.ops.join(absDir, child);
            const lstat = await this.ops.lstat(phys);
            let real: string;
            try {
              real = await this.ops.realpath(phys); // symlink 循环/悬空在此抛错
            } catch {
              this.logger.warn(`[skills] realpath 失败跳过（循环/悬空）: ${phys}`);
              continue;
            }
            if (!isValidSkillName(this.ops.basename(real))) {
              this.logger.warn(`[skills] basename(realpath) 校验失败跳过: ${real}`);
              continue;
            }
            const st = await this.ops.stat(real);
            if (!st.isDirectory()) continue;

            const fmContent = await this.ops.readFile(this.ops.join(real, 'SKILL.md')).catch(() => null);
            const fm = parseFrontmatter(fmContent ?? '');
            const existing = draftsByReal.get(real);
            if (existing) {
              existing.locations.push({
                physPath: phys,
                isSymlink: lstat.isSymbolicLink(),
                mtimeMs: st.mtimeMs,
                affectedPlatforms: [...reg.affectedPlatforms],
              });
            } else {
              draftsByReal.set(real, {
                name: fm.name ?? child,
                realPath: real,
                description: fm.description,
                source: resolveSource(fm.metadata.source ?? null, lock[fm.name ?? child] ?? null),
                locations: [
                  {
                    physPath: phys,
                    isSymlink: lstat.isSymbolicLink(),
                    mtimeMs: st.mtimeMs,
                    affectedPlatforms: [...reg.affectedPlatforms],
                  },
                ],
              });
            }
          } catch (err) {
            this.logger.warn(`[skills] 条目异常跳过: ${child} ${(err as Error).message}`);
          }
        }
        await yieldToLoop(); // 分批让出事件循环（FR-10 不卡 UI）
      }

      // ⑦ 按 name 二次聚合（跨目录同名合并）
      const byName = new Map<string, Draft[]>();
      for (const draft of draftsByReal.values()) {
        const group = byName.get(draft.name) ?? [];
        group.push(draft);
        byName.set(draft.name, group);
      }

      // ⑤ 本地哈希（mtime 缓存命中跳过）
      const hashFor = async (realPath: string): Promise<string | null> => {
        try {
          const st = await this.ops.stat(realPath);
          return await this.cache.get(realPath, st.mtimeMs, () => computeDirHash(this.ops, realPath));
        } catch {
          return null;
        }
      };

      const entries: SkillEntry[] = [];
      for (const [name, group] of byName) {
        const preferred =
          group.find((d) => isWithinRoots(d.realPath, [agentsDir])) ?? group[0]; // 全局路径优先（§5.3）
        const platforms = new Set<string>();
        for (const d of group) for (const l of d.locations) for (const p of l.affectedPlatforms) platforms.add(p);
        const paths: PathInfo[] = group.flatMap((d) =>
          d.locations.map((l) => ({
            path: l.physPath,
            isSymlink: l.isSymlink,
            mtimeMs: l.mtimeMs,
            affectedPlatforms: l.affectedPlatforms,
          }))
        );
        const localHash = await hashFor(preferred.realPath);
        for (const d of group) {
          if (d.realPath !== preferred.realPath) await hashFor(d.realPath); // 其余路径哈希预热进缓存
        }
        // ⑥ 远端哈希（Q-034 一级：skills-lock.json hash/content_hash）
        //    ponytail: ②平台 lock/③cc-switch(sqlite)/④git remote clone 待「远端哈希口径实测」协调项关闭后接入——
        //    未验证口径的对比比 unknown 更危险，缺省 unknown 语义保守正确（契约协调事项「远端哈希口径」待定）
        const remoteHash = typeof lock[name]?.hash === 'string' ? lock[name].hash! : typeof lock[name]?.content_hash === 'string' ? lock[name].content_hash! : null;
        entries.push({
          name,
          scope: group.some((d) => isWithinRoots(d.realPath, [agentsDir])) ? 'global' : 'scoped',
          platforms: [...platforms].sort(),
          description: preferred.description ?? group.map((g) => g.description).find((v) => v != null) ?? null,
          source: preferred.source ?? group.map((g) => g.source).find((v) => v != null) ?? null,
          paths,
          localHash,
          remoteHash,
          upgradable:
            localHash && remoteHash ? (localHash === remoteHash ? 'latest' : 'upgradable') : 'unknown',
          enabled: true, // S1 恒 true（S2 起由 disabled 映射推导）
        });
        await yieldToLoop();
      }

      entries.sort((a, b) => a.name.localeCompare(b.name));

      // S2：enabled 聚合推导（契约 SkillEntry.enabled——S2 起由 disabled.json 映射推导：
      // 任一物理路径被禁用 → 条目 enabled=false；无映射文件时恒 true，S1 行为不变）
      const disabledNames = new Set(
        loadDisabledEntries(this.ops, this.ops.join(this.userDataPath, 'skills', 'disabled.json')).map((d) => d.skillName)
      );
      for (const e of entries) if (disabledNames.has(e.name)) e.enabled = false;

      // 原子替换快照（旧快照持续可读）+ 缓存持久化（userData 不可写 = 致命错误语义）
      await this.cache.save();
      this.snap = { status: 'ready', entries, lastScanAt: new Date().toISOString(), error: null };
      return this.snap;
    } catch (err) {
      // 致命错误：保留旧快照，error 带原因（§5.3）
      this.snap = { ...this.snap, status: 'error', error: (err as Error).message };
      return this.snap;
    }
  }

  private loadLock(): Record<string, LockEntry> {
    if (this.lockProvider) return this.lockProvider();
    if (this.lockCache === null) {
      try {
        const p = this.ops.join(this.homeDir, 'AI', 'skills-lock.json');
        this.lockCache = this.ops.existsSync(p) ? parseSkillsLock(this.ops.readFileSync(p)) : {};
      } catch {
        this.lockCache = {};
      }
    }
    return this.lockCache;
  }
}
