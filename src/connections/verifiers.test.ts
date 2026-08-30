import { test } from 'node:test';
import { equal, ok, match } from 'node:assert/strict';

import { buildAliyunQueryString, buildTc3Authorization, percentEncode } from './PlatformRegistry';

test('percentEncode：RFC3986（~ 不编码，+/ * 编码）', () => {
  equal(percentEncode('a+b/c*d~e'), 'a%2Bb%2Fc%2Ad~e');
  equal(percentEncode('abc123'), 'abc123');
});

test('buildAliyunQueryString：确定性 + 参数排序 + HMAC-SHA1 签名', () => {
  const fields = { accessKeyId: 'TESTAK', accessKeySecret: 'TESTSK' };
  const q1 = buildAliyunQueryString(fields, 'nonce-1', '2026-08-30T12:00:00Z');
  const q2 = buildAliyunQueryString(fields, 'nonce-1', '2026-08-30T12:00:00Z');
  equal(q1, q2, '同 nonce/timestamp 签名确定');
  ok(q1.includes('Action=QuerySmsTemplateList'));
  ok(q1.includes('SignatureMethod=HMAC-SHA1'));
  ok(q1.includes('SignatureNonce=nonce-1'));
  const sig = q1.split('&Signature=')[1];
  match(sig, /^[A-Za-z0-9%]+$/, '签名为 base64 的百分号编码');
  // 不同 nonce → 不同签名
  ok(q1 !== buildAliyunQueryString(fields, 'nonce-2', '2026-08-30T12:00:00Z'));
  // secret 参与 HMAC：换 secret 签名必变
  ok(q1 !== buildAliyunQueryString({ accessKeyId: 'TESTAK', accessKeySecret: 'OTHER' }, 'nonce-1', '2026-08-30T12:00:00Z'));
});

test('buildTc3Authorization：TC3-HMAC-SHA256 标准格式 + 确定性', () => {
  const input = {
    secretId: 'AKIDz8obbsWXXXXXXXXXXXXXXXXXXX',
    secretKey: 'TESTSK',
    service: 'sms',
    host: 'sms.tencentcloudapi.com',
    action: 'DescribeSmsTemplateList',
    version: '2021-01-11',
    body: '{}',
    timestamp: 1756579200, // 固定时间戳 → date 固定
  };
  const a1 = buildTc3Authorization(input);
  const a2 = buildTc3Authorization(input);
  equal(a1, a2, '同输入签名确定');
  match(a1, /^TC3-HMAC-SHA256 Credential=AKIDz8obbsWXXXXXXXXXXXXXXXXXXX\/\d{4}-\d{2}-\d{2}\/sms\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/);
  // secretKey 变 → 签名变
  ok(a1 !== buildTc3Authorization({ ...input, secretKey: 'OTHER' }));
});
