import type { InstallErrorCode } from '../OverlayManager';
import type { ChildLike, RuntimeLogger } from '../../shared/types';

/** 包管理器名（settings.packageManager 二选一；P3 接设置页字段；yarn 已移除——peerDependencies 不兼容） */
export type PkgMgrName = 'npm' | 'pnpm';

/** 安装结果（两实现统一返回；错误码复用 InstallErrorCode 六码子集） */
export interface PkgMgrResult {
  ok: boolean;
  /** 失败时的错误码（registry-unreachable / npm-install-failed / cancelled） */
  code?: InstallErrorCode;
  error?: string;
}

/** 单次 install 运行选项（registry/onLine 随调用传入——main 注入 settings.registry + 输出接线） */
export interface PkgMgrRunOptions {
  /** registry 源（settings.registry；空串 → env HULL_REGISTRY 兜底） */
  registry: string;
  /** 逐行输出回调（进度 + 落盘） */
  onLine?: (line: string) => void;
}

/** 包管理器执行器：install 装到 staging + cancel 杀完整进程树 */
export interface PkgMgrRunner {
  install(stagingDir: string, targetVersion: string, opts: PkgMgrRunOptions): Promise<PkgMgrResult>;
  cancel(): void;
}

/** spawn 最小选项（原 NpmSpawnOptions 泛化——两实现共用；仅 stderr/stdout 管道） */
export interface PkgMgrSpawnOptions {
  cwd: string;
  stdio: ['ignore', 'pipe', 'pipe'];
  env: NodeJS.ProcessEnv;
}

export type PkgMgrSpawnFn = (command: string, args: readonly string[], options: PkgMgrSpawnOptions) => ChildLike;

/** 执行器构造选项（两实现共用；测试可注入 spawn/clock/sleep/package.json 写入） */
export interface PkgMgrRunnerOptions {
  /** 捆绑 node 二进制路径（npm 实现经其推导 npm-cli.js；pnpm 经其推导 corepack，走捆绑 corepack 脱离用户环境） */
  nodePath: string;
  /** COREPACK_HOME（A 方案：corepack 缓存目录，壳控；<userData>/corepack 可随壳预置/预下载；缺省 → 用户默认缓存） */
  corepackHome?: string;
  logger?: RuntimeLogger;
  /** spawn 注入（默认 child_process.spawn） */
  spawnFn?: PkgMgrSpawnFn;
  /** 时钟（超时预算 seam） */
  now?: () => number;
  /** 休眠（kill 宽限 seam） */
  sleep?: (ms: number) => Promise<void>;
  /** staging 根 package.json 写入（pnpm 需先有 package.json；测试注入 no-op） */
  writePkgJson?: (stagingDir: string) => void;
}
