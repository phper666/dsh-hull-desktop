#!/usr/bin/env node
/**
 * fake dsh 脚本（S7 设计 D2/D5）：行为矩阵 FAKE_DSH_MODE env 注入。
 * 参数与真实 dsh CLI 同构：web --host 127.0.0.1 --port 0
 * （spawnArgs argv 顺序由集成测试验证——fake 接收同形 argv）。
 *
 * FAKE_DSH_MODE：
 *   ready（默认）  → 起 node http server（127.0.0.1 随机端口）→ 输出就绪行 → 保持运行
 *   slow           → 延时（FAKE_DSH_DELAY_MS，默认 2000）后输出就绪行（慢启动模拟）
 *   bad-addr       → 输出坏地址就绪行（http://127.0.0.1:1——探测失败路径）→ 保持运行
 *   crash          → 输出就绪行后立即非零退出（崩溃模拟）
 *
 * 就绪行格式与 S1 READY_LINE_RE 匹配：^dsh web: (http:\/\/127\.0\.0\.1:[0-9]+)
 */

const http = require('node:http');

const mode = process.env.FAKE_DSH_MODE ?? 'ready';
const delayMs = Number(process.env.FAKE_DSH_DELAY_MS ?? 2000);

function emitReadyLine(url) {
  process.stdout.write(`dsh web: ${url}\n`);
}

if (mode === 'crash') {
  // 输出就绪行（指向死端口）后立即退出——starting 中退出 → child-exited
  emitReadyLine('http://127.0.0.1:1');
  process.exit(1);
}

if (mode === 'bad-addr') {
  // 就绪行指向坏地址（探测失败路径，Q-010 注入配合）
  emitReadyLine('http://127.0.0.1:1');
  setInterval(() => {}, 1000); // 保持运行
} else {
  // ready / slow：起 http server 随机端口
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}`;
    if (mode === 'slow') {
      setTimeout(() => emitReadyLine(url), delayMs);
    } else {
      emitReadyLine(url);
    }
  });
}
