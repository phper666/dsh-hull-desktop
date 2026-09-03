/**
 * 工作台连接能力层（Actions）：已连接凭据 → 实际能力调用（发短信/发邮件）。
 * 设计：docs/design/工作流-workflows-design.md §7.2（工作流 connection-action 步骤的 main 侧执行层）。
 * 安全：只接收 main 侧解密后的 fields（ConnectionsStore.getCredentials）；错误信息不含 secret；
 * 收件人在返回 message 中掩码；SMTP to/subject/from 含 CR/LF 直接拒绝（头注入防护）。
 */
import * as crypto from 'node:crypto';

import { buildAliyunSignedQuery, buildTc3Authorization, sendFetch, type Tc3Input } from './PlatformRegistry';
import type { PlatformId, VerifyResult } from './types';

export type ActionResult = VerifyResult;

/** 可注入的 fetch（测试 fake；生产用 sendFetch） */
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

// ── 掩码（收件人进运行日志前的脱敏）──

/** 手机号掩首位国家码后取 138****1111；邮箱掩 a***@domain；其余取首尾字符 */
export function maskRecipient(raw: string): string {
  return raw
    .split(',')
    .map((s) => {
      const v = s.trim();
      if (!v) return v;
      const atIdx = v.indexOf('@');
      if (atIdx > 0) return `${v[0]}***${v.slice(atIdx)}`;
      let digits = v.replace(/\D/g, '');
      if (digits.length >= 13 && digits.startsWith('86')) digits = digits.slice(2); // +86 前缀
      if (digits.length >= 7) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
      return `${v[0]}***${v[v.length - 1]}`;
    })
    .join(',');
}

function assertNoCRLF(label: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`${label} 不能包含换行符（头注入防护）`);
}

// ── 阿里云短信 SendSms ──

