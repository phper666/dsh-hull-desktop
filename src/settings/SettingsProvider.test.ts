import { test, after } from 'node:test';
import { equal, ok, throws } from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SettingsProvider, type PkgMgrName, type ThemeName } from './SettingsProvider';

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

test('T2-① 缺 settings.json → theme 默认 system（CON-R-theme-004 v1.3）', () => {
  const { provider } = makeProvider({});
  equal(provider.getSettings().theme, 'system');
});

test('T2-② set theme=light → 持久化 + 读回 + 文件落盘', () => {
  const { provider, dir } = makeProvider({});
  provider.set({ theme: 'light' });
  equal(provider.getSettings().theme, 'light');
  const parsed = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { theme: string };
  equal(parsed.theme, 'light');
});

test('T2-③ 非法 theme 值 → 回退默认 system + 告警', () => {
  const warns: string[] = [];
  const { provider } = makeProvider({ 'settings.json': JSON.stringify({ theme: 'neon' }) }, warns);
  equal(provider.getSettings().theme, 'system');
  ok(warns.length >= 1, '应产生告警日志');
});

test('T2-④ 旧 settings 无 theme → 读回退默认 system', () => {
  const { provider } = makeProvider({ 'settings.json': JSON.stringify({ closeToQuit: true }) });
  const s = provider.getSettings();
  equal(s.theme, 'system');
  equal(s.closeToQuit, true, '既有字段不受影响');
});

test('T2-⑤ set 非法 theme → 读回退默认 system（与 channel 校验对称）', () => {
  const { provider } = makeProvider({});
  provider.set({ theme: 'neon' as ThemeName });
  equal(provider.getSettings().theme, 'system');
});

test('T2-⑥ theme 类型错（number）→ 回退默认 system + 告警', () => {
  const warns: string[] = [];
  const { provider } = makeProvider({ 'settings.json': JSON.stringify({ theme: 42 }) }, warns);
  equal(provider.getSettings().theme, 'system');
  ok(warns.length >= 1, '应产生告警日志');
});

// ── 主题跟随系统（CON-R-theme-006：theme 枚举扩展 'system'）──
test('T2-⑦ set theme=system → 持久化 + 读回 + 文件落盘 + 广播', () => {
  const { provider, dir } = makeProvider({});
  const changed: Array<Record<string, unknown>> = [];
  provider.on('changed', (s) => changed.push(s as unknown as Record<string, unknown>));
  provider.set({ theme: 'system' });
  equal(provider.getSettings().theme, 'system');
  equal(changed.length, 1, 'changed 广播一次（main 侧据此更新 nativeTheme.themeSource）');
  const parsed = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { theme: string };
  equal(parsed.theme, 'system');
});

test('T2-⑧ 旧文件 theme=system（读路径归一化）→ 读回 system 不回退', () => {
  const { provider } = makeProvider({ 'settings.json': JSON.stringify({ theme: 'system' }) });
  equal(provider.getSettings().theme, 'system');
});

// ── P3 packageManager 字段（CON-R-pkgmgr-001/008）──
test('P3-① 缺 settings.json → packageManager 默认 pnpm', () => {
  const { provider } = makeProvider({});
  equal(provider.getSettings().packageManager, 'pnpm');
});

test('P3-② set packageManager=npm → 持久化 + 读回 + 文件落盘 + 广播', () => {
  const { provider, dir } = makeProvider({});
  const changed: Array<Record<string, unknown>> = [];
  provider.on('changed', (s) => changed.push(s as unknown as Record<string, unknown>));
  provider.set({ packageManager: 'npm' });
  equal(provider.getSettings().packageManager, 'npm');
  const parsed = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { packageManager: string };
  equal(parsed.packageManager, 'npm');
  equal(changed.length, 1);
  equal(changed[0].packageManager, 'npm');
});

test('P3-③ 非法 packageManager 值 → 读回退 pnpm + 告警', () => {
  const warns: string[] = [];
  const { provider } = makeProvider({ 'settings.json': JSON.stringify({ packageManager: 'bun' }) }, warns);
  equal(provider.getSettings().packageManager, 'pnpm');
  ok(warns.length >= 1, '应产生告警日志');
});

