#!/usr/bin/env node
/**
 * verify-acceptance：10s 验收段分解参考（S7 设计 B1/B2/B4，契约 #4）。
 *
 * - 读 hull.log 的 [timing] 埋点（S1 实际格式：t0 start entry / t1 spawn / t2 ready-line / t3 ready / t4 did-finish-load）
 * - 输出各段耗时（t0→t1 spawn / t1→t2 就绪行 / t2→t3 探测 / t3→t4 UI 加载）+ 总时长（t4-t0，含 dsh 启动）
 * - **不设 PASS/FAIL 阈值**（B1：E2E-01 Playwright 完整冷启动计时为 Q-009 权威，本脚本段分解参考）
 * - 失败处理（B4）：日志存在缺特定 [timing] 段 → FAIL + 「segment X 日志缺失」；日志完全不存在 → FAIL + 「e2e 日志未找到——先跑 e2e」
 *
 * 用法：node scripts/verify-acceptance.mjs [<userData>/logs/hull.log]
 *   缺省路径：HULL_USER_DATA env（或 cwd）/logs/hull.log
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const logPath =
  process.argv[2] ?? join(process.env.HULL_USER_DATA ?? process.cwd(), 'logs', 'hull.log');

/** Logger 行格式：[<ISO>] [info] [timing] t<N> <label> */
const TIMING_RE = /^\[([^\]]+)\] \[info\] \[timing\] t(\d) (.+)$/;
const SEGMENT_NAMES = ['t0 入口', 't1 spawn', 't2 就绪行', 't3 探测', 't4 UI 加载'];

function main() {
  if (!existsSync(logPath)) {
    console.error('FAIL: e2e 日志未找到——先跑 e2e（verify-acceptance 不启动 electron，依赖 e2e 已产日志）');
    console.error(`  查找路径: ${logPath}`);
    process.exitCode = 1;
    return;
  }

  const marks = new Map(); // tN -> { ts, label }
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    const m = TIMING_RE.exec(line);
    if (m) {
      const ts = Date.parse(m[1]);
      if (!Number.isNaN(ts)) marks.set(Number(m[2]), { ts, label: m[3] });
    }
  }

  // B4：缺段诊断
  const missing = [];
  for (let n = 0; n <= 4; n++) {
    if (!marks.has(n)) missing.push(`t${n}`);
  }
  if (missing.length > 0) {
    console.error(`FAIL: segment ${missing.join(', ')} 日志缺失（hull.log 存在但缺 [timing] 段）`);
    console.error(`  已找到: ${[...marks.keys()].sort().join(', ') || '无'}`);
    process.exitCode = 1;
    return;
  }

  const t0 = marks.get(0).ts;
  const segs = [
    ['t0→t1 spawn', marks.get(1).ts - t0],
    ['t1→t2 就绪行', marks.get(2).ts - marks.get(1).ts],
    ['t2→t3 探测', marks.get(3).ts - marks.get(2).ts],
    ['t3→t4 UI 加载', marks.get(4).ts - marks.get(3).ts],
  ];
  const total = marks.get(4).ts - t0;

  console.log('=== 10s 验收段分解（参考口径） ===');
  for (const [name, ms] of segs) console.log(`  ${name}: ${ms}ms`);
  console.log(`  总时长（t4-t0，含 dsh 启动）: ${total}ms`);
  console.log('注：本脚本不设 PASS/FAIL 阈值——Q-009 权威判定由 E2E-01（Playwright 完整冷启动计时）承担');
}

main();
