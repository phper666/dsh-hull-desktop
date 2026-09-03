/**
 * Token 用量统计（Token 消耗视图）——类型与粒度定义。
 * 设计：docs/design/Token消耗查看-tokens-design.md
 * 平台适配器注册表模式（TokenTracker 同构）：v2 = 全量本地可解析 16 平台（JSONL/JSON/SQLite）
 */

export type TokenPlatform =
  | 'claude-code'
  | 'codex'
  | 'dsh'
  | 'opencode'
  | 'cline'
  | 'roo'
  | 'gemini'
  | 'kimi'
  | 'goose'
  | 'continue'
  | 'zed'
  | 'warp'
  | 'zcode'
  | 'qoder'
  | 'copilot'
  | 'kiro';

/** 统计粒度 = 日历对齐范围（TokenTracker 同构五档）：day=今天、week=本周（周一起）、month=本月、total=最近 24 个月（有界）、custom=用户自定义区间；全视图（总计/序列/透视）按 {from,to} 双边界过滤；序列分桶粒度按范围推导（day→hour、week/month→day、total→month、custom→跨度自适应） */
export type UsageGranularity = 'day' | 'week' | 'month' | 'total' | 'custom';

export const USAGE_GRANULARITIES: UsageGranularity[] = ['day', 'week', 'month', 'total', 'custom'];

export const GRANULARITY_NAMES: Record<UsageGranularity, string> = {
  day: '日',
  week: '周',
  month: '月',
  total: '总计',
  custom: '自定义',
};

/** 自定义窗口（YYYY-MM-DD，本地时区） */
export interface CustomRange {
  from: string;
  to: string;
}

/** 单条用量记录（一行会话事件的归一化） */
export interface UsageRecord {
  /** 事件时间（ISO；无时间戳的行按文件 mtime 兜底） */
  ts: string;
  platform: TokenPlatform;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** 缓存读（命中） */
  cacheReadTokens: number;
  /** 缓存写（创建） */
  cacheWriteTokens: number;
  /** 推理 token（codex/gemini 等有独立字段；无则 0） */
  reasoningTokens: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** 估算成本 USD（本地价格表 × token 用量，非官方账单）；行内含未定价模型 → null（诚实不估算） */
  costUsd: number | null;
}

/** 时间桶（粒度聚合序列的一格） */
export interface UsageBucket extends UsageTotals {
  /** 桶键：min10=YYYY-MM-DD HH:MM（10 分钟）/ hour=YYYY-MM-DD HH:00 / day=YYYY-MM-DD / month=YYYY-MM */
  bucket: string;
  records: number;
}
/** 平台/模型透视行 */
export interface UsageDimensionRow extends UsageTotals {
  platform: TokenPlatform;
  model: string;
}

export interface UsageSummary {
  granularity: UsageGranularity;
  generatedAt: string;
  /** 实际生效窗口（ISO，本地时区日历边界；custom=用户区间） */
  range: { from: string; to: string };
  /** 全局总计 */
  totals: UsageTotals;
  /** 时间序列（升序） */
  series: UsageBucket[];
  byPlatform: UsageDimensionRow[];
  byModel: UsageDimensionRow[];
  /** 各平台扫描概况（空态指引/隔离错误） */
  sources: Array<{ platform: TokenPlatform; home: string; files: number; records: number; error?: string }>;
}

/** 平台适配器契约：每平台一个文件导出 PlatformSource，注册表集中导入（TokenUsageScanner.ts） */
export interface PlatformSource {
  platform: TokenPlatform;
  /** 数据根路径（空态指引展示用） */
  home: string;
  /** 返回目录下全部目标文件（绝对路径）；不存在 → [] */
  listFiles: () => string[];
  /** 逐行解析（默认路径） */
  parseLine?: (line: string, fallbackTs: string) => UsageRecord | null;
  /** 整文件解析（累计值/特殊语义平台）——设置后 parseLine 不生效 */
  parseFile?: (text: string, fallbackTs: string) => UsageRecord[];
  /** 特殊读取（如 zstd 解压）；返回解压后文本，失败抛错由调用方隔离 */
  readFile?: (path: string) => string;
}
