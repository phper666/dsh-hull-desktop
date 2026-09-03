/**
 * cron 解析器（5 字段：分 时 日 月 周，本地时区）——零依赖纯函数。
 * 设计：docs/design/工作流-workflows-design.md §7.1
 * 语法：* , - / ；星期 0/7=周日；DOM 与 DOW 同时受限 = 或语义（vixie cron 约定）。
 * cronNext 严格返回 from 之后（分钟粒度）的下一触发点；平年/闰年由真实日历驱动，无 30 号剪枝。
 */

export interface ParsedCron {
  minutes: number[];
  hours: number[];
  doms: number[];
  months: number[];
  dows: number[];
  domRestricted: boolean;
  dowRestricted: boolean;
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  /** 星期字段 7 归并为 0（周日） */
  wrap7?: boolean;
}

const FIELDS: FieldSpec[] = [
  { name: '分钟', min: 0, max: 59 },
  { name: '小时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 },
  { name: '星期', min: 0, max: 7, wrap7: true },
];

function parseField(spec: FieldSpec, raw: string): { values: number[]; restricted: boolean } {
  const values = new Set<number>();
  let restricted = false;
  for (const part of raw.split(',')) {
    if (!part) throw new Error(`cron ${spec.name}字段存在空片段: ${raw}`);
    // [步长] 作用于 * 或范围：* / 5、1-10 / 2、5 / 3
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`cron ${spec.name}字段非法片段: ${part}`);
    const [, rangeRaw, stepRaw] = m;
    const step = stepRaw !== undefined ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron ${spec.name}字段步长非法: ${part}`);
    let lo = spec.min;
    let hi = spec.max;
    if (rangeRaw !== '*') {
      const range = /^(\d+)(?:-(\d+))?$/.exec(rangeRaw);
      if (!range) throw new Error(`cron ${spec.name}字段非法: ${part}`);
      lo = Number(range[1]);
      hi = range[2] !== undefined ? Number(range[2]) : lo;
      if (lo < spec.min || hi > spec.max || lo > hi) throw new Error(`cron ${spec.name}字段超出范围(${spec.min}-${spec.max}): ${part}`);
      restricted = true;
    }
    for (let v = lo; v <= hi; v += step) values.add(spec.wrap7 && v === 7 ? 0 : v);
  }
  return { values: [...values].sort((a, b) => a - b), restricted };
}

/** 解析表达式；非法抛错（中文，含字段名与片段） */
export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron 表达式需要 5 个字段（分 时 日 月 周）: ${expr}`);
  const [min, hour, dom, mon, dow] = parts.map((p, i) => parseField(FIELDS[i], p));
  return {
    minutes: min.values,
    hours: hour.values,
    doms: dom.values,
    months: mon.values,
    dows: dow.values,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
  };
}

/** vixie 语义：DOM 与 DOW 同时受限 → 命中其一即可；否则受限项必须命中 */
function dayMatches(p: ParsedCron, dayOfMonth: number, dayOfWeek: number): boolean {
  const domHit = p.doms.includes(dayOfMonth);
  const dowHit = p.dows.includes(dayOfWeek);
  if (p.domRestricted && p.dowRestricted) return domHit || dowHit;
  if (p.domRestricted) return domHit;
  if (p.dowRestricted) return dowHit;
  return true;
}

/** from 之后（严格大于，分钟粒度）的下一触发点；解析失败抛错 */
export function cronNext(expr: string, from: Date): Date {
  const p = parseCron(expr);
  // 候选起点：from + 1 分钟（Date 溢出自动进位），秒/毫秒归零
  const cand = new Date(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours(), from.getMinutes() + 1, 0, 0);
  // 上限：约 6 年的按日推进（2/29 场景足够），防御性兜底
  for (let day = 0; day < 366 * 6; day++) {
    if (!p.months.includes(cand.getMonth() + 1)) {
      // 先落 1 号再跳月（避免 1/31 setMonth 溢出跳两月）
      cand.setDate(1);
      cand.setHours(0, 0, 0, 0);
      cand.setMonth(cand.getMonth() + 1);
      continue;
    }
    if (!dayMatches(p, cand.getDate(), cand.getDay())) {
      cand.setDate(cand.getDate() + 1);
      cand.setHours(0, 0, 0, 0);
      continue;
    }
    // 当日内取第一个 ≥ 候选时刻的（小时, 分钟）组合
    for (const hour of p.hours) {
      if (hour < cand.getHours()) continue;
      const minFloor = hour === cand.getHours() ? cand.getMinutes() : 0;
      const minute = p.minutes.find((m) => m >= minFloor);
      if (minute === undefined) continue;
      cand.setHours(hour, minute, 0, 0);
      return cand;
    }
    // 当日无更多时点 → 次日 00:00
    cand.setDate(cand.getDate() + 1);
    cand.setHours(0, 0, 0, 0);
  }
  throw new Error(`cron 表达式在 6 年内无触发点: ${expr}`);
}
