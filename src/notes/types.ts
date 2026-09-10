/**
 * N1 notes 数据结构与错误码（feishu-n1-notes-api-contract.md §Schema/§错误与异常 原样落型）
 */

/** 错误码常量（契约 §错误与异常） */
export const NOTES_ERRORS = {
  pathInvalid: 'notes-path-invalid',
  notFound: 'notes-not-found',
  conflictModified: 'notes-conflict-modified',
  conflictDeleted: 'notes-conflict-deleted',
  restoreConflict: 'notes-restore-conflict',
  nameConflict: 'notes-name-conflict',
  ioError: 'notes-io-error',
  scanError: 'notes-scan-error',
} as const;

/** frontmatter 三键 + title（契约 NoteIndexEntry.frontmatter；title 并入顶层） */
export interface NoteFrontmatter {
  title: string | null;
  type: string | null;
  task: string | null;
  tags: string[] | null;
}

/** NoteIndexEntry（notes:index / notes:search 返回项） */
export interface NoteIndexEntry {
  path: string;
  title: string;
  frontmatter: NoteFrontmatter;
  snippet: string;
  updatedAt: string;
}

/** NoteDetail（notes:get 返回） */
export interface NoteDetail {
  path: string;
  content: string;
  frontmatter: NoteFrontmatter;
  mtime: string;
}

/** frontmatterPatch（notes:save 可选；task:null 表清除） */
export interface FrontmatterPatch {
  title?: string;
  type?: string;
  task?: string | null;
  tags?: string[];
}

/** SaveInput（notes:save 请求） */
export interface SaveInput {
  path: string;
  content: string;
  expectedMtime: string;
  frontmatterPatch?: FrontmatterPatch;
  strategy?: 'overwrite' | 'saveAsCopy';
}

/** TrashEntry（notes:trashList 返回项 / trash.json entries[]） */
export interface TrashEntry {
  id: string;
  originalPath: string;
  deletedAt: string;
  sizeBytes: number;
}

/** IndexChangedPayload（notes:indexChanged 推送） */
export interface IndexChangedPayload {
  reason: 'incremental' | 'rescan' | 'dir-changed';
}
