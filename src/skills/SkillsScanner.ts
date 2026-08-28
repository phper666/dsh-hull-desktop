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
import { parseFrontmatter, type Frontmatter } from './frontmatter';
import { lintSkill } from './lint';
import { computeGitBlobSignature, fetchGitTreeImpl, RemoteSigCache, repoKey, signatureFromTreeEntries, type FetchGitTree } from './gitTree';
import { ladderRemoteHash, type LadderPending } from './remoteHash';
import { REGISTRY, SHARED_DIR } from './registry';
import { createNodeFsOps, type SkillFsOps } from './SkillFsOps';
import { resolveSource, type LockEntry } from './sourceResolver';
import { searchRemote as searchRemoteImpl, type SearchRemoteOptions } from './searchRemote';
import { installRemote as installRemoteImpl, type InstallRemoteOptions } from './installRemote';
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
  /** P0-1 tree 拉取注入（生产默认主进程 net.fetch；测试注入 mock） */
  fetchTree?: FetchGitTree;
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
  /** 已解析 frontmatter（P0-2 lint 数据源） */
  fm: Frontmatter;
  locations: DraftLocation[];
}

/** P0-1 后台预取条目（name + 梯子 pending 的 GitHub 定位 + 本地 realPath 供 git 签名对照） */
interface PendingSig extends LadderPending {
  name: string;
  /** 本地 realPath：预取时计算 git blob 签名与远端 tree 签名对照 */
  realPath: string;
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class SkillsScanner {
  private readonly ops: SkillFsOps;
  private readonly homeDir: string;
  private readonly logger: RuntimeLogger;
  private readonly cache: HashCache;
  private readonly userDataPath: string;
  private readonly lockProvider?: () => Record<string, LockEntry>;
  private readonly remoteSigCache: RemoteSigCache;
  private readonly fetchTree: FetchGitTree;
  private lockCache: Record<string, LockEntry> | null = null;
  /** Q-034 二级来源缓存（进程内一次） */
  private arkcliCache: Record<string, string> | null = null;
  /** P0-1 后台预取 promise（waitForPrefetch 测试/主进程钩子；无预取为 null） */
  private prefetchPromise: Promise<void> | null = null;

  private snap: ScanSnapshot = { status: 'idle', entries: [], lastScanAt: null, error: null };
  private scanPromise: Promise<ScanSnapshot> | null = null;
  /** 🟡7：升级成功后的远端哈希覆盖（lock 文件未 bump + 进程内缓存 → 否则重扫永远 upgradable） */
  private readonly hashOverrides = new Map<string, string>();

  /** S2 升级成功后回写：按 name 覆盖远端哈希，使后续重扫收敛 latest */
  applyRemoteHashOverride(name: string, hash: string): void {
    this.hashOverrides.set(name, hash);
  }

  constructor(options: SkillsScannerOptions) {
    this.ops = createNodeFsOps();
    this.homeDir = options.homeDir;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.lockProvider = options.lockProvider;
    this.cache = new HashCache(this.ops.join(options.userDataPath, 'skills', 'hash-cache.json'));
    this.userDataPath = options.userDataPath;
    this.remoteSigCache = new RemoteSigCache(this.ops.join(options.userDataPath, 'skills', 'remote-sig-cache.json'));
    this.fetchTree = options.fetchTree ?? fetchGitTreeImpl;
  }

  /** P0-1 测试/主进程钩子：等待后台 tree 预取完成（无预取立即 resolve） */
  waitForPrefetch(): Promise<void> {
    return this.prefetchPromise ?? Promise.resolve();
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

  /** 远程安装委托（O-3：npx skills add；runner 仅测试/主进程内部可注入） */
  installRemote(skillRef: string, agent: string, opts?: InstallRemoteOptions) {
    return installRemoteImpl(skillRef, agent, opts);
  }

  // ─────────────────────────── 管线 ───────────────────────────

  private async runPipeline(): Promise<ScanSnapshot> {
    try {
      await this.cache.load();
      await this.remoteSigCache.load();
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
                source: resolveSource(fm.metadata.source ?? null),
                fm,
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
      const pendingSigs: PendingSig[] = []; // P0-1：GitHub source 且缓存未命中 → 扫描后后台预取
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
        // ⑥ 远端哈希（Q-034 变更：skills-lock.json 不再读取——历史静态快照无持续生成者；
        //    来源 = lockProvider 注入（仅测试/主进程内部）+ .arkcli 平台 lock（标准位置））
        //    P0-1 梯子（决策 2）：① lock 最高优先 → ② metadata.source(GitHub) → tree 签名（缓存命中）；
        //    未命中记 pending 后台预取（保持同步扫描 <2s），preFetchRemoteSigs 完成后刷新 upgradable
        const l = lock[name];
        const lockHash =
          typeof l?.hash === 'string'
            ? l.hash!
            : typeof l?.content_hash === 'string'
              ? l.content_hash!
              : (this.loadArkcliLock()[name] ?? null);
        const source = preferred.source ?? group.map((g) => g.source).find((v) => v != null) ?? null;
        const override = this.hashOverrides.get(name); // 🟡7：升级成功回写优先于所有来源（收敛 latest）
        let remoteHash: string | null = override ?? lockHash ?? null;
        // 对照哈希：默认 computeDirHash（lock/override 轨）；tree 签名轨须用 git blob 签名（决策 1：算法不兼容）
        let compareHash: string | null = localHash;
        if (remoteHash === null) {
          const ladder = await ladderRemoteHash({
            lockHash: null,
            source,
            cache: this.remoteSigCache,
            fetchTree: this.fetchTree,
            allowFetch: false, // 同步扫描不网络请求（保持 <2s）；未命中记 pending 后台预取
          });
          remoteHash = ladder.remoteHash;
          if (ladder.pending) {
            pendingSigs.push({ name, realPath: preferred.realPath, ...ladder.pending });
          } else if (remoteHash !== null) {
            // 缓存命中（决策 4：直接 latest/upgradable 不触发预取）→ 本地对照须用 git blob 签名
            compareHash = await this.gitSigFor(preferred.realPath);
          }
        }
        const lintResult = lintSkill(preferred.fm); // P0-2：用已解析 frontmatter 产健康度标注（只读）
        entries.push({
          name,
          scope: group.some((d) => isWithinRoots(d.realPath, [agentsDir])) ? 'global' : 'scoped',
          platforms: [...platforms].sort(),
          description: preferred.description ?? group.map((g) => g.description).find((v) => v != null) ?? null,
          source,
          paths,
          localHash,
          remoteHash,
          upgradable:
            localHash && remoteHash ? (compareHash === remoteHash ? 'latest' : 'upgradable') : 'unknown',
          enabled: true, // S1 恒 true（S2 起由 disabled 映射推导）
          lint: lintResult.level ? lintResult : undefined,
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
      // P0-1 扫描完成（不阻塞）→ 后台异步预取远端签名（决策 3：不新增 IPC 面，经快照 polling 推 UI）
      this.prefetchPromise = this.preFetchRemoteSigs(pendingSigs).finally(() => {
        this.prefetchPromise = null;
      });
      return this.snap;
    } catch (err) {
      // 致命错误：保留旧快照，error 带原因（§5.3）
      this.snap = { ...this.snap, status: 'error', error: (err as Error).message };
      return this.snap;
    }
  }

  /** P0-1 本地 git blob 签名（tree 签名轨对照；mtime 缓存命中跳过；键前缀隔离 computeDirHash 条目） */
  private async gitSigFor(realPath: string): Promise<string | null> {
    try {
      const st = await this.ops.stat(realPath);
      return await this.cache.get(`gitblob:${realPath}`, st.mtimeMs, () => computeGitBlobSignature(this.ops, realPath));
    } catch {
      return null;
    }
  }

  /**
   * P0-1 后台异步预取（决策 3）：扫描完成不阻塞；同 {owner,repo,branch} 合并一次 tree 请求、
   * 并发 ≤2、失败静默降级 unknown（下次扫描重试）。完成后写缓存 + 更新快照 upgradable（仅改该字段），
   * refreshing 标志经既有 getSnapshot polling 推 UI（决策 3 约束：不新增 IPC 面）。
   */
  private async preFetchRemoteSigs(pending: PendingSig[]): Promise<void> {
    if (pending.length === 0) return;
    this.snap = { ...this.snap, refreshing: true };
    try {
      // 同 {owner,repo,branch} 合并：共享一次 tree 请求，subPath 各自算签名（16 平台场景请求数收敛到个位数）
      const groups = new Map<string, PendingSig[]>();
      for (const p of pending) {
        const gk = `${p.owner}/${p.repo}#${p.branch}`;
        const g = groups.get(gk) ?? [];
        g.push(p);
        groups.set(gk, g);
      }
      const groupList = [...groups.values()];
      const results = new Map<string, string>(); // name → sig
      const realPathOf = new Map(pending.map((p) => [p.name, p.realPath]));
      let idx = 0;
      const worker = async (): Promise<void> => {
        while (idx < groupList.length) {
          const g = groupList[idx++];
          try {
            const entries = await this.fetchTree(g[0].owner, g[0].repo, g[0].branch);
            for (const p of g) {
              try {
                const sig = signatureFromTreeEntries(entries, p.subPath);
                this.remoteSigCache.set(repoKey(p), sig);
                results.set(p.name, sig);
              } catch (err) {
                this.logger.warn(`[skills] subPath 签名失败（降级 unknown）: ${p.name}: ${(err as Error).message}`);
              }
            }
          } catch (err) {
            // 失败静默降级 unknown（不重试风暴，下次扫描再试）
            this.logger.warn(
              `[skills] tree 预取失败（降级 unknown）: ${g[0].owner}/${g[0].repo}#${g[0].branch}: ${(err as Error).message}`
            );
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, groupList.length) }, worker)); // 并发 ≤2
      await this.remoteSigCache.save().catch(() => this.logger.warn('[skills] remote-sig-cache 持久化失败'));
      for (const [name, sig] of results) {
        const e = this.snap.entries.find((x) => x.name === name);
        const realPath = realPathOf.get(name);
        if (e && realPath) {
          // 对照本地 git blob 签名（决策 1：computeDirHash 算法不兼容，不能直接比）
          const gitSig = await this.gitSigFor(realPath);
          e.remoteHash = sig;
          e.upgradable = gitSig ? (gitSig === sig ? 'latest' : 'upgradable') : 'unknown';
        }
      }
      await this.cache.save().catch(() => this.logger.warn('[skills] hash-cache 持久化失败')); // gitblob 条目落盘
    } finally {
      this.snap = { ...this.snap, refreshing: false };
    }
  }

  /** lock 注入（仅测试/主进程内部）；生产不再读 skills-lock.json（Q-034 变更：远端哈希只依赖标准位置 .arkcli 平台 lock + frontmatter source 推断） */
  private loadLock(): Record<string, LockEntry> {
    if (this.lockProvider) return this.lockProvider();
    return {};
  }

  /** Q-034 二级：平台 lock（<homeDir>/.config/opencode/skills/.arkcli-managed-skills.json，name→sha256）；缺失/坏格式 → {} */
  private loadArkcliLock(): Record<string, string> {
    if (this.arkcliCache === null) {
      this.arkcliCache = {};
      try {
        const p = this.ops.join(this.homeDir, '.config', 'opencode', 'skills', '.arkcli-managed-skills.json');
        if (this.ops.existsSync(p)) {
          const raw = JSON.parse(this.ops.readFileSync(p)) as { skills?: unknown };
          if (raw && typeof raw.skills === 'object' && raw.skills !== null) {
            for (const [k, v] of Object.entries(raw.skills as Record<string, unknown>)) {
              if (typeof v === 'string' && v) this.arkcliCache[k] = v;
            }
          }
        }
      } catch {
        this.arkcliCache = {}; // malformed → 防御性回退
      }
    }
    return this.arkcliCache;
  }
}
