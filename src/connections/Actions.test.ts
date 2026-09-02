/**
 * 工作台连接能力层单测：SendSms（阿里/腾讯）+ SMTP 发信 + 派发入口。
 * 网络路径：阿里/腾讯注入 fake fetch；SMTP 起本地 net 假服务器（真实 socket 状态机集成测）。
 * 确定性：签名函数注入 nonce/timestamp；掩码纯函数。
 */
import { test } from 'node:test';
import { deepEqual, equal, match, ok, rejects } from 'node:assert/strict';
import * as net from 'node:net';

import { buildAliyunSignedQuery } from './PlatformRegistry';
import { invokeConnectionAction, maskRecipient, sendAliyunSms, sendSmtp, sendTencentSms } from './Actions';

// ── 掩码 ──

test('maskRecipient：手机号/邮箱/多值/短串', () => {
  equal(maskRecipient('13800001111'), '138****1111');
  equal(maskRecipient('alice@example.com'), 'a***@example.com');
  equal(maskRecipient('13800001111,13900002222'), '138****1111,139****2222');
  equal(maskRecipient('a@b.cn,c@d.cn'), 'a***@b.cn,c***@d.cn');
  equal(maskRecipient('12345'), '1***5');
});

// ── 阿里云 SendSms ──

test('buildAliyunSignedQuery：SendSms 动作 + 业务参数排序 + 确定性', () => {
  const fields = { accessKeyId: 'TESTAK', accessKeySecret: 'TESTSK' };
  const biz = { PhoneNumbers: '13800001111', TemplateCode: 'SMS_123', TemplateParam: '{"code":"1234"}' };
  const q1 = buildAliyunSignedQuery(fields, 'SendSms', biz, 'nonce-1', '2026-09-02T08:00:00Z');
  const q2 = buildAliyunSignedQuery(fields, 'SendSms', biz, 'nonce-1', '2026-09-02T08:00:00Z');
  equal(q1, q2, '同 nonce/timestamp 签名确定');
  ok(q1.includes('Action=SendSms'));
  ok(q1.includes('PhoneNumbers=13800001111'));
  ok(q1.includes('TemplateCode=SMS_123'));
  ok(q1.includes('SignatureMethod=HMAC-SHA1'));
  // 参数按字典序：Action 在 PhoneNumbers 之前、Timestamp 在末段 Signature 之前
  ok(q1.indexOf('Action=SendSms') < q1.indexOf('PhoneNumbers='));
  ok(q1.indexOf('Timestamp=') < q1.indexOf('Signature='));
  // 旧 QuerySmsTemplateList 构造不受影响（向后兼容）
  const old = buildAliyunSignedQuery(fields, 'QuerySmsTemplateList', { PageIndex: '1', PageSize: '1' }, 'n', 't');
  ok(old.includes('Action=QuerySmsTemplateList'));
});

test('sendAliyunSms：Code=OK 成功（含掩码）/ 业务错误码失败', async () => {
  const fields = { accessKeyId: 'AK', accessKeySecret: 'SK' };
  const params = { phoneNumbers: '13800001111', templateCode: 'SMS_1' };
  const okJson = async () => ({ Code: 'OK', BizId: 'B1', Message: 'send ok' });
  const r1 = await sendAliyunSms(fields, params, (async () => ({ ok: true, json: okJson })) as unknown as typeof fetch);
  equal(r1.ok, true);
  ok(r1.message.includes('138****1111'));
  const errJson = async () => ({ Code: 'isv.MOBILE_NUMBER_ILLEGAL', Message: '号码非法' });
  const r2 = await sendAliyunSms(fields, params, (async () => ({ ok: true, json: errJson })) as unknown as typeof fetch);
  equal(r2.ok, false);
  ok(r2.message.includes('isv.MOBILE_NUMBER_ILLEGAL'));
});

