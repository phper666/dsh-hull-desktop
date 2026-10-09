/**
 * 来源白名单（设计 §1.4 / 契约 P2②，Q-105）：entryId（name#owner 复合键，types.entryId）
 * 逐字命中 registry 条目 + url ^https://。防注入：渲染层只传 entryId；URL/install 由主进程从条目反查，不拼接用户输入。
 */
import { entryId, type RegistryEntry } from './types';

export function isWhitelisted(entryIdStr: string, entries: RegistryEntry[]): RegistryEntry | null {
  // 复合键逐字命中：name#owner 双字段相等（防同 name 不同 owner 装错；owner 缺省 '' 兜底稳定）
  const hit = entries.find((e) => entryId(e) === entryIdStr);
  if (!hit) return null;
  return hit.url.startsWith('https://') ? hit : null;
}
