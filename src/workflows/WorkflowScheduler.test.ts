/**
 * WorkflowScheduler 单测：注入时钟 + 手动 timer 句柄（确定性，不依赖 mock.timers）。
 * 语义：仅 enabled+cron 排期；提前触发（超长 delay 分片/漂移）不跑只重排；engine 抛错吞掉并重排；dispose 清空。
 */
import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';

import { WorkflowScheduler, type SchedulerDef } from './WorkflowScheduler';

interface TimerRec {
  fn: () => void;
  at: number;
}

function makeEnv(defs: SchedulerDef[]) {
  let t = new Date(2026, 8, 3, 10, 7, 0, 0).getTime(); // 2026-09-03 10:07（周四）
  const timers = new Map<number, TimerRec>();
  let seq = 0;
  const runs: string[] = [];
  const logs: string[] = [];
  const setTimer = (fn: () => void, ms: number) => {
    const h = ++seq;
    timers.set(h, { fn, at: t + ms });
    return h as unknown as NodeJS.Timeout;
  };
  const clearTimer = (h: NodeJS.Timeout) => {
    timers.delete(h as unknown as number);
  };
  const env = {
    runs,
    sources: [] as Array<string | undefined>,
    logs,
    timers,
    scheduler: new WorkflowScheduler({
      engine: {
        run: async (id: string, source?: 'manual' | 'cron') => {
          runs.push(id);
          env.sources.push(source);
          return { id };
        },
      },
      getDefs: () => defs,
      log: (m: string) => logs.push(m),
      now: () => new Date(t),
      setTimer,
      clearTimer,
    }),
    advance: (ms: number) => {
      t += ms;
      let guard = 0;
      while (guard++ < 1000) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= t);
        if (!due.length) break;
        for (const [h, v] of due) {
          timers.delete(h);
          v.fn();
        }
      }
    },
    /** 模拟超长 delay 分片/漂移导致的提前触发：手动调用 timer 回调但不推进时钟 */
    fireEarly: () => {
      for (const [h, v] of [...timers.entries()]) {
        timers.delete(h);
        v.fn();
      }
    },
    nextDelay: (): number | null => {
      const first = [...timers.values()][0];
      return first ? first.at - t : null;
    },
  };
  return env;
}

const CRON_15 = '*/15 * * * *';

test('reschedule：仅 enabled+cron 的工作流被排期（禁用/无 trigger 跳过）', () => {
  const env = makeEnv([
    { id: 'a', enabled: true, trigger: { type: 'cron', expr: CRON_15 } },
    { id: 'b', enabled: false, trigger: { type: 'cron', expr: CRON_15 } },
    { id: 'c', enabled: true, trigger: null },
    { id: 'd', enabled: true },
  ]);
  env.scheduler.reschedule();
  equal(env.timers.size, 1);
  // 10:07 → 下一 15 分钟刻度 10:15 → 8 分钟
  equal(env.nextDelay(), 8 * 60 * 1000);
});

test('到点触发：engine.run 收到正确 id（source=cron）并重排下一周期', () => {
  const env = makeEnv([{ id: 'a', enabled: true, trigger: { type: 'cron', expr: CRON_15 } }]);
  env.scheduler.reschedule();
  env.advance(8 * 60 * 1000);
  ok(env.runs.includes('a'));
  equal(env.sources[env.sources.length - 1], 'cron', '定时触发来源标记为 cron');
  equal(env.timers.size, 1, '触发后重排下次');
  equal(env.nextDelay(), 15 * 60 * 1000, '10:15 → 10:30');
  env.advance(15 * 60 * 1000);
  equal(env.runs.filter((r) => r === 'a').length, 2);
});

