#!/usr/bin/env node
/**
 * 本地假 npm registry（S7 e2e 用）：@deepseek-ai/dsh 单包。
 * 端点：
 *   GET /@deepseek-ai%2Fdsh          → manifest（dist-tags.latest + versions[latest].dist.tarball）
 *   GET /@deepseek-ai%2Fdsh/latest   → 裸版本串（fallback）
 *   GET /@deepseek-ai/dsh/-/dsh-<v>.tgz → gzip tar（package/package.json + package/lib/bin.js = fake-dsh.js）
 * env：FAKE_REGISTRY_LATEST（默认 9.9.9）、FAKE_REGISTRY_PORT（默认 0=随机）、
 *      FAKE_REGISTRY_TARBALL_DELAY_MS（默认 0——E2E-06 升级中禁用窗口用）
 * 独立运行：node tests/fixtures/fake-registry.js → stdout 输出 "listening on <port>"
 * 模块运行：const { start } = require('./fake-registry'); start({ latest, tarballDelayMs })
 */
const http = require('node:http');
const { gzipSync } = require('node:zlib');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const DEFAULT_LATEST = '9.9.9';
const fakeDshSource = readFileSync(join(__dirname, 'fake-dsh.js'), 'utf8');

/** 最小 ustar tar 条目（npm/pacote 可解压；checksum 按规范以空格占位计算） */
function tarEntry(name, content) {
  const isDir = name.endsWith('/');
  const data = isDir ? Buffer.alloc(0) : Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000644\0', 100, 8);
  header.write('0000000\0', 108, 8);
  header.write('0000000\0', 116, 8);
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12);
  header.write('00000000000\0', 136, 12);
  header.fill(0x20, 148, 156); // checksum 字段先置空格
  header.write(isDir ? '5' : '0', 156, 1);
  header.write('ustar\0', 257, 6);
  header.write('00', 263, 2);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

function buildTar(version) {
  const entries = [
    tarEntry('package/', ''),
    tarEntry(
      'package/package.json',
      JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' } })
    ),
    tarEntry('package/lib/', ''),
    tarEntry('package/lib/bin.js', fakeDshSource),
  ];
  return Buffer.concat([...entries, Buffer.alloc(1024)]); // 尾部 2 个零块
}

function start(options = {}) {
  // 头注释声明 env FAKE_REGISTRY_LATEST：options 优先（helpers 传参时经 env 透传），env 兜底默认
  const latest = options.latest || process.env.FAKE_REGISTRY_LATEST || DEFAULT_LATEST;
  const delayMs = options.tarballDelayMs ?? Number(process.env.FAKE_REGISTRY_TARBALL_DELAY_MS || 0);
  const tarball = gzipSync(buildTar(latest));
  let manifestHits = 0; // S8：manifest 请求计数（e2e 验证「升级入口触发检查」——原生 dialog 不可 Playwright 驱动）
  const server = http.createServer((req, res) => {
    const path = decodeURIComponent((req.url || '').split('?')[0]);
    if (path === '/__hits') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(String(manifestHits));
      return;
    }
    if (path === '/@deepseek-ai%2Fdsh' || path === '/@deepseek-ai/dsh') {
      manifestHits += 1;
      const manifest = {
        name: '@deepseek-ai/dsh',
        'dist-tags': { latest },
        versions: {
          [latest]: {
            name: '@deepseek-ai/dsh',
            version: latest,
            bin: { dsh: 'lib/bin.js' },
            dist: { tarball: `http://127.0.0.1:${server.address().port}/@deepseek-ai/dsh/-/dsh-${latest}.tgz` },
          },
        },
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(manifest));
      return;
    }
    if (path === '/@deepseek-ai%2Fdsh/latest' || path === '/@deepseek-ai/dsh/latest') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(latest);
      return;
    }
    if (path === `/@deepseek-ai/dsh/-/dsh-${latest}.tgz`) {
      const send = () => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(tarball);
      };
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(Number(process.env.FAKE_REGISTRY_PORT || 0), '127.0.0.1', () => {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}`;
      if (require.main === module) console.log(`listening on ${port}`);
      resolve({
        url,
        port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

module.exports = { start, buildTar };

if (require.main === module) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}