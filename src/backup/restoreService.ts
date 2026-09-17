/**
 * B2 运行期恢复编排（设计 §2.2 / §3.4）：校验 + 迁移预演 + 原子写 pending + 取消。
 * 运行期零数据副作用：只读备份包与 userData + 仅写 `.restore/pending.json`（CON-R-backup-007）。
 * 任一校验失败整包拒绝且不写标记（CON-R-backup-010）；实际替换在下次启动早期由 restoreExecutor 执行。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { RuntimeLogger } from '../shared/types';

import { BackupError } from './errors';
import { canRestore, type GateDeps } from './gate';
import { checkCompatibility, MANIFEST_FILENAME, parseManifest, type Manifest, type ManifestItem } from './manifest';
import { clearPending, readPending, writePending, type PendingFile } from './result';
import type { ScopeItemId } from './scope';
import { previewMigrations, resolveNotesDir, validateDataFiles } from './validators';

export interface RestoreServiceDeps {
  userDataPath: string;
  /** NotesService.getNotesDir() */
  notesDir(): string;
  gate: GateDeps;
  logger: RuntimeLogger;
  now?: () => Date;
  /** HULL_E2E_FAIL_AT（运行期无注入点，记录进 pending.failAt 供观察） */
  failAt?: string;
}

export interface RestorePreview {
  mode: 'replace' | 'merge';
  manifest: Manifest;
  items: ManifestItem[];
  /** 非 null = 恢复后 notesDir 将回退（原路径不存在/非法） */
  notesDirFallback: string | null;
  warnings: string[];
  /** merge 模式：各数据类将执行的动作摘要；replace 为 null */
  mergePlan: string[] | null;
}

/** merge 模式预演摘要（§4 各类语义的一句话版） */
const MERGE_PLAN: readonly string[] = [
  '看板：以包内为基底，本机数据以新 id 追加（不覆盖包内）',
  '笔记：同名内容不同时保留本机版本，包内版本改名存放',
  '设置：包内键覆盖同名键，保留本机独有键',
  '工作流：本机工作流逐条追加，id 冲突自动重生成',
  '通知：包内为基底，本机条目按 id 去重追加',
  'skills：索引并集，缺失实体从本地预备份/包内拷入',
];

export class RestoreService {
  constructor(private readonly deps: RestoreServiceDeps) {}

  /** 只读校验 + 预演；失败抛 BackupError（不写任何标记） */
  async inspect(input: { sourceDir: string; mode: 'replace' | 'merge' }): Promise<RestorePreview> {
    const gate = canRestore(this.deps.gate);
    if (!gate.ok) throw new BackupError(gate.code ?? 'restore-busy', gate.message ?? '当前不能恢复');

    const sourceDir = input.sourceDir;
    if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
      throw new BackupError('restore-source-invalid', `备份包目录不存在或不是目录：${sourceDir}`);
    }
    const manifestPath = join(sourceDir, MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) {
      throw new BackupError('restore-manifest-missing', `备份包缺少 ${MANIFEST_FILENAME}：${sourceDir}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      throw new BackupError('restore-manifest-invalid', `manifest.json 解析失败：${(err as Error).message}`);
    }
    const parsed = parseManifest(raw);
    if (!parsed.ok) throw new BackupError(parsed.code, parsed.message);
    const manifest = parsed.value;

    const compat = checkCompatibility(manifest);
    if (!compat.ok) throw new BackupError(compat.code, compat.message);

    // §3.3 关键文件可解析/实存/守卫断言（stagedRoot = 包目录；与启动期 verified 复跑同一函数）
    const validation = validateDataFiles({ stagedRoot: sourceDir, manifest, userDataPath: this.deps.userDataPath });
    if (!validation.ok) throw new BackupError(validation.code, validation.message);

    // §3.5 迁移预演（纯函数；失败 → 整包拒绝且不写标记，杜绝半应用后 backupAndRebuild）
    const migration = previewMigrations({
      settingsRaw: this.readItemRaw(sourceDir, manifest, 'settings'),
      boardsRaw: this.readItemRaw(sourceDir, manifest, 'kanban'),
      workflowsRaw: this.readItemRaw(sourceDir, manifest, 'workflows'),
      userDataPath: this.deps.userDataPath,
    });
    if (!migration.ok) throw new BackupError(migration.code, migration.message);

    // §3.4 notesDir 红线：包内 settings.notesDir 双源判定
    const settings = migration.settings as { notesDir?: unknown } | null | undefined;
    const notes = resolveNotesDir(settings?.notesDir, { userDataPath: this.deps.userDataPath, exists: existsSync });

    const warnings = ['包内不含凭据（工作台连接需重新填写）'];
    if (notes.fallback) warnings.push(`原笔记目录不可用，恢复后笔记将回退到默认目录：${notes.fallback}`);
    else if (notes.notice) warnings.push(notes.notice.message);

    this.deps.logger.info(
      `[restore] inspect ok mode=${input.mode} source=${sourceDir} items=${manifest.items.length}`,
    );
    return {
      mode: input.mode,
      manifest,
      items: manifest.items,
      notesDirFallback: notes.fallback,
      warnings,
      mergePlan: input.mode === 'merge' ? [...MERGE_PLAN] : null,
    };
  }

  /** 校验通过后原子写 pending（step='requested', phase='forward'；覆盖写 = 重新选择语义） */
  async request(input: { sourceDir: string; mode: 'replace' | 'merge' }): Promise<{ pending: PendingFile; preview: RestorePreview }> {
    const preview = await this.inspect(input);
    const pending: PendingFile = {
      version: 1,
      mode: input.mode,
      phase: 'forward',
      step: 'requested',
      sourceDir: input.sourceDir,
      items: preview.items.map((i) => i.id),
      createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
      failAt: process.env.HULL_E2E === '1' ? (this.deps.failAt ?? null) : null,
    };
    writePending(this.deps.userDataPath, pending);
    this.deps.logger.info(
      `[restore] request mode=${input.mode} source=${input.sourceDir} items=${pending.items.length}`,
    );
    return { pending, preview };
  }

  /** 仅 step='requested' && phase='forward' 可取消；无标记返回 false（幂等） */
  cancel(): boolean {
    const pending = this.getPending();
    if (!pending || pending.step !== 'requested' || pending.phase !== 'forward') return false;
    clearPending(this.deps.userDataPath);
    this.deps.logger.info('[restore] cancel（删 pending.json）');
    return true;
  }

  getPending(): PendingFile | null {
    return readPending(this.deps.userDataPath);
  }

  /** 读包内 file 项原始 JSON（缺失/损坏 → null，由迁移预演兜底判定） */
  private readItemRaw(sourceDir: string, manifest: Manifest, id: ScopeItemId): unknown {
    const item = manifest.items.find((i) => i.id === id);
    if (!item || item.kind !== 'file') return null;
    const path = join(sourceDir, item.path);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  }
}