test('P3-④ 旧 settings 无 packageManager → 读回退 pnpm（既有字段不受影响）', () => {
  const { provider } = makeProvider({ 'settings.json': JSON.stringify({ closeToQuit: true, theme: 'light' }) });
  const s = provider.getSettings();
  equal(s.packageManager, 'pnpm');
  equal(s.closeToQuit, true);
  equal(s.theme, 'light');
});

test('P3-⑤ set 非法 packageManager → 读回退 pnpm（与 theme 校验对称）', () => {
  const { provider } = makeProvider({});
  provider.set({ packageManager: 'bun' as PkgMgrName });
  equal(provider.getSettings().packageManager, 'pnpm');
});

test('P3-⑥ migrate：旧文件 schemaVersion 1 → 补 packageManager 默认 pnpm', () => {
  const { provider, dir } = makeProvider({ 'settings.json': JSON.stringify({ closeToQuit: true, schemaVersion: 1 }) });
  provider.migrate();
  const parsed = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<string, unknown>;
  equal(parsed.schemaVersion, 3);
  equal(parsed.packageManager, 'pnpm');
  equal(parsed.closeToQuit, true, '既有字段保留');
});

test('P3-⑦ set 已合法 packageManager 后 schemaVersion 仍 3（字段级扩展不 bump）', () => {
  const { provider, dir } = makeProvider({});
  provider.set({ packageManager: 'npm' });
  const parsed = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { schemaVersion: number };
  equal(parsed.schemaVersion, 3);
});

// ── V2b：notifPrefs 归一化/迁移/写路径 ──

const notifLogger = () => ({ info: () => {}, warn: () => {}, error: () => {}, dshLog: () => {} });

test('notifPrefs：合法值读回透传 + 非法逐项回退默认', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-settings-notif-'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    schemaVersion: 3,
    notifPrefs: { systemPushWorkflow: false, systemPushBoardExec: true, dndEnabled: true, dndFrom: '23:30', dndTo: '07:15' },
  }));
  const p = new SettingsProvider({ userDataPath: dir, logger: notifLogger() }).getSettings().notifPrefs;
  equal(p.systemPushWorkflow, false);
  equal(p.dndEnabled, true);
  equal(p.dndFrom, '23:30');

  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    schemaVersion: 3,
    notifPrefs: { systemPushWorkflow: 'yes', dndFrom: '24:99', dndTo: '7:00' },
  }));
  const p2 = new SettingsProvider({ userDataPath: dir, logger: notifLogger() }).getSettings().notifPrefs;
  equal(p2.systemPushWorkflow, true, '非法布尔回退默认');
  equal(p2.dndFrom, '22:00', '非法时段回退默认');
  equal(p2.dndTo, '08:00', '非 HH:mm 回退默认');
});

test('notifPrefs：旧文件无字段 → 默认；set 写路径归一化落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-settings-notif2-'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ schemaVersion: 3, closeToQuit: false }));
  const provider = new SettingsProvider({ userDataPath: dir, logger: notifLogger() });
  equal(JSON.stringify(provider.getSettings().notifPrefs), JSON.stringify({ systemPushWorkflow: true, systemPushBoardExec: true, dndEnabled: false, dndFrom: '22:00', dndTo: '08:00' }));
  provider.set({ notifPrefs: { systemPushWorkflow: false, systemPushBoardExec: true, dndEnabled: true, dndFrom: '23:00', dndTo: '07:00' } });
  const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
  equal(onDisk.notifPrefs.systemPushWorkflow, false);
  equal(onDisk.notifPrefs.dndEnabled, true);
  // 写非法值 → 落盘前归一化回默认
  // 恶意/脏输入经 IPC 到达 set()：类型断言模拟 unknown 载荷（运行时归一化兜底）
  provider.set({ notifPrefs: { systemPushWorkflow: 'oops', systemPushBoardExec: true, dndEnabled: true, dndFrom: '23:00', dndTo: '07:00' } as unknown as import('../notifications/prefs').NotifPrefs });
  equal(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).notifPrefs.systemPushWorkflow, true);
});
