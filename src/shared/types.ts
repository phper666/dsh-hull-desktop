/**
 * 运行时快照与状态机类型（契约 §Schema 与枚举 / 设计 D7）
 *
 * RuntimeSnapshot 四字段与契约一致；message ≤200 字符的运行时截断在
 * RuntimeManager 落地（本文件只承载类型契约）。
 */

/** dsh 运行时阶段（契约枚举：idle/starting/ready/failed） */
export enum RuntimePhase {
  Idle = 'idle',
  Starting = 'starting',
  Ready = 'ready',
  Failed = 'failed',
}

/** 运行快照（契约 §RuntimeSnapshot，四字段） */
export interface RuntimeSnapshot {
  /** 运行阶段 */
  phase: RuntimePhase;
  /** 状态说明（用户可见，≤200 字符） */
  message: string;
  /** 启动工作目录（绝对路径，可空） */
  launchDirectory: string | null;
  /** 就绪后的 Web 地址（http://127.0.0.1:端口，可空） */
  url: string | null;
}

/** 状态迁移表类型：每个阶段允许迁移到的目标阶段列表 */
export type PhaseTransitionTable = Record<RuntimePhase, RuntimePhase[]>;

/** S2 安装流程阶段（契约 §状态转换） */
export enum InstallPhase {
  NotInstalled = 'not-installed',
  Installing = 'installing',
  Ready = 'ready',
}

/** 安装进度阶段（契约安装事件表 phase） */
export type InstallProgressPhase = 'download' | 'npm-install' | 'swap';

/** 安装进度载荷（installStatus()/progress 事件） */
export interface InstallProgress {
  phase: InstallProgressPhase;
  pct: number;
}

/** 安装快照（installStatus()/snapshot()，深拷贝） */
export interface InstallSnapshot {
  phase: InstallPhase;
  /** 当前生效版本（swap 后/已有 dsh 时；无则 null） */
  version: string | null;
  progress: InstallProgress | null;
  message: string;
  /** npm 安装输出缓冲（最近 N 行，首装输出框数据源；OverlayManager 维护，installing 段收集） */
  output: string[];
}

/** 子进程最小接口（child_process.ChildProcess 结构兼容；RuntimeManager/npmRunner 共用，测试可注入 fake） */
export interface ChildLike {
  readonly pid?: number;
  exitCode: number | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
  once(event: string | symbol, listener: (...args: any[]) => void): this;
  removeListener(event: string | symbol, listener: (...args: any[]) => void): this;
}

/** S3 升级阶段（契约 §UpgradeStatus：7 态） */
export enum UpgradePhase {
  Idle = 'idle',
  Checking = 'checking',
  Confirm = 'confirm',
  Installing = 'installing',
  Swapping = 'swapping',
  Verifying = 'verifying',
  Rollback = 'rollback',
}

/** 升级快照（契约 §UpgradeStatus + message 扩展） */
export interface UpgradeStatus {
  phase: UpgradePhase;
  /** 当前 dsh 版本（回滚后回写 previous 版本，B11） */
  currentVersion: string | null;
  /** 目标版本（confirm 后） */
  targetVersion: string | null;
  /** 失败语义码（UPGRADE_ERRORS；成功 = null） */
  error: string | null;
  /** 安装进度 0-100 */
  pct: number;
  /** 状态说明（用户可见） */
  message: string;
  /** npm 安装输出缓冲（最近 N 行，改进：升级输出框数据源；主进程 Updater 维护，切视图回来经快照恢复） */
  output: string[];
}

/** S5 Hull 自更新阶段（契约 §HullUpdateStatus：6 态 + restart-prompt 枚举保留） */
export enum HullUpdatePhase {
  Idle = 'idle',
  Checking = 'checking',
  Confirm = 'confirm',
  Downloading = 'downloading',
  /** 枚举保留（契约 schema 字段，S6 UI 渲染态；状态机不迁移到它——Q-012 无稍后重启） */
  RestartPrompt = 'restart-prompt',
  Restarting = 'restarting',
  Done = 'done',
}

/** Hull 自更新快照（契约 §HullUpdateStatus + message/pct 扩展） */
export interface HullUpdateStatus {
  phase: HullUpdatePhase;
  /** 当前 Hull 版本（app.getVersion() 注入，B8） */
  currentVersion: string | null;
  /** 新版本 */
  targetVersion: string | null;
  /** GitHub Releases 变更说明（缺失降级为纯版本对比） */
  changeNotes: string | null;
  /** 语义错误码（HULL_UPDATE_ERRORS；成功 = null） */
  error: string | null;
  /** 下载进度 0-100（adapter download-progress 透传） */
  pct: number;
  /** 已下载字节（下载详情展示；非下载态 0） */
  transferred: number;
  /** 总字节（未知 = 0） */
  total: number;
  /** 下载速度 字节/秒 */
  bytesPerSecond: number;
  /** 状态说明（用户可见） */
  message: string;
}

/** 壳内模块统一的日志接口（RuntimeManager/SettingsProvider 注入用；log/Logger.ts 为落地实现） */
export interface RuntimeLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** dsh 子进程输出落盘（FR-8）：pid 归属 + 原始 chunk */
  dshLog(pid: number, chunk: string): void;
}

/** 默认 no-op 日志（各模块构造默认注入） */
export const NOOP_LOGGER: RuntimeLogger = {
  info() {},
  warn() {},
  error() {},
  dshLog() {},
};
