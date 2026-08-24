import { test, after } from 'node:test';
import { equal, ok, throws } from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SettingsProvider, type ThemeName } from './SettingsProvider';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeProvider(files: Record<string, string>, warns: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'hull-settings-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  const logger = {
    info() {},
    warn: (m: string) => warns.push(m),
    error() {},
    dshLog() {},
  };
  return { provider: new SettingsProvider({ userDataPath: dir, logger }), dir, warns };
}

test('缺 settings.json → 默认值（closeToQuit=false, schemaVersion=3〔S5 bump〕），不建文件', () => {
  const { provider, dir } = makeProvider({});
  const s = provider.getSettings();
  equal(s.closeToQuit, false);
  equal(s.schemaVersion, 3);
  ok(!existsSync(join(dir, 'settings.json')));
});

test('正常读：closeToQuit=true + schemaVersion=2 读入（读保留文件值）', () => {
  const { provider } = makeProvider({
    'settings.json': JSON.stringify({ closeToQuit: true, schemaVersion: 2 }),
  });
  const s = provider.getSettings();
  equal(s.closeToQuit, true);
  equal(s.schemaVersion, 2); // 读路径保留文件值（迁移归 S6）
});

test('JSON.parse 失败 → 回退默认值 + 告警，不覆盖原文件', () => {
  const warns: string[] = [];
  const { provider, dir } = makeProvider({ 'settings.json': '{broken json' }, warns);
  const s = provider.getSettings();
  equal(s.closeToQuit, false);
  equal(s.schemaVersion, 3);
  ok(warns.length >= 1, '应产生告警日志');
  // 原文件内容必须原样保留（S1 只读）
  equal(readFileSync(join(dir, 'settings.json'), 'utf8'), '{broken json');
});

test('字段类型错 → 回退该字段默认值 + 告警', () => {
  const warns: string[] = [];
  const { provider } = makeProvider(
    { 'settings.json': JSON.stringify({ closeToQuit: 'yes', schemaVersion: '2' }) },
    warns
  );
  const s = provider.getSettings();
  equal(s.closeToQuit, false);
  equal(s.schemaVersion, 3);
  ok(warns.length >= 1);
});

test('部分字段：仅 closeToQuit 存在，schemaVersion 用默认', () => {
  const { provider } = makeProvider({ 'settings.json': JSON.stringify({ closeToQuit: false }) });
  const s = provider.getSettings();
  equal(s.closeToQuit, false);
  equal(s.schemaVersion, 3);
});

test('S4-① set 新写文件：channel=latest + schemaVersion=2（bump）', () => {
  const { provider, dir } = makeProvider({});
  provider.set({ closeToQuit: true });
  const parsed = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
    channel: string;
    schemaVersion: number;
  };
  equal(parsed.channel, 'latest');
  equal(parsed.schemaVersion, 3);
});

test('S4-② set 后 get 读回（含 pinnedVersion 写入）', () => {
  const { provider } = makeProvider({});
  provider.set({ channel: 'pinned', pinnedVersion: '1.2.3' });
  const s = provider.getSettings();
  equal(s.channel, 'pinned');
  equal(s.pinnedVersion, '1.2.3');
});

test('S4-③ set channel=latest 显式清 pinnedVersion（B4 同事务）', () => {
  const { provider } = makeProvider({});
  provider.set({ channel: 'pinned', pinnedVersion: '1.2.3' });
  provider.set({ channel: 'latest' });
  const s = provider.getSettings();
  equal(s.channel, 'latest');
  equal(s.pinnedVersion, null, '残留锁定值已清');
});

test('S4-④ 写失败（只读目录）→ 抛错误语义 + get 恒读磁盘旧值（B5 内存丢弃）', () => {
  const { provider, dir } = makeProvider({});
  provider.set({ channel: 'pinned', pinnedVersion: '1.2.3' });
  chmodSync(dir, 0o555);
  try {
    // 错误语义 = err.code（正则匹配的是字符串化 name+message，code 不在其中）
    throws(() => provider.set({ channel: 'latest' }), (e: unknown) => (e as { code: string }).code === 'persist-failed');
  } finally {
    chmodSync(dir, 0o755);
  }
  const s = provider.getSettings();
  equal(s.channel, 'pinned', '磁盘旧值权威');
  equal(s.pinnedVersion, '1.2.3');
});

