/**
 * 平台适配器注册表（数据驱动）：v1 四平台的字段 schema + 网络验证器。
 * 新增平台 = 新增一个 adapter 对象（schema 驱动渲染表单；verify 为网络验证）并加入 ADAPTERS。
 * 约定：verify 超时 10s；错误信息不含 secret；凭据类错误与网络/参数类错误分开表述。
 * 安全：verify 只在 main 侧以解密后的凭据调用（ConnectionsStore.getCredentials）。
 */
import * as crypto from 'node:crypto';

import type { FieldSchema, PlatformAdapter, PlatformId, VerifyResult } from './types';

const VERIFY_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = VERIFY_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 动作调用共用 fetch（发短信等：30s 超时，与 10s 验证区分） */
export function sendFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithTimeout(url, init, 30_000);
}

function networkError(err: unknown): VerifyResult {
  return { ok: false, message: `网络错误: ${(err as Error).message}` };
}

// ── Salesforce（OAuth2 client_credentials + limits 能力调用）──

function normalizeInstanceUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export async function verifySalesforce(fields: Record<string, string>): Promise<VerifyResult> {
  const base = normalizeInstanceUrl(fields.instanceUrl || '');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: fields.ak || '',
    client_secret: fields.as || '',
  });
  let token: string;
  try {
    const res = await fetchWithTimeout(`${base}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
    if (!res.ok || !json.access_token) {
      return { ok: false, message: `凭据验证失败（${json.error || res.status}）：${json.error_description || '请检查 ak/as 与实例地址'}` };
    }
    token = json.access_token;
  } catch (err) {
    return networkError(err);
  }
  try {
    const res = await fetchWithTimeout(`${base}/services/data/v59.0/limits`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return { ok: false, message: `能力调用失败（HTTP ${res.status}）——凭据可能缺 API 权限` };
    return { ok: true, message: 'Salesforce 连接成功' };
  } catch (err) {
    return networkError(err);
  }
}

// ── 阿里云短信（RPC V1 签名 + QuerySmsTemplateList）──

/** RFC3986 百分号编码（阿里云签名规范：~ 不编码） */
export function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
}

/** 构造签名后完整 query（通用：action + 业务参数，供验证与 SendSms 等动作复用；确定性：nonce/timestamp 注入 → 可单测） */
export function buildAliyunSignedQuery(fields: Record<string, string>, action: string, biz: Record<string, string>, nonce: string, timestamp: string): string {
  const params: Record<string, string> = {
    AccessKeyId: fields.accessKeyId || '',
    Action: action,
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: nonce,
    SignatureVersion: '1.0',
    Timestamp: timestamp,
    Version: '2017-05-25',
    ...biz,
  };
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonical)}`;
  const signature = crypto.createHmac('sha1', `${fields.accessKeySecret || ''}&`).update(stringToSign).digest('base64');
  return `${canonical}&Signature=${percentEncode(signature)}`;
}

/** v1 模板列表验证 query（兼容保留，委托通用构造） */
export function buildAliyunQueryString(fields: Record<string, string>, nonce: string, timestamp: string): string {
  return buildAliyunSignedQuery(fields, 'QuerySmsTemplateList', { PageIndex: '1', PageSize: '1' }, nonce, timestamp);
}

export async function verifyAliyunSms(fields: Record<string, string>): Promise<VerifyResult> {
  let query: string;
  try {
    query = buildAliyunQueryString(fields, crypto.randomUUID(), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
  } catch (err) {
    return { ok: false, message: `签名构造失败: ${(err as Error).message}` };
  }
  try {
    const res = await fetchWithTimeout(`https://dysmsapi.aliyuncs.com/?${query}`);
    const json = (await res.json().catch(() => ({}))) as { Code?: string; Message?: string };
    if (json.Code === 'OK') return { ok: true, message: '阿里云短信连接成功' };
    if (json.Code === 'SignatureDoesNotMatch' || json.Code === 'InvalidAccessKeyId.NotFound') {
      return { ok: false, message: `凭据验证失败（${json.Code}）：请检查 AccessKeyId/AccessKeySecret` };
    }
    // 非鉴权类错误（如账号无模板）→ 鉴权已通过，凭据有效
    return { ok: true, message: `凭据有效（提示: ${json.Code || res.status} ${json.Message || ''}）` };
  } catch (err) {
    return networkError(err);
  }
}

// ── 腾讯云短信（TC3-HMAC-SHA256 + DescribeSmsTemplateList）──

export interface Tc3Input {
  secretId: string;
  secretKey: string;
  service: string;
  host: string;
  action: string;
  version: string;
  body: string;
  timestamp: number;
}

/** TC3-HMAC-SHA256 签名（腾讯云标准链）→ Authorization 头值（确定性可单测） */
export function buildTc3Authorization(input: Tc3Input): string {
  const date = new Date(input.timestamp * 1000).toISOString().slice(0, 10);
  const hashedBody = crypto.createHash('sha256').update(input.body).digest('hex');
  const canonicalRequest = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${input.host}\n\ncontent-type:application/json; charset=utf-8\nhost:${input.host}\n${hashedBody}`;
  const stringToSign = `TC3-HMAC-SHA256\n${input.timestamp}\n${date}/${input.service}/tc3_request\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;
  const kDate = crypto.createHmac('sha256', `TC3${input.secretKey}`).update(date).digest();
  const kService = crypto.createHmac('sha256', kDate).update(input.service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('tc3_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `TC3-HMAC-SHA256 Credential=${input.secretId}/${date}/${input.service}/tc3_request, SignedHeaders=content-type;host, Signature=${signature}`;
}

export async function verifyTencentSms(fields: Record<string, string>): Promise<VerifyResult> {
  const host = 'sms.tencentcloudapi.com';
  const body = JSON.stringify({});
  const input: Tc3Input = {
    secretId: fields.secretId || '',
    secretKey: fields.secretKey || '',
    service: 'sms',
    host,
    action: 'DescribeSmsTemplateList',
    version: '2021-01-11',
    body,
    timestamp: Math.floor(Date.now() / 1000),
  };
  try {
    const res = await fetchWithTimeout(`https://${host}/`, {
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
    const json = (await res.json().catch(() => ({}))) as { Response?: { Error?: { Code?: string; Message?: string } } };
    const errCode = json.Response?.Error?.Code;
    if (!errCode) return { ok: true, message: '腾讯云短信连接成功' };
    if (errCode.startsWith('AuthFailure')) return { ok: false, message: `凭据验证失败（${errCode}）：请检查 SecretId/SecretKey` };
    // 参数类错误发生在鉴权之后 → 鉴权已通过，凭据有效
    return { ok: true, message: `凭据有效（提示: ${errCode} ${json.Response?.Error?.Message || ''}）` };
  } catch (err) {
    return networkError(err);
  }
}

// ── SMTP（握手 + EHLO + 可选 AUTH LOGIN，不发信）──

export async function verifySmtp(fields: Record<string, string>): Promise<VerifyResult> {
  const net = require('node:net') as typeof import('node:net');
  const tls = require('node:tls') as typeof import('node:tls');
  const host = fields.host || '';
  const port = Number(fields.port || (fields.secure === 'true' ? 465 : 587));
  const secure = fields.secure === 'true';

  return new Promise<VerifyResult>((resolve) => {
    let settled = false;
    let socket: import('node:net').Socket | null = null;
    let timer: NodeJS.Timeout | null = null;
    const finish = (r: VerifyResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { socket?.destroy(); } catch { /* ignore */ }
      resolve(r);
    };
    timer = setTimeout(() => finish({ ok: false, message: '连接超时（10s）' }), VERIFY_TIMEOUT_MS);

    // 状态机：banner(220) → EHLO → [AUTH LOGIN 用户名挑战(334) → 密码挑战(334) → 235] → QUIT
    let stage: 'banner' | 'ehlo' | 'auth-user' | 'auth-pass' | 'auth-accepted' = 'banner';
    let buf = '';
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        const code = Number(line.slice(0, 3));
        if (stage === 'banner') {
          if (code !== 220) return finish({ ok: false, message: `SMTP 握手失败: ${line}` });
          stage = 'ehlo';
          socket?.write('EHLO hull.local\r\n');
        } else if (stage === 'ehlo') {
          if (code >= 400) return finish({ ok: false, message: `EHLO 失败: ${line}` });
          if (line.slice(3, 4) === '-') continue; // EHLO 多行中间行
          if (!fields.username) { socket?.write('QUIT\r\n'); return finish({ ok: true, message: 'SMTP 连接成功（未填认证凭据，仅握手验证）' }); }
          stage = 'auth-user';
          socket?.write('AUTH LOGIN\r\n');
        } else if (stage === 'auth-user') {
          if (code !== 334) return finish({ ok: false, message: `认证失败（用户名被拒）: ${line.slice(4) || line}` });
          stage = 'auth-pass';
          socket?.write(Buffer.from(fields.username, 'utf8').toString('base64') + '\r\n');
        } else if (stage === 'auth-pass') {
          if (code !== 334) return finish({ ok: false, message: `认证失败（密码挑战缺失）: ${line.slice(4) || line}` });
          stage = 'auth-accepted';
          socket?.write(Buffer.from(fields.password, 'utf8').toString('base64') + '\r\n');
        } else if (stage === 'auth-accepted') {
          if (code !== 235) return finish({ ok: false, message: `认证失败（凭据被拒）: ${line.slice(4) || line}` });
          socket?.write('QUIT\r\n');
          return finish({ ok: true, message: 'SMTP 连接成功（认证通过）' });
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

// ── 适配器注册表（数据驱动；渲染层表单 schema 消费）──

export const PLATFORM_ADAPTERS: PlatformAdapter[] = [
  {
    id: 'salesforce',
    name: 'Salesforce',
    description: '通过 External Client App 凭据连接 Salesforce（OAuth2 client_credentials）',
    fields: [
      { key: 'instanceUrl', label: '实例地址', required: true, type: 'url', placeholder: 'https://xxx.my.salesforce.com' },
      { key: 'ak', label: 'API Key（Client ID）', required: true, placeholder: 'External Client App 的 Consumer Key' },
      { key: 'as', label: 'API Secret（Client Secret）', required: true, secret: true },
    ],
    verify: verifySalesforce,
  },
  {
    id: 'aliyun-sms',
    name: '阿里云短信',
    description: '通过 AccessKey 连接阿里云短信服务（验证短信模板查询权限）',
    fields: [
      { key: 'accessKeyId', label: 'AccessKeyId', required: true },
      { key: 'accessKeySecret', label: 'AccessKeySecret', required: true, secret: true },
    ],
    verify: verifyAliyunSms,
  },
  {
    id: 'tencent-sms',
    name: '腾讯云短信',
    description: '通过 SecretId/SecretKey 连接腾讯云短信服务（TC3 签名）',
    fields: [
      { key: 'secretId', label: 'SecretId', required: true },
      { key: 'secretKey', label: 'SecretKey', required: true, secret: true },
    ],
    verify: verifyTencentSms,
  },
  {
    id: 'smtp',
    name: 'SMTP 邮件',
    description: '连接 SMTP 服务器（握手 + 可选认证验证，不发信）',
    fields: [
      { key: 'host', label: 'SMTP 服务器', required: true, placeholder: 'smtp.example.com' },
      { key: 'port', label: '端口', required: true, placeholder: '465 / 587 / 25' },
      { key: 'secure', label: 'SSL/TLS', required: false, type: 'switch', switchOnValue: 'true', hint: '开 = 隐式 TLS（通常 465）；关 = 明文/STARTTLS（587/25）' },
      { key: 'username', label: '用户名', required: false, hint: '留空则仅验证连接与握手' },
      { key: 'password', label: '密码 / 授权码', required: false, secret: true },
    ],
    verify: verifySmtp,
  },
];

export function getPlatformAdapter(id: PlatformId): PlatformAdapter | null {
  return PLATFORM_ADAPTERS.find((a) => a.id === id) ?? null;
}
