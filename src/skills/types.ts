/**
 * S1 Skills 类型定义（feishu-s1-skills-api-contract.md §Schema 唯一权威形态）
 * SkillEntry/PathInfo/ScanSnapshot/StatusCounts/RemoteSkillEntry
 */

export type ScanStatus = 'idle' | 'scanning' | 'ready' | 'error';
export type Scope = 'global' | 'scoped';
export type UpgradableState = 'latest' | 'upgradable' | 'unknown';

/** 物理路径明细（契约偏差说明：由共识 string[] 升格——S2 的 mtime 守卫与 symlink 判定依赖结构化信息） */
export interface PathInfo {
  /** 注册表目录内绝对路径（symlink 来源即链接位置本身；realpath 仅用于去重/判定） */
  path: string;
  isSymlink: boolean;
  /** 目录 mtime 快照（S2 写前冲突检查依据） */
  mtimeMs: number;
  affectedPlatforms: string[];
}

/** 聚合后列表条目（唯一权威结构，契约 §SkillEntry） */
export interface SkillEntry {
  name: string;
  scope: Scope;
  platforms: string[];
  description: string | null;
  source: string | null;
  paths: PathInfo[];
  localHash: string | null;
  remoteHash: string | null;
  upgradable: UpgradableState;
  /** 聚合展示态：S1 阶段恒 true（S2 禁用后由目录实际位置推导） */
  enabled: boolean;
}

/** 远程 marketplace 条目（searchRemote 结果，仅浏览） */
export interface RemoteSkillEntry {
  name: string;
  description: string | null;
  source: string | null;
  installs: number | null;
  /** 恒 false：远程结果未安装标注（Q-036） */
  installed: boolean;
}

/** 扫描快照（getSnapshot 响应） */
export interface ScanSnapshot {
  status: ScanStatus;
  /** scanning 时为上次 ready 快照或 []（原子替换语义） */
  entries: SkillEntry[];
  lastScanAt: string | null;
  error: string | null;
}

/** 状态栏计数（getStatus 响应，快照派生） */
export interface StatusCounts {
  total: number;
  upgradable: number;
  disabled: number;
  global: number;
}

// ─────────────────────────── S2 操作层类型（feishu-s2-skills-api-contract §Schema） ───────────────────────────

/** 禁用映射条目（<userData>/skills/disabled.json entries[]） */
export interface DisabledEntry {
  /** d_<uuid>（=disabled 目录名；uuid 规避同 skill 多路径撞名） */
  id: string;
  skillName: string;
  /** 原物理路径（启用恢复目标） */
  originalPath: string;
  /** dir=实目录已 rename 入驻；symlink=仅移指针源保留 SSOT（无实体） */
  kind: 'dir' | 'symlink';
  /** 原 symlink 指向（kind=symlink 必填，重建用） */
  symlinkTarget?: string;
  affectedPlatforms: string[];
  disabledAt: string;
}

/** 回收站条目（<userData>/skills/trash.json entries[]） */
export interface TrashEntry {
  /** tr_<uuid>（=trash 目录名） */
  id: string;
  skillName: string;
  originalPath: string;
  /** 删除时间（TTL 计算基准） */
  deletedAt: string;
  /** 条目体积（500MB 上限计算） */
  sizeBytes: number;
  affectedPlatforms: string[];
}

export type OpAction = 'remove' | 'upgrade' | 'disable' | 'enable' | 'restore' | 'purge';

/** 操作日志单行（operations.jsonl，append-only JSON Lines） */
export interface OperationLogEntry {
  ts: string;
  action: OpAction;
  paths: string[];
  result: 'success' | 'failed';
  detail?: Record<string, unknown>;
}