test('S4-⑤ S1 语义回归：损坏回退不覆盖 + 缺字段默认 + closeToQuit 读回', () => {
  // 损坏 → 默认值 + 原文件不动
  const a = makeProvider({ 'settings.json': '{broken' });
  const sa = a.provider.getSettings();
  equal(sa.closeToQuit, false);
  equal(sa.channel, 'latest');
  equal(readFileSync(join(a.dir, 'settings.json'), 'utf8'), '{broken');
  // 旧文件缺新字段 → channel 默认 latest
  const b = makeProvider({ 'settings.json': JSON.stringify({ closeToQuit: true }) });
  const sb = b.provider.getSettings();
  equal(sb.closeToQuit, true);
  equal(sb.channel, 'latest');
  equal(sb.pinnedVersion, null);
  // 非法 channel 值 → 默认 latest
  const c = makeProvider({ 'settings.json': JSON.stringify({ closeToQuit: false, channel: 'stable' }) });
  equal(c.provider.getSettings().channel, 'latest');
});

test('S5-① 新写文件：autoCheckDsh/autoCheckHull 默认 true + schemaVersion=3', () => {
  const { provider, dir } = makeProvider({});
  provider.set({ closeToQuit: true });
  const parsed = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
    autoCheckDsh: boolean;
    autoCheckHull: boolean;
    schemaVersion: number;
  };
  equal(parsed.autoCheckDsh, true);
  equal(parsed.autoCheckHull, true);
  equal(parsed.schemaVersion, 3);
});

test('S5-② set autoCheckHull=false → 读回', () => {
  const { provider } = makeProvider({});
  provider.set({ autoCheckHull: false });
  const s = provider.getSettings();
  equal(s.autoCheckHull, false);
  equal(s.autoCheckDsh, true, 'dsh 开关不受影响');
});

test('S5-③ 旧文件缺 autoCheck 字段 → 默认 true（读兼容）', () => {
  const { provider } = makeProvider({ 'settings.json': JSON.stringify({ closeToQuit: true }) });
  const s = provider.getSettings();
  equal(s.autoCheckDsh, true);
  equal(s.autoCheckHull, true);
  equal(s.closeToQuit, true);
});

test('S5-④ S1/S4 字段回归：closeToQuit/channel/pinnedVersion 不变', () => {
  const { provider } = makeProvider({});
  provider.set({ channel: 'pinned', pinnedVersion: '1.2.3', closeToQuit: true });
  const s = provider.getSettings();
  equal(s.closeToQuit, true);
  equal(s.channel, 'pinned');
  equal(s.pinnedVersion, '1.2.3');
  equal(s.autoCheckDsh, true);
  equal(s.autoCheckHull, true);
});

test('S6-① registry 默认值 + 新写文件', () => {
  const { provider, dir } = makeProvider({});
  provider.set({ closeToQuit: true });
  const parsed = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { registry: string };
  equal(parsed.registry, 'https://registry.npmjs.org');
  equal(provider.getSettings().registry, 'https://registry.npmjs.org');
});

test('S6-② set registry 合法 → 持久化 + 广播事件', () => {
  const { provider } = makeProvider({});
  const changed: Array<Record<string, unknown>> = [];
  provider.on('changed', (s) => changed.push(s as unknown as Record<string, unknown>));
  provider.set({ registry: 'https://mirror.example.com' });
  equal(provider.getSettings().registry, 'https://mirror.example.com');
  equal(changed.length, 1);
  equal(changed[0].registry, 'https://mirror.example.com');
});

test('S6-③ set registry 非法 → registry-invalid', () => {
  const { provider } = makeProvider({});
  throws(() => provider.set({ registry: 'ftp://x' }), (e: unknown) => (e as { code: string }).code === 'registry-invalid');
  throws(() => provider.set({ registry: 'not-a-url' }), (e: unknown) => (e as { code: string }).code === 'registry-invalid');
});

test('S6-④ migrate：旧文件 schemaVersion 1 → 补齐五字段 + bump 3', () => {
  const { provider, dir } = makeProvider({ 'settings.json': JSON.stringify({ closeToQuit: true, schemaVersion: 1 }) });
  provider.migrate();
  const parsed = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<string, unknown>;
  equal(parsed.schemaVersion, 3);
  equal(parsed.channel, 'latest');
  equal(parsed.pinnedVersion, null);
  equal(parsed.autoCheckDsh, true);
  equal(parsed.autoCheckHull, true);
  equal(parsed.registry, 'https://registry.npmjs.org');
  equal(parsed.closeToQuit, true, '既有字段保留');
});

