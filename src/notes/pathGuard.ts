/**
 * N1 路径安全（CON-R-notes-013，设计 §4.7 单点强制）
 * 所有收路径参数的 IPC 通道第一步调 resolveSafeNotePath，通过后才进 Store/Trash。
 * 规则：resolve 后必须位于 notes.dir 内；拒 `..`/绝对路径/任一 `.` 开头隐藏段；
 * basename(realpath) 校验防符号链接逃逸（镜像 src/skills/pathGuard.ts isWithinRoots 模式）。
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

import { HullError } from '../shared/errors';
import { NOTES_ERRORS } from './types';

/** trashId 白名单：tr_<uuid>（randomUUID 标准连字符格式） */
const TRASH_ID_RE = /^tr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidTrashId(id: unknown): id is string {
  return typeof id === 'string' && TRASH_ID_RE.test(id);
}

/** path 是否落在 root 域内（规范化后前缀包含；/root/foo 与 /root/foobar 不互认） */
export function isWithinRoot(path: string, root: string): boolean {
  const norm = resolve(path);
  const rn = resolve(root);
  return norm === rn || norm.startsWith(rn + sep);
}

/** 路径参数非法（契约 notes-path-invalid，扩展字段 path——toResult 透传面依赖，oracle 🟠4） */
export function pathInvalid(relPath: string, reason: string): never {
  const err = new HullError(NOTES_ERRORS.pathInvalid, `路径非法（${reason}）: ${relPath}`) as HullError & { path?: string };
  err.path = relPath;
  throw err;
}

/**
 * 相对路径 → 绝对路径安全解析。
 * 拒：非字符串/空串/绝对路径/反斜杠/空段/`..` 段/`.` 开头隐藏段；
 * 存在的目标还需 basename(realpath) 校验（符号链接改名逃逸）；
 * 目标不存在时对最深存在祖先做 realpath 包含校验（父目录符号链接逃逸）。
 * 通过后返回 resolve(root, rel) 绝对路径（不要求存在）。
 */
export function resolveSafeNotePath(root: string, relPath: unknown): string {
  if (typeof relPath !== 'string' || relPath.length === 0) pathInvalid(String(relPath), '非字符串或空');
  if (isAbsolute(relPath)) pathInvalid(relPath, '绝对路径');
  if (relPath.includes('\\')) pathInvalid(relPath, '反斜杠分隔符');
  const segments = relPath.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '..' || seg.startsWith('.')) {
      pathInvalid(relPath, seg === '' ? '空路径段' : seg.startsWith('.') ? '隐藏/穿越段' : seg);
    }
  }
  const abs = resolve(root, ...segments);
  if (!isWithinRoot(abs, root)) pathInvalid(relPath, '越出 notes.dir');
  realpathCheck(root, abs, relPath);
  return abs;
}

/** realpath 校验：目标（或最深存在祖先）的 realpath 必须仍在 root 内（防符号链接逃逸；根内合法符号链接不误伤） */
function realpathCheck(root: string, abs: string, relPath: string): void {
  const rootReal = realpathOf(root);
  let cur = abs;
  for (;;) {
    if (existsSync(cur)) {
      const real = realpathOf(cur);
      if (real === null || !isWithinRoot(real, rootReal ?? root)) pathInvalid(relPath, 'realpath 越出 notes.dir');
      return;
    }
    const parent = resolve(cur, '..');
    if (parent === cur) return; // 到达根仍未存在（异常），交上层 IO 错误
    cur = parent;
  }
}

function realpathOf(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** 目标必须是已存在的真实目录（notes:move targetDir 校验，契约 §接口详情 5） */
export function requireExistingDir(absDir: string, relPath: string): void {
  let st;
  try {
    st = statSync(absDir);
  } catch {
    throw new HullError(NOTES_ERRORS.pathInvalid, `目标目录不存在: ${relPath}`);
  }
  if (!st.isDirectory()) pathInvalid(relPath, '目标不是目录');
}
