#!/usr/bin/env node
/**
 * 合并多平台 latest-mac.yml（cicd 双架构修复，Q-060/决策 6）。
 * mac arm64 + x64 两个 build job 各自生成 latest-mac.yml（只含自己架构 files），
 * 若直接 merge-multiple 上传会同名覆盖 → release 里只剩一个架构 → 对端 electron-updater
 * 按 process.arch 匹配不到文件 → "No files provided"。
 * 本脚本把 dist-artifacts 下所有 latest-mac.yml 的 files 合并为一个（去重 url），
 * 写回每个 yml（统一合并版），供上传。
 *
 * ⚠️ 纯 Node 内置模块（无 js-yaml 依赖）——release job 不跑 npm ci，无 node_modules。
 * latest-mac.yml 结构简单（version/files[url,sha512,size]/path/sha512/releaseDate），
 * 用正则提取 + 重建即可。
 *
 * 用法：node scripts/merge-latest-mac.mjs <dist-artifacts 根目录>
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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

/** 解析 latest-mac.yml（简单 YAML 子集：顶层 key + files 列表 url/sha512/size） */
function parseYml(text) {
  const data = { files: [] };
  let inFiles = false;
  let curFile = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('files:')) { inFiles = true; continue; }
    if (inFiles && /^  - url:/.test(line)) {
      if (curFile) data.files.push(curFile);
      curFile = { url: line.trim().replace(/^- url: /, '') };
      continue;
    }
    if (inFiles && curFile && /^    (sha512|size):/.test(line)) {
      const [k, v] = line.trim().split(/:\s*/, 2);
      curFile[k] = v;
      continue;
    }
    // 顶层字段（无缩进 key:）：files 块结束后（path/sha512/releaseDate）也能解析
    // 用正则捕获完整值（split(:,\s*,2) 会截断含冒号的值如 releaseDate: 2026-08-27T00:00:00）
    const top = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (top && !/^  /.test(line)) {
      const k = top[1];
      if (k === 'files') continue;
      data[k] = top[2].replace(/^['"]|['"]$/g, '');
      if (inFiles && k !== 'files') inFiles = false; // files 块结束（遇到非 files 内字段）
    }
  }
  if (curFile) data.files.push(curFile);
  return data;
}

/** 重建 latest-mac.yml（保留顶层字段 + 合并后 files） */
function buildYml(data) {
  const lines = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === 'files') continue;
    lines.push(`${k}: ${typeof v === 'string' && /[:#]/.test(v) ? `'${v}'` : v}`);
  }
  lines.push('files:');
  for (const f of data.files) {
    lines.push(`  - url: ${f.url}`);
    if (f.sha512 != null) lines.push(`    sha512: ${f.sha512}`);
    if (f.size != null) lines.push(`    size: ${f.size}`);
  }
  return lines.join('\n') + '\n';
}

// 收集所有 yml 的 files（去重 url），保留第一个 yml 的顶层字段
let merged = null;
const seen = new Set();
const allFiles = [];
for (const yp of ymls) {
  const data = parseYml(readFileSync(yp, 'utf8'));
  if (!merged) merged = data;
  for (const f of data.files) {
    if (f.url && !seen.has(f.url)) {
      seen.add(f.url);
      allFiles.push(f);
    }
  }
}
if (!merged) process.exit(0);

merged.files = allFiles;
const outText = buildYml(merged);
for (const yp of ymls) writeFileSync(yp, outText);
console.log(`[merge-latest-mac] 合并 ${ymls.length} 个 latest-mac.yml → ${allFiles.length} 个文件（${allFiles.map((f) => f.url).join(', ')}）`);