test('sendAliyunSms：缺模板/号码 → 参数校验失败（不发请求）', async () => {
  const r = await sendAliyunSms({ accessKeyId: 'AK', accessKeySecret: 'SK' }, { phoneNumbers: '' }, (async () => {
    throw new Error('不应发起请求');
  }) as unknown as typeof fetch);
  equal(r.ok, false);
  ok(r.message.includes('模板'));
});

// ── 腾讯云 SendSms ──

test('sendTencentSms：全号 Ok 成功 / Error 失败 / 部分失败列出', async () => {
  const fields = { secretId: 'SID', secretKey: 'SKEY' };
  const params = { phoneNumberSet: '+8613800001111,+8613900002222', templateId: '10001', templateParamSet: '["1234"]' };
  let capturedBody = '';
  const mk = (json: unknown) => (async (_u: unknown, init?: { body?: string }) => {
    capturedBody = init?.body || '';
    return { ok: true, json: async () => json };
  }) as unknown as typeof fetch;

  const r1 = await sendTencentSms(fields, params, mk({ Response: { SendStatusSet: [{ Code: 'Ok', Message: 'send success', PhoneNumber: '+8613800001111' }, { Code: 'Ok', Message: 'send success', PhoneNumber: '+8613900002222' }], RequestId: 'r' } }));
  equal(r1.ok, true);
  ok(r1.message.includes('138****1111'));
  const body = JSON.parse(capturedBody) as { PhoneNumberSet: string[]; TemplateId: string; TemplateParamSet: string[] };
  deepEqual(body.PhoneNumberSet, ['+8613800001111', '+8613900002222']);
  equal(body.TemplateId, '10001');
  deepEqual(body.TemplateParamSet, ['1234']);

  const r2 = await sendTencentSms(fields, params, mk({ Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: '签名错误' } } }));
  equal(r2.ok, false);
  ok(r2.message.includes('AuthFailure'));

  const r3 = await sendTencentSms(fields, params, mk({ Response: { SendStatusSet: [{ Code: 'Ok', Message: 'ok', PhoneNumber: '+8613800001111' }, { Code: 'FailedCode.InternalError', Message: '内部错误', PhoneNumber: '+8613900002222' }] } }));
  equal(r3.ok, false);
  ok(r3.message.includes('FailedCode.InternalError'));
  ok(r3.message.includes('139****2222'));
});

// ── SMTP 发信（本地假服务器，真实 socket 状态机）──

interface FakeSmtp {
  port: number;
  cmds: string[];
  readonly data: string | null;
  close: () => void;
}

/** 假 SMTP 服务器：220 → EHLO 250 → AUTH LOGIN 334/334/235 → MAIL 250 → RCPT 250 → DATA 354 → 正文捕获 → 250 → QUIT 221 */
function startFakeSmtp(): Promise<FakeSmtp> {
  return new Promise((resolve) => {
    const cmds: string[] = [];
    let data: string | null = null;
    let inData = false;
    let stage: 'ehlo' | 'auth-user' | 'auth-pass' | 'envelope-auth' | 'envelope' = 'ehlo';
    const server = net.createServer((sock) => {
      sock.on('error', () => { /* 客户端 finish() 即销毁连接，QUIT/221 竞态产生的 ECONNRESET 属预期 */ });
      let buf = '';
      sock.write('220 fake ESMTP\r\n');
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end !== -1) {
            data = buf.slice(0, end);
            inData = false;
            buf = buf.slice(end + 5);
            sock.write('250 Mail accepted\r\n');
          }
          return;
        }
        const lines = buf.split('\r\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line) continue;
          cmds.push(line);
          const cmd = line.toUpperCase();
          if (stage === 'ehlo' && cmd.startsWith('EHLO')) { sock.write('250-fake\r\n250-SIZE 10485760\r\n250 OK\r\n'); stage = 'auth-user'; continue; }
          if (stage === 'auth-user' && cmd === 'AUTH LOGIN') { sock.write('334 VXNlcm5hbWU6\r\n'); stage = 'auth-pass'; continue; }
          if (stage === 'auth-pass') { sock.write('334 UGFzc3dvcmQ6\r\n'); stage = 'envelope-auth'; continue; }
          if (stage === 'envelope-auth' && !cmd.startsWith('MAIL')) { sock.write('235 Authentication successful\r\n'); stage = 'envelope'; continue; }
          if (cmd === 'MAIL') { sock.write('250 OK\r\n'); continue; }
          if (cmd === 'RCPT') { sock.write('250 OK\r\n'); continue; }
          if (cmd === 'DATA') { inData = true; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); continue; }
          if (cmd === 'QUIT') { sock.write('221 Bye\r\n'); sock.end(); continue; }
          sock.write('250 OK\r\n');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        port: addr.port,
        cmds,
        get data() { return data; },
        close: () => server.close(),
      });
    });
  });
}