export async function sendAliyunSms(fields: Record<string, string>, params: Record<string, string>, fetchImpl: FetchImpl = sendFetch): Promise<ActionResult> {
  const phoneNumbers = (params.phoneNumbers || '').trim();
  const templateCode = (params.templateCode || '').trim();
  if (!phoneNumbers || !templateCode) return { ok: false, message: '阿里云短信发送需要 phoneNumbers（号码）与 templateCode（模板）' };
  const biz: Record<string, string> = { PhoneNumbers: phoneNumbers, TemplateCode: templateCode };
  if (params.templateParam) biz.TemplateParam = params.templateParam;
  const query = buildAliyunSignedQuery(fields, 'SendSms', biz, crypto.randomUUID(), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
  try {
    const res = await fetchImpl(`https://dysmsapi.aliyuncs.com/?${query}`);
    const json = (await res.json().catch(() => ({}))) as { Code?: string; Message?: string };
    if (json.Code === 'OK') return { ok: true, message: `短信已发送至 ${maskRecipient(phoneNumbers)}` };
    return { ok: false, message: `短信发送失败（${json.Code || res.status}）: ${json.Message || ''}`.trim() };
  } catch (err) {
    return { ok: false, message: `网络错误: ${(err as Error).message}` };
  }
}

// ── 腾讯云短信 SendSms ──

export async function sendTencentSms(fields: Record<string, string>, params: Record<string, string>, fetchImpl: FetchImpl = sendFetch): Promise<ActionResult> {
  const host = 'sms.tencentcloudapi.com';
  const phoneSet = (params.phoneNumberSet || '').split(',').map((s) => s.trim()).filter(Boolean);
  const templateId = (params.templateId || '').trim();
  if (!phoneSet.length || !templateId) return { ok: false, message: '腾讯云短信发送需要 phoneNumberSet（号码）与 templateId（模板）' };
  const bodyObj: Record<string, unknown> = { PhoneNumberSet: phoneSet, TemplateId: templateId };
  if (params.templateParamSet) {
    try {
      bodyObj.TemplateParamSet = JSON.parse(params.templateParamSet);
    } catch {
      return { ok: false, message: 'templateParamSet 需为 JSON 数组字符串（如 ["1234"]）' };
    }
  }
  const body = JSON.stringify(bodyObj);
  const timestamp = Math.floor(Date.now() / 1000);
  const input: Tc3Input = {
    secretId: fields.secretId || '',
    secretKey: fields.secretKey || '',
    service: 'sms',
    host,
    action: 'SendSms',
    version: '2021-01-11',
    body,
    timestamp,
  };
  try {
    const res = await fetchImpl(`https://${host}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Host: host,
        Authorization: buildTc3Authorization(input),
        'X-TC-Action': input.action,
        'X-TC-Version': input.version,
        'X-TC-Timestamp': String(input.timestamp),
      },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as {
      Response?: { Error?: { Code?: string; Message?: string }; SendStatusSet?: Array<{ Code?: string; Message?: string; PhoneNumber?: string }> };
    };
    const errCode = json.Response?.Error?.Code;
    if (errCode) return { ok: false, message: `短信发送失败（${errCode}）: ${json.Response?.Error?.Message || ''}`.trim() };
    const set = json.Response?.SendStatusSet;
    if (!Array.isArray(set) || !set.length) return { ok: false, message: '短信发送失败：响应缺少 SendStatusSet' };
    const failed = set.filter((s) => s.Code !== 'Ok');
    if (failed.length) {
      const detail = failed.map((s) => `${maskRecipient(s.PhoneNumber || '')}: ${s.Code || '未知'} ${s.Message || ''}`.trim()).join('；');
      return { ok: false, message: `部分号码发送失败: ${detail}` };
    }
    return { ok: true, message: `短信已发送至 ${maskRecipient(phoneSet.join(','))}` };
  } catch (err) {
    return { ok: false, message: `网络错误: ${(err as Error).message}` };
  }
}

// ── SMTP 发信（握手 + AUTH + 信封 + DATA，纯 net/tls，无 nodemailer）──

const SEND_TIMEOUT_MS = 30_000;

export async function sendSmtp(fields: Record<string, string>, params: Record<string, string>): Promise<ActionResult> {
  const net = require('node:net') as typeof import('node:net');
  const tls = require('node:tls') as typeof import('node:tls');
  const host = fields.host || '';
  const port = Number(fields.port || (fields.secure === 'true' ? 465 : 587));
  const secure = fields.secure === 'true';
  const to = (params.to || '').trim();
  const subject = params.subject || '';
  const bodyText = params.body ?? '';
  const from = (params.from || fields.username || '').trim();
  if (!host) throw new Error('SMTP 连接缺少 host（请检查连接配置）');
  if (!to) throw new Error('SMTP 发信需要收件人（to）');
  if (!from) throw new Error('缺少发件人（params.from 或连接用户名）');
  for (const [label, v] of [['收件人', to], ['主题', subject], ['发件人', from]] as const) assertNoCRLF(label, v);

  const recipients = to.split(',').map((s) => s.trim()).filter(Boolean);
  // RFC2047 B 编码非 ASCII 主题
  const encodedSubject = /^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  // 点填充：正文行首为 . 的加一个 .（DATA 透明性）
  const stuffed = bodyText.replace(/^\./gm, '..');
  const payload = [
    `From: <${from}>`,
    `To: ${recipients.join(', ')}`,
    `Subject: ${encodedSubject}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    stuffed,
  ].join('\r\n');

  return new Promise<ActionResult>((resolve) => {
    let settled = false;
    let socket: import('node:net').Socket | null = null;
    let timer: NodeJS.Timeout | null = null;
    const finish = (r: ActionResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { socket?.destroy(); } catch { /* ignore */ }
      resolve(r);
    };
    timer = setTimeout(() => finish({ ok: false, message: '发信超时（30s）' }), SEND_TIMEOUT_MS);

    // 状态机：banner → EHLO → AUTH LOGIN（334 用户名挑战 → 334 密码挑战 → 235）→ MAIL → RCPT×N → DATA(354) → 正文+`.` → 250 → QUIT
    let stage: 'banner' | 'ehlo' | 'auth-user' | 'auth-pass' | 'auth-accepted' | 'mail' | 'rcpt' | 'data' | 'sent' = 'banner';
    let rcptIdx = 0;
    let buf = '';
    const send = (s: string) => socket?.write(`${s}\r\n`);
    const fail = (what: string, line: string): ActionResult => ({ ok: false, message: `SMTP 发信失败（${what}）: ${line.slice(4) || line}` });
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        const code = Number(line.slice(0, 3));
        if (line.slice(3, 4) === '-' && stage !== 'sent') continue; // 多行中间行
        if (stage === 'banner') {
          if (code !== 220) return finish(fail('握手', line));
          stage = 'ehlo';
          send('EHLO hull.local');
        } else if (stage === 'ehlo') {
          if (code >= 400) return finish(fail('EHLO', line));
          if (fields.username && fields.password) {
            stage = 'auth-user';
            send('AUTH LOGIN');
          } else {
            stage = 'mail';
            send(`MAIL FROM:<${from}>`);
          }
        } else if (stage === 'auth-user') {
          if (code !== 334) return finish(fail('认证（用户名挑战缺失）', line));
          stage = 'auth-pass';
          send(Buffer.from(fields.username, 'utf8').toString('base64'));
        } else if (stage === 'auth-pass') {
          if (code !== 334) return finish(fail('认证（密码挑战缺失）', line));
          stage = 'auth-accepted';
          send(Buffer.from(fields.password, 'utf8').toString('base64'));
        } else if (stage === 'auth-accepted') {
          if (code !== 235) return finish(fail('认证（凭据被拒）', line));
          stage = 'mail';
          send(`MAIL FROM:<${from}>`);
        } else if (stage === 'mail') {
          if (code >= 400) return finish(fail('发件人被拒', line));
          stage = 'rcpt';
          send(`RCPT TO:<${recipients[0]}>`);
        } else if (stage === 'rcpt') {
          if (code >= 400) return finish(fail('收件人被拒', line));
          rcptIdx += 1;
          if (rcptIdx < recipients.length) send(`RCPT TO:<${recipients[rcptIdx]}>`);
          else {
            stage = 'data';
            send('DATA');
          }
        } else if (stage === 'data') {
          if (code !== 354) return finish(fail('DATA', line));
          stage = 'sent';
          socket?.write(`${payload}\r\n.\r\n`);
        } else if (stage === 'sent') {
          if (code >= 400) return finish(fail('服务器拒收', line));
          send('QUIT');
          return finish({ ok: true, message: `邮件已发送至 ${maskRecipient(recipients.join(','))}` });
        }
      }
    };
    const wire = (sock: import('node:net').Socket) => {
      sock.setEncoding('utf8');
      sock.on('data', onData);
      sock.on('error', (e) => finish({ ok: false, message: `连接错误: ${e.message}` }));
    };
    try {
      socket = secure
        ? tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => wire(socket as import('node:tls').TLSSocket))
        : net.connect({ host, port }, () => wire(socket as import('node:net').Socket));
      socket?.on('error', (e) => finish({ ok: false, message: `连接错误: ${e.message}` }));
    } catch (err) {
      finish({ ok: false, message: `连接失败: ${(err as Error).message}` });
    }
  });
}

// ── 派发入口（工作流 connection-action 步骤调用）──

export async function invokeConnectionAction(platform: PlatformId, fields: Record<string, string>, params: Record<string, string>, fetchImpl?: FetchImpl): Promise<ActionResult> {
  try {
    switch (platform) {
      case 'smtp':
        return await sendSmtp(fields, params);
      case 'aliyun-sms':
        return await sendAliyunSms(fields, params, fetchImpl ?? sendFetch);
      case 'tencent-sms':
        return await sendTencentSms(fields, params, fetchImpl ?? sendFetch);
      case 'salesforce':
        return { ok: false, message: 'Salesforce 暂不支持动作调用（v2 范围外，仅连接验证）' };
      default:
        return { ok: false, message: `未知平台: ${platform}` };
    }
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
