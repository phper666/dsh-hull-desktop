#!/usr/bin/env node
/**
 * P5 registry snapshot 生成器：拉取社区 dsh-market plugins.json → normalizeEntries（与运行时
 * src/plugins/registry.ts 同源归一）→ 写 assets/plugins-registry-snapshot.json（registry.ts
 * snapshotPath 内置兜底，构建期冻结）。拉取失败 → 最小空列表 + _meta.error 注明来源失败。
 * 用法：npm run build（tsc，dist 需含 registry.js）后 node scripts/fetch-plugin-snapshot.mjs
 */
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = new URL('.', import.meta.url).pathname;

const SOURCE_URL = process.env.PLUGIN_SNAPSHOT_URL ?? 'https://awesome-dsh-plugin.com/plugins.json';
const OUT = join(__dirname, '..', 'assets', 'plugins-registry-snapshot.json');

async function main() {
  const meta = { source: SOURCE_URL, fetchedAt: new Date().toISOString() };
  let entries = [];
  try {
    const res = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    // 归一逻辑与运行时同源：dist 已构建则复用 normalizeEntries，否则内联等效实现（字段白名单）
    let normalize = null;
    const distRegistry = join(__dirname, '..', 'dist', 'plugins', 'registry.js');
    if (existsSync(distRegistry)) {
      normalize = require(distRegistry).normalizeEntries;
    }
    entries = normalize ? normalize(raw) : inlineNormalize(raw);
    meta.count = entries.length;
    if (entries.length === 0) throw new Error('registry 数据为空或字段不合法');
  } catch (err) {
    meta.error = `拉取失败，写入最小空列表：${err instanceof Error ? err.message : String(err)}`;
    entries = [];
    meta.count = 0;
    console.warn(`[plugin-snapshot] ${meta.error}`);
  }
  writeFileSync(OUT, JSON.stringify({ ...meta, plugins: entries }, null, 2));
  console.log(`[plugin-snapshot] 写入 ${OUT}（${meta.count} 条${meta.error ? '，来源失败' : ''}）`);
}

/** 内联归一（dist 缺失时兜底；与 src/plugins/registry.ts normalizeEntries 字段映射一致） */
function inlineNormalize(raw) {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? raw.plugins ?? [] : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item;
    const str = (v) => (typeof v === 'string' && v.length > 0 ? v : undefined);
    const name = str(r.name);
    const owner = str(r.owner);
    const url = str(r.url);
    if (!name || !owner || !url) continue;
    out.push({
      name,
      owner,
      url,
      ...(str(r.category) ? { category: str(r.category) } : {}),
      ...(str(r.install) ? { install: str(r.install) } : {}),
      ...(r.deprecated === true ? { deprecated: true } : {}),
      ...(str(r.minDshVersion) ? { minDshVersion: str(r.minDshVersion) } : {}),
    });
  }
  return out;
}

main().catch((err) => {
  console.error(`[plugin-snapshot] 失败：${err.message}`);
  process.exit(1);
});