test('sendSmtp：完整发信链（AUTH → MAIL → RCPT×2 → DATA 正文/头/点填充）', async () => {
  const fake = await startFakeSmtp();
  try {
    const fields = { host: '127.0.0.1', port: String(fake.port), secure: 'false', username: 'sender@test.local', password: 'pw' };
    const r = await sendSmtp(fields, {
      to: 'a@x.com, b@y.com',
      subject: '发布提醒',
      body: 'Hi there\n.leading dot line',
    });
    equal(r.ok, true, `发信应成功: ${r.message}`);
    ok(r.message.includes('a***@x.com'));
    // 信封命令
    ok(fake.cmds.some((c) => c === 'MAIL FROM:<sender@test.local>'));
    ok(fake.cmds.some((c) => c === 'RCPT TO:<a@x.com>'));
    ok(fake.cmds.some((c) => c === 'RCPT TO:<b@y.com>'));
    // DATA 内容：头 + 正文 + 点填充
    const data = fake.data || '';
    ok(data.includes('From: <sender@test.local>'));
    ok(data.includes('To: a@x.com, b@y.com'));
    match(data, /Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/, '非 ASCII 主题按 RFC2047 B 编码');
    ok(data.includes('Content-Type: text/plain; charset=utf-8'));
    ok(data.includes('Hi there'));
    ok(data.includes('..leading dot line'), '以.开头的正文行需点填充');
    // 头在空行之前，正文在空行之后
    const sep = data.indexOf('\r\n\r\n');
    ok(sep > 0);
  } finally {
    fake.close();
  }
});

test('sendSmtp：CRLF 头注入拒绝（to/subject/from）+ 缺发件人报错', async () => {
  const fields = { host: '127.0.0.1', port: '1', secure: 'false', username: 'u@test.local', password: 'p' };
  await rejects(() => sendSmtp(fields, { to: 'a@x.com\r\nBCC: evil@x.com', subject: 's' }), /换行/);
  await rejects(() => sendSmtp(fields, { to: 'a@x.com', subject: 's\r\nX: y' }), /换行/);
  await rejects(() => sendSmtp({ ...fields, username: '' }, { to: 'a@x.com', subject: 's' }), /发件人/);
});

// ── 派发入口 ──

test('invokeConnectionAction：平台派发 + salesforce 不支持 + 缺参校验', async () => {
  const sf = await invokeConnectionAction('salesforce', {}, {});
  equal(sf.ok, false);
  ok(sf.message.includes('暂不支持'));

  const missing = await invokeConnectionAction('aliyun-sms', { accessKeyId: 'A', accessKeySecret: 'S' }, {});
  equal(missing.ok, false);

  const okRes = await invokeConnectionAction(
    'aliyun-sms',
    { accessKeyId: 'AK', accessKeySecret: 'SK' },
    { phoneNumbers: '13800001111', templateCode: 'T1' },
    (async () => ({ ok: true, json: async () => ({ Code: 'OK' }) })) as unknown as typeof fetch
  );
  equal(okRes.ok, true);
});
