/**
 * Token 用量统计（Token 消耗视图）——类型与粒度定义。
 * 设计：docs/design/Token消耗查看-tokens-design.md
 * 平台适配器注册表模式（TokenTracker 同构）：v1 = claude-code / codex / dsh（zstd JSONL）
 */

export type TokenPlatform = 'claude-code' | 'codex' | 'dsh';
export type UsageGranularity = 'hour' | 'day' | 'week' | 'month';

export const USAGE_GRANULARITIES: UsageGranularity[] = ['hour', 'day', 'week', 'month'];

export const GRANULARITY_NAMES: Record<UsageGranularity, string> = {
  hour: '小时',
  day: '天',
  week: '周',
  month: '月',
};

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
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

/** 时间桶（粒度聚合序列的一格） */
export interface UsageBucket extends UsageTotals {
  /** 桶键：hour=YYYY-MM-DD HH:00 / day=YYYY-MM-DD / week=YYYY-Www / month=YYYY-MM */
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
  /** 全局总计 */
  totals: UsageTotals;
  /** 时间序列（升序） */
  series: UsageBucket[];
  byPlatform: UsageDimensionRow[];
  byModel: UsageDimensionRow[];
  /** 各平台扫描概况（空态指引/隔离错误） */
  sources: Array<{ platform: TokenPlatform; home: string; files: number; records: number; error?: string }>;
}
