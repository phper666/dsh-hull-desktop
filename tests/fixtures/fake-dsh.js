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
 * P5 插件子命令（HULL_E2E 语义，契约 §联调与测试场景 e2e 隔离）：
 *   plugin --profile hull <add|update|remove|list> [args]
 *   - 状态维护 <userData>/fixture-plugins.json（add=写入 / update=版本 bump / remove=删除 / list=输出 JSON 数组）
 *   - userData 推导：overlay 布局 <userData>/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js → 上溯 5 级；
 *     直接 spawn（integration）→ env HULL_FAKE_DSH_USER_DATA 覆盖
 *   - 失败注入 HULL_E2E_FAIL_AT（仅 HULL_E2E=1 生效，镜像 main cli.ts failPoint 语义）：
 *       plugin-add:exit  → add 前退出（崩溃窗口，无痕）
 *       plugin-add       → add 写入后退出（留痕，验证 installer 失败清理）
 *   - 输出 JSON 优先（DshCliRunner parseJson；list 为 {id,name,version,profile}[]，profile 过滤）
 *
 * 就绪行格式与 S1 READY_LINE_RE 匹配：^dsh web: (http:\/\/127\.0\.0\.1:[0-9]+)
 */

const http = require('node:http');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const mode = process.env.FAKE_DSH_MODE ?? 'ready';
const delayMs = Number(process.env.FAKE_DSH_DELAY_MS ?? 2000);

function emitReadyLine(url) {
  process.stdout.write(`dsh web: ${url}\n`);
}

// ── P5 插件子命令（argv[2] === 'plugin' 时接管；其余走既有 web 行为） ──
function resolveUserData() {
  if (process.env.HULL_FAKE_DSH_USER_DATA) return process.env.HULL_FAKE_DSH_USER_DATA;
  // overlay 布局：<userData>/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js → 上溯 5 级
  return join(__dirname, '..', '..', '..', '..', '..');
}

const PLUGIN_FIXTURE = () => join(resolveUserData(), 'fixture-plugins.json');

function readState() {
  try {
    return JSON.parse(readFileSync(PLUGIN_FIXTURE(), 'utf8'));
  } catch {
    return { plugins: [] };
  }
}

function writeState(state) {
  writeFileSync(PLUGIN_FIXTURE(), JSON.stringify(state, null, 2));
}

/** 失败注入（仅 HULL_E2E=1；与 main cli.ts failPoint 同语义） */
function failAt(point) {
  return process.env.HULL_E2E === '1' && process.env.HULL_E2E_FAIL_AT === point;
}

function exit1(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** URL 最后一段 → 插件名（https://example.com/acme-plugin → acme-plugin） */
function nameFromUrl(url) {
  const seg = String(url).replace(/\/+$/, '').split('/').pop() ?? '';
  return seg.replace(/\.git$/i, '') || 'unknown';
}

function bumpVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v));
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '1.0.1';
}

function pluginMain(argv) {
  // argv：['plugin', '--profile', <profile>, <cmd>, ...args]（process.argv[0..1] = node/script 已剥）
  let profile = 'hull';
  let i = 1;
  if (argv[i] === '--profile') {
    profile = String(argv[i + 1] ?? 'hull');
    i += 2;
  }
  const cmd = argv[i];
  const args = argv.slice(i + 1);
  const state = readState();
  const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

  switch (cmd) {
    case 'add': {
      const url = String(args[0] ?? '');
      if (!url) exit1('plugin add: 缺少 URL');
      if (failAt('plugin-add:exit')) exit1('plugin-add:exit 注入（add 前崩溃，无痕）');
      const name = nameFromUrl(url);
      state.plugins = state.plugins.filter((p) => p.id !== name); // 幂等重装覆盖
      state.plugins.push({ id: name, name, version: '1.0.0', profile, url });
      writeState(state);
      if (failAt('plugin-add')) exit1('plugin-add 注入（已写入，留痕）');
      out({ ok: true, id: name, name, version: '1.0.0', profile });
      break;
    }
    case 'update': {
      const id = String(args[0] ?? '');
      const p = state.plugins.find((x) => x.id === id || x.name === id || x.url === id);
      if (!p) exit1(`plugin update: 未安装 ${id}`);
      p.version = bumpVersion(p.version);
      writeState(state);
      out({ ok: true, id: p.id, name: p.name, version: p.version });
      break;
    }
    case 'remove': {
      const id = String(args[0] ?? '');
      const before = state.plugins.length;
      state.plugins = state.plugins.filter((x) => x.id !== id && x.name !== id && x.url !== id);
      if (state.plugins.length === before) exit1(`plugin remove: 未安装 ${id}`);
      writeState(state);
      out({ ok: true, removed: id });
      break;
    }
    case 'list': {
      const list = state.plugins
        .filter((p) => !p.profile || p.profile === profile)
        .map(({ id, name, version, profile: p }) => ({ id, name, version, ...(p ? { profile: p } : {}) }));
      out(list);
      break;
    }
    default:
      exit1(`plugin: 未知子命令 ${cmd}`);
  }
  process.exit(0);
}

if (process.argv[2] === 'plugin') {
  pluginMain(process.argv.slice(2));
  return; // pluginMain 内 process.exit，不可达（防误落 web 分支）
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
