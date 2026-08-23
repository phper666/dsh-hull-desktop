/**
 * SkillFsOps 抽象层（Q-037，设计 D3）：S1 只读面 + S2 写面 fs 访问收敛接口。
 * 注入点 = homeDir（生产 os.homedir()，测试 mkdtemp 临时目录树 + 真实 symlink）。
 */
import {
  basename as pbasename,
  join as pjoin,
  normalize as pnormalize,
} from 'node:path';
import { readdir, readFile, stat, lstat, realpath } from 'node:fs/promises';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

export interface StatInfo {
  mtimeMs: number;
  size: number;
  isDirectory(): boolean;
}

export interface LstatInfo {
  isSymbolicLink(): boolean;
}

export interface SkillFsOps {
  join(...parts: string[]): string;
  dirname(p: string): string;
  basename(p: string): string;
  normalize(p: string): string;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<StatInfo>;
  lstat(path: string): Promise<LstatInfo>;
  readFile(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  /** temp+rename 原子写（SettingsProvider.set 先例；父目录自动创建） */
  writeFileSyncAtomic(path: string, data: string): void;
  /** 严格 rename（同卷原子；升级两段替换必须用它，禁 copy 降级） */
  renameSync(from: string, to: string): void;
  /** move 带 EXDEV 跨卷降级：rename 失败 → cp+verify+rm（回收站/禁用搬移用）；可返回 Promise（测试门控） */
  moveSync(from: string, to: string): void | Promise<void>;
  mkdirSync(path: string): void;
  cpSync(from: string, to: string): void;
  readlinkSync(path: string): string;
  symlinkSync(target: string, path: string): void;
  rmRecursiveSync(path: string): void;
  unlinkSync(path: string): void;
}

/** 生产实现：node fs 薄封装（api 自引用——测试包装 renameSync 时 moveSync 降级路径同步生效） */
export function createNodeFsOps(): SkillFsOps {
  const api: SkillFsOps = {
    join: (...parts) => pjoin(...parts),
    dirname: (p) => pjoin(p, '..'),
    basename: (p) => pbasename(p),
    normalize: (p) => pnormalize(p),
    readdir: (p) => readdir(p),
    stat: (p) => stat(p),
    lstat: (p) => lstat(p),
    readFile: (p) => readFile(p, 'utf8'),
    realpath: (p) => realpath(p),
    existsSync: (p) => existsSync(p),
    readFileSync: (p) => readFileSync(p, 'utf8'),
    writeFileSyncAtomic: (filePath, data) => {
      mkdirSync(pjoin(filePath, '..'), { recursive: true });
      const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, data, 'utf8');
      renameSync(tmp, filePath);
    },
    renameSync: (from, to) => renameSync(from, to),
    moveSync: (from, to) => {
      try {
        api.renameSync(from, to);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        // 跨卷降级：copy → 存在性校验 → 删源（copy 中途失败抛错，源保留）
        cpSync(from, to, { recursive: true });
        if (!existsSync(to)) throw err;
        rmSync(from, { recursive: true, force: true });
      }
    },
    mkdirSync: (p) => mkdirSync(p, { recursive: true }),
    cpSync: (from, to) => cpSync(from, to, { recursive: true }),
    readlinkSync: (p) => readlinkSync(p),
    symlinkSync: (target, path) => symlinkSync(target, path, 'dir'),
    rmRecursiveSync: (p) => rmSync(p, { recursive: true, force: true }),
    unlinkSync: (p) => unlinkSync(p),
  };
  return api;
}
