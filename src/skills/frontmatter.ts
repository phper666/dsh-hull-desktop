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

/**
 * 写回 metadata.source（O-3 本地来源可填）：
 * 在 SKILL.md frontmatter 内确保存在 `metadata:` 块并含 `  source: <value>`。
 * 纯文本行级操作，不重排其它字段；无 frontmatter 或无 metadata 块 → 相应插入。
 * 返回新内容（调用方负责原子写盘）。
 */
export function setMetadataSource(content: string, source: string): string {
  const text = content.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  // 找 frontmatter 边界（起始 --- 与闭合 ---）
  if (lines[0]?.trim() !== '---') return text; // 无 frontmatter：不写（非标准 SKILL.md）
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return text;
  const fmLines = lines.slice(1, end);
  // 找 metadata: 块起始
  let metaIdx = -1;
  for (let i = 0; i < fmLines.length; i++) {
    if (/^metadata\s*:\s*$/.test(fmLines[i].trim())) { metaIdx = i; break; }
  }
  const srcLine = `  source: ${source}`;
  if (metaIdx === -1) {
    // frontmatter 末尾插入 metadata 块（闭合 --- 之前）
    const insertAt = end - 1; // 闭合行前
    lines.splice(insertAt, 0, 'metadata:', srcLine);
  } else {
    // metadata 块内：找 source 行替换，或块尾追加
    let found = -1;
    for (let i = metaIdx + 1; i < fmLines.length; i++) {
      const raw = fmLines[i];
      if (raw.trim() === '') continue;
      if (!/^[ \t]/.test(raw)) break; // 非缩进行 = metadata 块结束
      if (/^source\s*:/.test(raw.trim())) { found = i; break; }
    }
    if (found !== -1) {
      lines[1 + found] = srcLine; // fmLines[i] 对应 lines[1+i]
    } else {
      lines.splice(1 + metaIdx + 1, 0, srcLine); // metadata: 行后插入
    }
  }
  return lines.join('\n');
}
