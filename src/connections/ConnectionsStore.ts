/**
 * 连接存储：CRUD + safeStorage 加密持久化 + 脱敏视图。
 * 安全设计（docs/design/工作台连接-connections-design.md §三）：
 * - secret 字段（平台 schema 标记）→ safeStorage.encrypt → base64，落盘带 'enc:' 前缀
 * - safeStorage 不可用 → 拒绝保存（安全优先，不做明文降级）
 * - 渲染层零明文：view() 脱敏（secret → ****+尾4）；解密只发生在 main 侧验证器/未来业务封装
 * - DI：加密适配器注入（单测用 fake，main 传 safeStorage）
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConnectionStatus, ConnectionView, FieldSchema, PlatformAdapter, PlatformId, StoredConnection } from './types';

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface ConnectionsStoreOptions {
  userDataPath: string;
  adapters: PlatformAdapter[];
  encryption: SafeStorageAdapter;
}

const ENC_PREFIX = 'enc:';

/** 平台适配器（id → 定义） */
export class ConnectionsStore {
  private readonly file: string;
  private readonly adapters = new Map<PlatformId, PlatformAdapter>();
  private cache: StoredConnection[] | null = null;

  constructor(private readonly options: ConnectionsStoreOptions) {
    this.file = join(options.userDataPath, 'connections', 'connections.json');
    for (const a of options.adapters) this.adapters.set(a.id, a);
  }

  /** 平台元数据（渲染层表单 schema 驱动） */
  platforms(): Array<{ id: PlatformId; name: string; description: string; fields: FieldSchema[] }> {
    return [...this.adapters.values()].map((a) => ({ id: a.id, name: a.name, description: a.description, fields: a.fields }));
  }

  private adapter(platform: PlatformId): PlatformAdapter {
    const a = this.adapters.get(platform);
    if (!a) throw new Error(`不支持的平台: ${platform}`);
    return a;
  }

  private load(): StoredConnection[] {
    if (this.cache) return this.cache;
    if (!existsSync(this.file)) {
      this.cache = [];
      return this.cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { connections?: StoredConnection[] };
      this.cache = Array.isArray(parsed.connections) ? parsed.connections : [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private persist(connections: StoredConnection[]): void {
    mkdirSync(join(this.options.userDataPath, 'connections'), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ version: 1, connections }, null, 2));
    this.cache = connections;
  }

  private encryptField(plain: string): string {
    if (!this.options.encryption.isEncryptionAvailable()) {
      throw new Error('系统安全加密不可用，无法保存凭据（safeStorage 不可用）');
    }
    // 字段级密钥派生留 v2（当前 OS 级加密已足够）
    return ENC_PREFIX + this.options.encryption.encryptString(plain).toString('base64');
  }

  private decryptField(value: string): string {
    if (!value.startsWith(ENC_PREFIX)) return value; // 兼容历史明文（不应出现）
    return this.options.encryption.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'));
  }

  private mask(value: string): string {
    if (value.startsWith(ENC_PREFIX)) {
      const plain = this.decryptField(value);
      return plain.length <= 4 ? '****' : `****${plain.slice(-4)}`;
    }
    return value.length <= 4 ? '****' : `****${value.slice(-4)}`;
  }

  private adapterOf(connection: StoredConnection): PlatformAdapter {
    return this.adapter(connection.platform);
  }

  /** 脱敏视图（渲染层唯一读取通道；secret → 掩码） */
  list(): ConnectionView[] {
    return this.load().map((c) => this.view(c));
  }

  private view(c: StoredConnection): ConnectionView {
    void 0;
    const schema = this.adapterOf(c).fields;
    const fields: Record<string, string> = {};
    for (const f of schema) {
      const raw = c.fields[f.key];
      if (raw === undefined) continue;
      fields[f.key] = f.secret ? this.mask(raw) : raw;
    }
    return { id: c.id, platform: c.platform, name: c.name, fields, status: c.status, lastError: c.lastError, lastVerifiedAt: c.lastVerifiedAt, createdAt: c.createdAt, updatedAt: c.updatedAt };
  }

  /** 解密凭据（main 侧业务封装专用；渲染层 IPC 不暴露） */
  getCredentials(id: string): { platform: PlatformId; fields: Record<string, string> } | null {
    const c = this.load().find((x) => x.id === id);
    if (!c) return null;
    const fields: Record<string, string> = {};
    for (const f of this.adapterOf(c).fields) {
      const raw = c.fields[f.key];
      if (raw !== undefined) fields[f.key] = f.secret ? this.decryptField(raw) : raw;
    }
    return { platform: c.platform, fields };
  }

  /** 保存（新建或编辑）。编辑时 secret 留空 = 保留原值。返回脱敏视图 */
  save(input: { id?: string; platform: PlatformId; name: string; fields: Record<string, string> }): ConnectionView {
    const adapter = this.adapter(input.platform);
    const connections = this.load();
    const now = new Date().toISOString();
    const requiredMissing = adapter.fields.filter((f) => f.required && !input.fields[f.key] && !(input.id && !input.fields[f.key]));
    if (requiredMissing.length) {
      throw new Error(`缺少必填字段: ${requiredMissing.map((f) => f.label).join('、')}`);
    }

    let stored: StoredConnection;
    if (input.id) {
      const existing = connections.find((x) => x.id === input.id);
      if (!existing) throw new Error('连接不存在（已被删除）');
      const merged: Record<string, string> = { ...existing.fields };
      for (const f of adapter.fields) {
        const v = input.fields[f.key];
        if (v === undefined || v === '') continue; // 留空 = 保留原值（secret 脱敏回显场景）
        merged[f.key] = f.secret ? this.encryptField(v) : v;
      }
      existing.name = input.name || existing.name;
      existing.fields = merged;
      existing.updatedAt = now;
      stored = existing;
    } else {
      const fields: Record<string, string> = {};
      for (const f of adapter.fields) {
        const v = input.fields[f.key];
        if (v === undefined || v === '') continue;
        fields[f.key] = f.secret ? this.encryptField(v) : v;
      }
      stored = {
        id: randomUUID(),
        platform: input.platform,
        name: input.name || adapter.name,
        fields,
        status: 'unverified',
        createdAt: now,
        updatedAt: now,
      };
      connections.push(stored);
    }
    this.persist(connections);
    return this.view(stored);
  }

  /** 记录验证结果 */
  recordResult(id: string, status: ConnectionStatus, lastError?: string): ConnectionView | null {
    const connections = this.load();
    const c = connections.find((x) => x.id === id);
    if (!c) return null;
    c.status = status;
    c.lastError = status === 'failed' ? lastError : undefined;
    if (status === 'connected') c.lastVerifiedAt = new Date().toISOString();
    c.updatedAt = new Date().toISOString();
    this.persist(connections);
    return this.view(c);
  }

  delete(id: string): boolean {
    const connections = this.load();
    const next = connections.filter((x) => x.id !== id);
    if (next.length === connections.length) return false;
    this.persist(next);
    return true;
  }
}
