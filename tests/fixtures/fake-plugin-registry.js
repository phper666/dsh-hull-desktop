#!/usr/bin/env node
/**
 * P5 e2e 插件 registry 本地 fixture（HULL_E2E_REGISTRY 指向本服务；Node fetch 不支持 file:// 故用 http）。
 * FAKE_PLUGIN_REGISTRY_JSON：插件条目数组（缺省内置两条 demo）；任意路径返回 { plugins: [...] }。
 * 就绪行：listening on <port>（与 fake-registry.js 同构）。
 */
const http = require('node:http');

const DEFAULT_ENTRIES = [
  { name: 'e2e-demo', owner: 'dsh-hull-desktop', url: 'https://example.com/e2e-demo', category: 'demo', description: 'e2e fixture plugin' },
  { name: 'e2e-second', owner: 'dsh-hull-desktop', url: 'https://example.com/e2e-second', category: 'demo' },
];

let entries = DEFAULT_ENTRIES;
try {
  const raw = JSON.parse(process.env.FAKE_PLUGIN_REGISTRY_JSON ?? '');
  if (Array.isArray(raw)) entries = raw;
} catch {
  /* 缺省 */
}

const body = JSON.stringify({ plugins: entries });
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`listening on ${server.address().port}\n`);
});