test('S6-⑤ migrate：损坏文件 → 告警 + 默认 + 备份', () => {
  const { provider, dir } = makeProvider({ 'settings.json': '{broken' });
  provider.migrate();
  ok(!existsSync(join(dir, 'settings.json')), '损坏文件已备份移除');
  ok(readdirSync(dir).some((f) => f.startsWith('settings.json.bak-')), '备份存在');
  equal(provider.getSettings().closeToQuit, false, '回退默认');
});

test('S6-⑥ on(changed) 订阅收到全量 settings', () => {
  const { provider } = makeProvider({});
  const received: Array<Record<string, unknown>> = [];
  provider.on('changed', (s) => received.push(s as unknown as Record<string, unknown>));
  provider.set({ autoCheckHull: false });
  equal(received.length, 1);
  equal(received[0].autoCheckHull, false);
  equal(received[0].closeToQuit, false, '全量');
  equal(received[0].registry, 'https://registry.npmjs.org');
});

test('S6-⑦ S1~S5 字段回归', () => {
  const { provider } = makeProvider({});
  provider.set({ channel: 'pinned', pinnedVersion: '1.2.3', closeToQuit: true, autoCheckDsh: false });
  const s = provider.getSettings();
  equal(s.closeToQuit, true);
  equal(s.channel, 'pinned');
  equal(s.pinnedVersion, '1.2.3');
  equal(s.autoCheckDsh, false);
  equal(s.autoCheckHull, true);
  equal(s.registry, 'https://registry.npmjs.org');
});

test('🟡-2 写失败 → persist-failed（契约码，settings-write-failed 为别名）', () => {
  const { provider, dir } = makeProvider({});
  provider.set({ channel: 'pinned', pinnedVersion: '1.2.3' });
  chmodSync(dir, 0o555);
  try {
    throws(() => provider.set({ channel: 'latest' }), (e: unknown) => (e as { code: string }).code === 'persist-failed');
  } finally {
    chmodSync(dir, 0o755);
  }
});

test('🟢 migrate：旧文件非法 registry → 默认值（与 set 校验链对称）', () => {
  const { provider, dir } = makeProvider({ 'settings.json': JSON.stringify({ schemaVersion: 1, registry: 'ftp://bad' }) });
  provider.migrate();
  const parsed = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { registry: string };
  equal(parsed.registry, 'https://registry.npmjs.org', '非法 registry 迁移为默认');
});

test('T2-① 缺 settings.json → theme 默认 dark', () => {
  const { provider } = makeProvider({});
  equal(provider.getSettings().theme, 'dark');
});

test('T2-② set theme=light → 持久化 + 读回 + 文件落盘', () => {
  const { provider, dir } = makeProvider({});
  provider.set({ theme: 'light' });
  equal(provider.getSettings().theme, 'light');
  const parsed = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { theme: string };
  equal(parsed.theme, 'light');
});

test('T2-③ 非法 theme 值 → 回退 dark + 告警', () => {
  const warns: string[] = [];
  const { provider } = makeProvider({ 'settings.json': JSON.stringify({ theme: 'neon' }) }, warns);
  equal(provider.getSettings().theme, 'dark');
  ok(warns.length >= 1, '应产生告警日志');
});

test('T2-④ 旧 settings 无 theme → 读回退 dark', () => {
  const { provider } = makeProvider({ 'settings.json': JSON.stringify({ closeToQuit: true }) });
  const s = provider.getSettings();
  equal(s.theme, 'dark');
  equal(s.closeToQuit, true, '既有字段不受影响');
});

test('T2-⑤ set 非法 theme → 读回退 dark（与 channel 校验对称）', () => {
  const { provider } = makeProvider({});
  provider.set({ theme: 'neon' as ThemeName });
  equal(provider.getSettings().theme, 'dark');
});

test('T2-⑥ theme 类型错（number）→ 回退 dark + 告警', () => {
  const warns: string[] = [];
  const { provider } = makeProvider({ 'settings.json': JSON.stringify({ theme: 42 }) }, warns);
  equal(provider.getSettings().theme, 'dark');
  ok(warns.length >= 1, '应产生告警日志');
});
