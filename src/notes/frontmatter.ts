/**
 * N1 通用键 frontmatter 解析 + key 级回写（设计 D7）
 * 算法与 src/skills/frontmatter.ts 同构（--- 边界 + 行级 key:value、坏行跳过永不抛错），
 * 键集泛化为任意 key → string（skills 版硬编码四键不满足保真，故不直接 import）。
 * 回写 = key 级行级重建（模式对齐 setMetadataSource：定位键行替换 / 闭合 --- 前追加，
 * 不重排其它行）；解析失败/无 frontmatter → 文件头注入新块，正文逐字节不动（CON-R-notes-005）。
 * tags 数组值按行内 `[a, b]` 文本处理，不引 YAML。
 */

import type { FrontmatterPatch, NoteFrontmatter } from './types';

export interface ParsedNoteFrontmatter {
  fm: NoteFrontmatter;
  /** 文件含合法 `---` 块边界（坏行跳过仍算有块）；无块/未闭合 = false → 保存时头注入 */
  hasBlock: boolean;
}

function stripQuotes(v: string): string {
  if (v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) {
    return v.slice(1, -1);
  }
  return v;
}

/** `[a, b]` / a / "a" → string[]；空值 → null */
function parseTags(val: string): string[] | null {
  const t = stripQuotes(val.trim());
  if (t === '' ) return null;
  const inner = t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t;
  const items = inner
    .split(',')
    .map((s) => stripQuotes(s.trim()))
    .filter((s) => s !== '');
  return items.length === 0 ? null : items;
}

export function parseNoteFrontmatter(content: string): ParsedNoteFrontmatter {
  const fm: NoteFrontmatter = { title: null, type: null, task: null, tags: null };
  if (typeof content !== 'string') return { fm, hasBlock: false };
  const text = content.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { fm, hasBlock: false };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { fm, hasBlock: false };
  for (const line of text.slice(4, end).split('\n')) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (/^\s/.test(line)) continue; // 缩进行（嵌套结构）跳过——三键为平面标量
    const idx = line.indexOf(':');
    if (idx <= 0) continue; // 坏行跳过（CON-R-notes-005 永不抛错）
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key === 'title') fm.title = stripQuotes(val) || null;
    else if (key === 'type') fm.type = stripQuotes(val) || null;
    else if (key === 'task') fm.task = stripQuotes(val) || null;
    else if (key === 'tags') fm.tags = parseTags(val);
    // 未知键忽略（解析面）；回写面行级操作天然保真
  }
  return { fm, hasBlock: true };
}

/** 值 → 行级文本（tags 数组 → 行内 `[a, b]`；字符串原样单行化） */
function formatValue(v: string | string[]): string {
  if (Array.isArray(v)) return `[${v.map((s) => s.replace(/[\r\n,]/g, ' ')).join(', ')}]`;
  return v.replace(/[\r\n]/g, ' ');
}

/**
 * key 级回写（契约 §SaveInput.frontmatterPatch）：
 * - 有合法块：块内定位 patch 键行 → 原行替换；键不存在 → 闭合 `---` 前追加；
 *   task:null = 清除（删键行，无则忽略）；未知键与键序原样保留。
 * - 无块/解析失败：文件头注入新块（仅非 null 键），正文逐字节不动。
 * 返回新内容（调用方负责原子写盘）。
 */
export function applyFrontmatterPatch(content: string, patch: FrontmatterPatch): string {
  const text = content.replace(/\r\n/g, '\n');
  const entries = Object.entries(patch) as Array<[keyof FrontmatterPatch, string | string[] | null | undefined]>;
  const hasBlock = text.startsWith('---\n') && text.indexOf('\n---', 4) !== -1;
  if (!hasBlock) {
    // 头注入：新块 + 空行 + 正文原样
    const lines = entries
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${k}: ${formatValue(v as string | string[])}`);
    if (lines.length === 0) return text;
    return `---\n${lines.join('\n')}\n---\n\n${text}`;
  }
  const lines = text.split('\n');
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return text; // 防御（hasBlock 已保证，不达）
  const pending: string[] = [];
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    const keyRe = new RegExp(`^${key}\\s*:`);
    let found = -1;
    for (let i = 1; i < close; i++) {
      if (!/^\s/.test(lines[i]) && keyRe.test(lines[i])) {
        found = i;
        break;
      }
    }
    if (value === null) {
      // 清除：删键行（无则忽略）
      if (found !== -1) {
        lines.splice(found, 1);
        close--;
      }
      continue;
    }
    const rendered = `${key}: ${formatValue(value)}`;
    if (found !== -1) {
      lines[found] = rendered;
    } else {
      pending.push(rendered);
    }
  }
  if (pending.length > 0) lines.splice(close, 0, ...pending);
  return lines.join('\n');
}
