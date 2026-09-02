/**
 * 平台适配器扫描器（多平台 token 用量采集）：
 * - 16 平台适配器注册表（adapters/ 每平台一个文件，统一 create<Platform>Source 契约）
 * - scanAllSources 编排：listFiles → readFile/parseFile/parseLine 派发 + 单源/单文件失败隔离 + claude 跨文件去重
 * 原则：只读（CON-R002 红线：绝不写 DSH_HOME）；单文件失败隔离；逐行流式（大文件友好）。
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

import type { UsageRecord } from './types';
import type { PlatformSource } from './types';
import type { ScanSourceInfo } from './aggregator';

import { createClaudeSource } from './adapters/claude';
import { createCodexSource } from './adapters/codex';
import { createDshSource } from './adapters/dsh';
import { createOpenCodeSource } from './adapters/opencode';
import { createClineSource } from './adapters/cline';
import { createRooSource } from './adapters/roo';
import { createGeminiSource } from './adapters/gemini';
import { createKimiSource } from './adapters/kimi';
import { createGooseSource } from './adapters/goose';
import { createContinueSource } from './adapters/continue';
import { createZedSource } from './adapters/zed';
import { createWarpSource } from './adapters/warp';
import { createZcodeSource } from './adapters/zcode';
import { createQoderSource } from './adapters/qoder';
import { createCopilotSource } from './adapters/copilot';
import { createKiroSource } from './adapters/kiro';
import { fileFingerprint, safeJson } from './adapters/shared';

const HOME = homedir();

/** 平台源注册表（home 可注入便于测试） */
export function platformSources(home = HOME): PlatformSource[] {
  return [
    createClaudeSource(home),
    createCodexSource(home),
    createDshSource(home),
    createOpenCodeSource(home),
    createClineSource(home),
    createRooSource(home),
    createGeminiSource(home),
    createKimiSource(home),
    createGooseSource(home),
    createContinueSource(home),
    createZedSource(home),
    createWarpSource(home),
    createZcodeSource(home),
    createQoderSource(home),
    createCopilotSource(home),
    createKiroSource(home),
  ];
}

/** mtime 兜底时间戳（无 timestamp 字段的行） */
function fileFallbackTs(path: string): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/** 扫描全部平台 → 记录 + 各源概况（单源失败隔离） */
export function scanAllSources(sources: PlatformSource[] = platformSources()): { records: UsageRecord[]; sources: ScanSourceInfo[] } {
  const records: UsageRecord[] = [];
  const infos: ScanSourceInfo[] = [];
  const seen = new Set<string>(); // 准确性：跨文件去重（claude 同一 assistant 消息可能在多文件重复出现）
  for (const src of sources) {
    const info: ScanSourceInfo = { platform: src.platform, home: src.home, files: 0, records: 0 };
    try {
      const files = src.listFiles();
      info.files = files.length;
      for (const file of files) {
        try {
          const text = src.readFile ? src.readFile(file) : readFileSync(file, 'utf8');
          const fallbackTs = fileFallbackTs(file);
          if (src.parseFile) {
            const recs = src.parseFile(text, fallbackTs);
            records.push(...recs);
            info.records += recs.length;
            continue;
          }
          for (const line of text.split('\n')) {
            if (!line) continue;
            const rec = src.parseLine?.(line, fallbackTs);
            if (!rec) continue;
            // 去重键：claude 用 message.id+requestId（同一 API 响应在主会话/子代理文件重复出现只计一次）
            const j = safeJson(line);
            const msgId = (j?.message as Record<string, unknown> | undefined)?.id;
            const dedupeKey = `${src.platform}:${(msgId as string) || fileFingerprint(file)}:${(j?.requestId as string) || ''}:${rec.ts}`;
            if (src.platform === 'claude-code') {
              if (seen.has(dedupeKey)) continue;
              seen.add(dedupeKey);
            }
            records.push(rec);
            info.records += 1;
          }
        } catch {
          // 单文件失败隔离（损坏/解压失败）→ 跳过
        }
      }
    } catch (err) {
      info.error = (err as Error).message;
    }
    infos.push(info);
  }
  return { records, sources: infos };
}

/** 路线图平台（格式待逐一验证后实现适配器；TokenTracker 已覆盖 34 工具可参考） */
export const ROADMAP_PLATFORMS = ['Gemini CLI', 'OpenCode', 'Cursor', 'Zed', 'GitHub Copilot', 'Qoder', 'Goose', 'ZCode', 'Kiro'];
