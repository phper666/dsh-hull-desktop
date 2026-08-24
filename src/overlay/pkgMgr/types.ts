import type { InstallErrorCode } from '../OverlayManager';
import type { ChildLike, RuntimeLogger } from '../../shared/types';

/** 包管理器名（settings.packageManager 三选一；P3 接设置页字段） */
export type PkgMgrName = 'npm' | 'pnpm' | 'yarn';

/** 安装结果（三实现统一返回；错误码复用 InstallErrorCode 六码子集） */
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

/** spawn 最小选项（原 NpmSpawnOptions 泛化——三实现共用；仅 stderr/stdout 管道） */
export interface PkgMgrSpawnOptions {
  cwd: string;
  stdio: ['ignore', 'pipe', 'pipe'];
  env: NodeJS.ProcessEnv;
}

export type PkgMgrSpawnFn = (command: string, args: readonly string[], options: PkgMgrSpawnOptions) => ChildLike;

/** 执行器构造选项（三实现共用；测试可注入 spawn/clock/sleep/package.json 写入） */
export interface PkgMgrRunnerOptions {
  /** 捆绑 node 二进制路径（npm 实现经其推导 npm-cli.js；pnpm/yarn 命令独立走 PATH） */
  nodePath: string;
  logger?: RuntimeLogger;
  /** spawn 注入（默认 child_process.spawn） */
  spawnFn?: PkgMgrSpawnFn;
  /** 时钟（超时预算 seam） */
  now?: () => number;
  /** 休眠（kill 宽限 seam） */
  sleep?: (ms: number) => Promise<void>;
  /** staging 根 package.json 写入（pnpm/yarn 需先有 package.json；测试注入 no-op） */
  writePkgJson?: (stagingDir: string) => void;
}
