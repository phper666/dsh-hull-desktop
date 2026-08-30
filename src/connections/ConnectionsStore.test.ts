import { test } from 'node:test';
import { equal, ok, throws } from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConnectionsStore, type SafeStorageAdapter } from './ConnectionsStore';
import { PLATFORM_ADAPTERS } from './PlatformRegistry';

/** fake 加密：base64 加 "FAKE:" 前缀（可逆，便于断言加解密对称） */
function fakeEncryption(): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from('FAKE:' + plain, 'utf8'),
    decryptString: (buf) => {
      const s = buf.toString('utf8');
      if (!s.startsWith('FAKE:')) throw new Error('无法解密');
      return s.slice(5);
    },
  };
}

function makeStore(unavailable = false): { store: ConnectionsStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hull-connections-'));
  const encryption = unavailable
    ? { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' }
    : fakeEncryption();
  return { store: new ConnectionsStore({ userDataPath: dir, adapters: PLATFORM_ADAPTERS, encryption }), dir };
}

test('platforms：四平台 schema 暴露（salesforce/aliyun-sms/tencent-sms/smtp）', () => {
  const { store } = makeStore();
  const platforms = store.platforms();
  equal(platforms.length, 4);
  ok(platforms.every((p) => p.fields.length >= 2));
  ok(platforms.find((p) => p.id === 'salesforce')?.fields.some((f) => f.key === 'as' && f.secret));
});

test('save 新建：secret 加密落盘（enc: 前缀）+ 明文不落盘', () => {
  const { store, dir } = makeStore();
  store.save({ platform: 'salesforce', name: '生产 SF', fields: { instanceUrl: 'https://demo.my.salesforce.com', ak: 'client-key-123', as: 'super-secret-999' } });
  const raw = readFileSync(join(dir, 'connections', 'connections.json'), 'utf8');
  ok(!raw.includes('super-secret-999'), '明文 secret 不得落盘');
  ok(raw.includes('enc:'), 'secret 应为 enc: 密文');
  ok(raw.includes('https://demo.my.salesforce.com'), '非敏感字段明文存储');
});

test('list：secret 脱敏为 ****尾4，非 secret 明文', () => {
  const { store } = makeStore();
  store.save({ platform: 'salesforce', name: 'SF', fields: { instanceUrl: 'https://x.salesforce.com', ak: 'client-key-123', as: 'super-secret-999' } });
  const view = store.list()[0];
  equal(view.fields.as, '****-999');
  equal(view.fields.instanceUrl, 'https://x.salesforce.com');
  equal(view.status, 'unverified');
});

test('编辑：secret 留空 = 保留原值；非 secret 更新生效', () => {
  const { store } = makeStore();
  const v = store.save({ platform: 'salesforce', name: 'SF', fields: { instanceUrl: 'https://a.com', ak: 'key1', as: 'old-secret' } });
  const v2 = store.save({ id: v.id, platform: 'salesforce', name: 'SF-2', fields: { instanceUrl: 'https://b.com', ak: 'key1', as: '' } });
  equal(v2.name, 'SF-2');
  equal(v2.fields.instanceUrl, 'https://b.com');
  // 解密凭据确认 as 保留
  const cred = store.getCredentials(v.id);
  equal(cred?.fields.as, 'old-secret');
});

test('safeStorage 不可用 → save 抛错（拒绝明文降级）', () => {
  const { store } = makeStore(true);
  throws(() => store.save({ platform: 'smtp', name: 'mail', fields: { host: 'smtp.x.com', port: '465', secure: 'true', username: 'u', password: 'p' } }), /安全加密不可用/);
});

test('delete：移除连接', () => {
  const { store } = makeStore();
  const v = store.save({ platform: 'aliyun-sms', name: '阿里云', fields: { accessKeyId: 'ak', accessKeySecret: 'sk' } });
  equal(store.delete(v.id), true);
  equal(store.list().length, 0);
  equal(store.delete(v.id), false);
});

test('recordResult：状态与 lastError 落盘', () => {
  const { store } = makeStore();
  const v = store.save({ platform: 'tencent-sms', name: '腾讯云', fields: { secretId: 'id', secretKey: 'key' } });
  store.recordResult(v.id, 'failed', '凭据验证失败（AuthFailure）');
  const view = store.list().find((x) => x.id === v.id);
  equal(view?.status, 'failed');
  ok(view?.lastError?.includes('AuthFailure'));
  store.recordResult(v.id, 'connected');
  ok(store.list().find((x) => x.id === v.id)?.lastVerifiedAt);
});

test('getCredentials：main 侧解密通道（渲染层 IPC 不暴露）', () => {
  const { store } = makeStore();
  const v = store.save({ platform: 'smtp', name: 'mail', fields: { host: 'smtp.x.com', port: '465', secure: 'true', username: 'u', password: 'p-1234' } });
  const cred = store.getCredentials(v.id);
  equal(cred?.fields.password, 'p-1234');
  equal(store.getCredentials('nope'), null);
});