test('提前触发（超长 delay 分片/漂移）：未达目标分钟 → 不触发仅重排', () => {
  const env = makeEnv([{ id: 'a', enabled: true, trigger: { type: 'cron', expr: '0 9 * * *' } }]);
  env.scheduler.reschedule();
  equal(env.nextDelay()! > 2 ** 31, false, '测试环境 delay 未超上限');
  env.fireEarly(); // timer 回调提前触发
  equal(env.runs.length, 0, '未到目标不运行');
  equal(env.timers.size, 1, '重新武装');
});

test('超长 delay 分片：>2^31-1 时按上限武装，到点未达目标重排不触发', () => {
  // 每年 3 月 1 日 → 2026-09-03 距 2027-03-01 约 179 天 > 24.8 天上限
  const env = makeEnv([{ id: 'a', enabled: true, trigger: { type: 'cron', expr: '0 0 1 3 *' } }]);
  env.scheduler.reschedule();
  equal(env.nextDelay(), 2 ** 31 - 1, '按 setTimeout 上限分片');
  env.advance(2 ** 31 - 1);
  equal(env.runs.length, 0, '分片到点但未达 3/1 → 不触发');
  equal(env.timers.size, 1, '继续分片');
});

test('engine.run 抛错（互斥/停用）：吞掉、留日志、仍重排', async () => {
  let t = new Date(2026, 8, 3, 10, 7, 0, 0).getTime();
  const timers = new Map<number, TimerRec>();
  let seq = 0;
  const logs: string[] = [];
  const runs: string[] = [];
  let failNext = true;
  const scheduler = new WorkflowScheduler({
    engine: {
      run: async (id: string) => {
        if (failNext) throw new Error('上一次运行尚未结束');
        runs.push(id);
        return { id };
      },
    },
    getDefs: () => [{ id: 'a', enabled: true, trigger: { type: 'cron', expr: CRON_15 } }],
    log: (m) => logs.push(m),
    now: () => new Date(t),
    setTimer: (fn, ms) => {
      const h = ++seq;
      timers.set(h, { fn, at: t + ms });
      return h as unknown as NodeJS.Timeout;
    },
    clearTimer: (h) => timers.delete(h as unknown as number),
  });
  scheduler.reschedule();
  t += 8 * 60 * 1000;
  for (const [h, v] of [...timers.entries()]) {
    timers.delete(h);
    v.fn();
  }
  await new Promise((r) => setImmediate(r)); // rejection 经 .catch 微任务落日志
  equal(runs.length, 0, '抛错被吞掉');
  equal(logs.length, 1, '留日志');
  equal(timers.size, 1, '仍重排下次');
  // 下一次不再抛错 → 正常运行
  failNext = false;
  t += 15 * 60 * 1000;
  for (const [h, v] of [...timers.entries()]) {
    timers.delete(h);
    v.fn();
  }
  equal(runs.length, 1);
});

test('非法 cron：不排期 + 留日志 + 不抛', () => {
  const env = makeEnv([{ id: 'bad', enabled: true, trigger: { type: 'cron', expr: '99 * * * *' } }]);
  env.scheduler.reschedule();
  equal(env.timers.size, 0);
  equal(env.logs.length, 1);
});

test('reschedule 幂等重算：定义变更后旧 timer 全部替换', () => {
  const defs: SchedulerDef[] = [{ id: 'a', enabled: true, trigger: { type: 'cron', expr: CRON_15 } }];
  const env = makeEnv(defs);
  env.scheduler.reschedule();
  defs.length = 0; // 模拟删除工作流
  env.scheduler.reschedule();
  equal(env.timers.size, 0);
  env.advance(60 * 60 * 1000);
  equal(env.runs.length, 0, '已删除工作流不再触发');
});

test('dispose：清空全部 timer', () => {
  const env = makeEnv([
    { id: 'a', enabled: true, trigger: { type: 'cron', expr: CRON_15 } },
    { id: 'b', enabled: true, trigger: { type: 'cron', expr: '0 9 * * *' } },
  ]);
  env.scheduler.reschedule();
  equal(env.timers.size, 2);
  env.scheduler.dispose();
  equal(env.timers.size, 0);
});
