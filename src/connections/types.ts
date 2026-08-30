/**
 * 工作台连接（Connections）——类型定义。
 * 设计：docs/design/工作台连接-connections-design.md
 * 安全：敏感字段 safeStorage 加密（enc: 前缀 base64）；渲染层零明文（脱敏视图）。
 */

export type PlatformId = 'salesforce' | 'aliyun-sms' | 'tencent-sms' | 'smtp';

export type ConnectionStatus = 'unverified' | 'connected' | 'failed';

/** 平台字段 schema（数据驱动表单；secret=true 走加密存储与脱敏） */
export interface FieldSchema {
  key: string;
  label: string;
  required: boolean;
  secret?: boolean;
  placeholder?: string;
  /** 表单控件类型：text/password/url/number/switch；默认 text */
  type?: 'text' | 'password' | 'url' | 'number' | 'switch';
  /** switch 字段选中时的值 */
  switchOnValue?: string;
  hint?: string;
}

/** 连接结果（验证器返回） */
export interface VerifyResult {
  ok: boolean;
  message: string;
}

export interface PlatformAdapter {
  id: PlatformId;
  name: string;
  description: string;
  fields: FieldSchema[];
  /** 网络验证（main 侧调用；10s 超时由实现方保证） */
  verify: (fields: Record<string, string>) => Promise<VerifyResult>;
}

/** 磁盘存储形态（secret 字段 = enc: 前缀 base64 密文） */
export interface StoredConnection {
  id: string;
  platform: PlatformId;
  name: string;
  /** 非敏感明文 + 敏感密文 */
  fields: Record<string, string>;
  status: ConnectionStatus;
  lastError?: string;
  lastVerifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** 渲染层脱敏视图（secret 只出掩码） */
export interface ConnectionView {
  id: string;
  platform: PlatformId;
  name: string;
  /** 脱敏后的字段（secret → '****abcd'） */
  fields: Record<string, string>;
  status: ConnectionStatus;
  lastError?: string;
  lastVerifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}
