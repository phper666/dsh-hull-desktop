/**
 * SKILL.md frontmatter 最小解析器（设计 D3 / 共识 §7.2）
 * 字段平面 + 一个嵌套 metadata map——不引 YAML 库（YAGNI）。
 * 纪律：缺失/坏行降级为 null/跳过，永不抛错（T7：条目保留不丢）。
 */

export interface Frontmatter {
  name: string | null;
  description: string | null;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
}

const EMPTY: Frontmatter = { name: null, description: null, license: null, compatibility: null, metadata: {} };

function stripQuotes(v: string): string {
  if (v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) {
    return v.slice(1, -1);
  }
  return v;
}

export function parseFrontmatter(content: string): Frontmatter {
  const result: Frontmatter = { ...EMPTY, metadata: {} };
  if (typeof content !== 'string') return result;
  const text = content.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return result;
  const end = text.indexOf('\n---', 4);
  if (end === -1) return result;

  let blockKey: string | null = null; // 块标量（| / >）收集中的字段
  let blockLines: string[] = [];
  const flushBlock = (): void => {
    if (!blockKey) return;
    const joined = blockLines.filter((l) => l.length > 0).join(' ');
    assign(result, blockKey, joined);
    blockKey = null;
    blockLines = [];
  };

  for (const line of text.slice(4, end).split('\n')) {
    // 块标量续行（缩进或空行）
    if (blockKey && (/^\s/.test(line) || line.trim() === '')) {
      blockLines.push(line.trim());
      continue;
    }
    flushBlock();
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue; // 坏行跳过（无冒号）
    const indented = /^[ \t]/.test(line);
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (indented) {
      // 嵌套块：仅 metadata 约定（string map）
      if (key && val) result.metadata[key] = stripQuotes(val);
      continue;
    }
    if (val === '|' || val === '>') {
      blockKey = key;
      blockLines = [];
      continue;
    }
    assign(result, key, stripQuotes(val));
  }
  flushBlock();
  return result;
}

function assign(fm: Frontmatter, key: string, val: string): void {
  switch (key) {
    case 'name': fm.name = val || null; break;
    case 'description': fm.description = val || null; break;
    case 'license': fm.license = val || null; break;
    case 'compatibility': fm.compatibility = val || null; break;
    default: break; // 未知顶层键忽略
  }
}
