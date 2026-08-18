import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { Readable } from 'node:stream';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { ReadinessProbe, type HttpGetFn } from './ReadinessProbe';

/** 按 push 顺序逐 chunk 发出（每个 push 独立 data 事件），末尾 end */
function streamFrom(chunks: (string | Buffer)[]): Readable {
  const s = new Readable({ read() {} });
  for (const c of chunks) s.push(c);
  s.push(null);
  return s;
}

/** 永不结束的空流（无数据、无 end，用于就绪行超时场景） */
function openStream(): Readable {
  return new Readable({ read() {} });
}

/** 立即结束的空流 */
function emptyStream(): Readable {
  return streamFrom([]);
}

function errWithCode(code: string): Error {
  const e = new Error(`connect ${code}`);
  (e as NodeJS.ErrnoException).code = code;
  return e;
}

const URL = 'http://127.0.0.1:53421';
const READY_LINE = `dsh web: ${URL}\n`;

test('就绪行命中：提取 URL，探测成功', async () => {
  const probe = new ReadinessProbe({ httpGet: async () => ({ status: 200 }) });
  const r = await probe.probe(streamFrom([READY_LINE]), emptyStream());
  equal(r.ok, true);
  equal(r.url, URL);
});

test('ANSI CSI 前缀 + CRLF 就绪行：剥离后命中', async () => {
  const probe = new ReadinessProbe({ httpGet: async () => ({ status: 200 }) });
  const r = await probe.probe(streamFrom([`\x1b[32mdsh web: ${URL}\r\n`]), emptyStream());
  equal(r.ok, true);
  equal(r.url, URL);
});

test('半行重组：就绪行跨 chunk 到达', async () => {
  const probe = new ReadinessProbe({ httpGet: async () => ({ status: 200 }) });
  const r = await probe.probe(streamFrom([`dsh web: ${URL.slice(0, -3)}`, `${URL.slice(-3)}\n`]), emptyStream());
  equal(r.ok, true);
  equal(r.url, URL);
});

test('流结束残留半行：无尾 \\n 也命中', async () => {
  const probe = new ReadinessProbe({ httpGet: async () => ({ status: 200 }) });
  const r = await probe.probe(streamFrom([`dsh web: ${URL}`]), emptyStream());
  equal(r.ok, true);
  equal(r.url, URL);
});

test('单行超 8KB 截断后，后续就绪行仍命中', async () => {
  const probe = new ReadinessProbe({ httpGet: async () => ({ status: 200 }) });
  const giant = 'A'.repeat(9000);
  const r = await probe.probe(streamFrom([giant, `\ndsh web: ${URL}\n`]), emptyStream());
  equal(r.ok, true);
  equal(r.url, URL);
});

test('双流任一命中：就绪行出现在 stderr', async () => {
  const probe = new ReadinessProbe({ httpGet: async () => ({ status: 200 }) });
  const r = await probe.probe(emptyStream(), streamFrom([READY_LINE]));
  equal(r.ok, true);
  equal(r.url, URL);
});

test('就绪行 60s 预算（注入 50ms）：超时 → failed(ready-line-timeout)', async () => {
  const probe = new ReadinessProbe({ readyTimeoutMs: 50 });
  const r = await probe.probe(openStream(), openStream());
  equal(r.ok, false);
  equal(r.reason, 'ready-line-timeout');
});

test('双流结束未命中 → failed(streams-ended)', async () => {
  const probe = new ReadinessProbe();
  const r = await probe.probe(emptyStream(), emptyStream());
  equal(r.ok, false);
  equal(r.reason, 'streams-ended');
});

test('探测 15s 窗口耗尽 → failed(probe-window-exhausted)，URL 保留', async () => {
  let t = 0;
  const probe = new ReadinessProbe({
    httpGet: async () => {
      throw errWithCode('ECONNREFUSED');
    },
    now: () => t,
    sleep: async () => {
      t += 500;
    },
  });
  const r = await probe.probe(streamFrom([READY_LINE]), emptyStream());
  equal(r.ok, false);
  equal(r.reason, 'probe-window-exhausted');
  equal(r.url, URL); // 就绪行已见，URL 保留
});

test('网络错误（ECONNREFUSED）继续重试，恢复后成功', async () => {
  let attempts = 0;
  const httpGet: HttpGetFn = async () => {
    attempts += 1;
    if (attempts <= 2) throw errWithCode('ECONNREFUSED');
    return { status: 200 };
  };
  const probe = new ReadinessProbe({ httpGet, intervalMs: 5 });
  const r = await probe.probe(streamFrom([READY_LINE]), emptyStream());
  equal(r.ok, true);
  equal(r.url, URL);
  equal(attempts, 3);
});

test('非 200 响应继续重试（503 → 200）', async () => {
  let attempts = 0;
  const httpGet: HttpGetFn = async () => {
    attempts += 1;
    return attempts <= 2 ? { status: 503 } : { status: 200 };
  };
  const probe = new ReadinessProbe({ httpGet, intervalMs: 5 });
  const r = await probe.probe(streamFrom([READY_LINE]), emptyStream());
  equal(r.ok, true);
  equal(attempts, 3);
});

test('注入目标仅作用探测：HTTP 打注入目标，结果 URL 恒为就绪行 URL', async () => {
  const seen: string[] = [];
  const httpGet: HttpGetFn = async (u) => {
    seen.push(u);
    return { status: 200 };
  };
  const probe = new ReadinessProbe({ target: 'http://127.0.0.1:9999', httpGet });
  const r = await probe.probe(streamFrom([READY_LINE]), emptyStream());
  equal(r.ok, true);
  equal(r.url, URL);
  ok(seen.length > 0);
  for (const u of seen) equal(u, 'http://127.0.0.1:9999');
});

test('真实回环：先 ECONNREFUSED 后 200（慢就绪），探测成功', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  try {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((r) => server.close(() => r()));
    const url = `http://127.0.0.1:${port}`;
    // 端口暂未监听 → 探测先 ECONNREFUSED；150ms 后服务起来 → 重试命中 200
    setTimeout(() => {
      void server.listen(port, '127.0.0.1');
    }, 150);
    const probe = new ReadinessProbe({ intervalMs: 20 });
    const r = await probe.probe(streamFrom([`dsh web: ${url}\n`]), emptyStream());
    equal(r.ok, true);
    equal(r.url, url);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('🟡-2 就绪行命中后 readyTimer 清除：慢就绪 + 坏探测 → probe-window-exhausted（而非 ready-line-timeout）', async () => {
  // 就绪行预算 50ms（真实定时器，早于探测窗口结束）；命中后若未清除，
  // 50ms 时定时器会抢答 ready-line-timeout。修复后只有探测窗口 deadline 说了算。
  let t = 59000; // 就绪行在预算接近耗尽时才出现（慢就绪）
  const probe = new ReadinessProbe({
    readyTimeoutMs: 50,
    httpGet: async () => {
      throw errWithCode('ECONNREFUSED');
    },
    now: () => t,
    sleep: async () => {
      t += 1000;
      await new Promise((r) => setTimeout(r, 10)); // 真实 10ms/轮 → 窗口总时长 > 50ms 定时器
    },
  });
  const r = await probe.probe(streamFrom([`dsh web: ${URL}\n`]), emptyStream());
  equal(r.ok, false);
  equal(r.reason, 'probe-window-exhausted');
});
