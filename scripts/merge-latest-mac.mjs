#!/usr/bin/env node
/**
 * 合并多平台 latest-mac.yml（cicd 双架构修复，Q-060/决策 6）。
 * mac arm64 + x64 两个 build job 各自生成 latest-mac.yml（只含自己架构 files），
 * 若直接 merge-multiple 上传会同名覆盖 → release 里只剩一个架构 → 对端 electron-updater
 * 按 process.arch 匹配不到文件 → "No files provided"。
 * 本脚本把 dist-artifacts 下所有 latest-mac.yml 的 files 合并为一个（去重 url），
 * 写回每个 yml（统一合并版），供上传。
 *
 * ⚠️ 用 JSON 深拷贝而非直接引用对象——js-yaml dump 对相同对象引用会产生 YAML anchor
 * （&ref_0/*ref_0），electron-updater 解析异常。深拷贝保证每个 file 独立。
 *
 * 用法：node scripts/merge-latest-mac.mjs <dist-artifacts 根目录>
 * 目录结构（download-artifact 无 merge-multiple）：dist-artifacts/<artifact-name>/<files>
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { load, dump } from 'js-yaml';

const root = process.argv[2] ?? 'dist-artifacts';
if (!existsSync(root)) {
  console.log('[merge-latest-mac] 无 dist-artifacts 目录，跳过');
  process.exit(0);
}

// 递归找所有 latest-mac.yml（支持 flat 或按 artifact 目录）
function findYml(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) findYml(p, out);
    else if (entry.name === 'latest-mac.yml') out.push(p);
  }
  return out;
}

const ymls = findYml(root);
if (ymls.length === 0) {
  console.log('[merge-latest-mac] 无 latest-mac.yml，跳过');
  process.exit(0);
}

// JSON 深拷贝（防 YAML anchor 复用）
const clone = (o) => JSON.parse(JSON.stringify(o));

let merged = null;
const seen = new Set();
const allFiles = [];
for (const yp of ymls) {
  const data = load(readFileSync(yp, 'utf8')) ?? {};
  if (!merged) merged = clone(data);
  for (const f of data.files ?? []) {
    if (f?.url && !seen.has(f.url)) {
      seen.add(f.url);
      allFiles.push(clone(f));
    }
  }
}
if (!merged) process.exit(0);

merged.files = allFiles; // 统一设置去重后的完整 files
for (const yp of ymls) {
  const data = load(readFileSync(yp, 'utf8')) ?? {};
  data.files = clone(allFiles);
  writeFileSync(yp, dump(data, { sortKeys: false, noRefs: true }));
}
console.log(`[merge-latest-mac] 合并 ${ymls.length} 个 latest-mac.yml → ${allFiles.length} 个文件（${allFiles.map((f) => f.url).join(', ')}）`);
