/**
 * L2 ProviderRegistry 单测（B4 design §4.4 / 契约 §多 agent 注册表，CON-R030，P1-B4-2）
 *
 * - register 幂等：重复注册覆盖旧 factory + 日志，不报错；resolve/list 以最新注册为准（A18）
 * - resolve 双判：未注册 → exec-provider-unavailable；已注册但 isReady 失败 → 同样错误（A19）
 * - list()：available = 注册+就绪双判，与 resolve 口径一致（P1-B4-2）
 * - subagentPolicy：resolve 透传 agentSpec 语义（auto 默认 / restricted）
 * - 空注册表 → list() 空数组
 */
import { test } from 'node:test';
import { deepEqual, equal, throws } from 'node:assert/strict';

import { ProviderRegistry, DEFAULT_PROVIDER } from './ProviderRegistry';
import { ExecProviderUnavailableError } from '../errors';

test('register + list：available 双判口径一致（P1-B4-2）', () => {
  const reg = new ProviderRegistry();
  reg.register({ provider: 'dsh', displayName: 'DeepSeek Harness', factory: () => ({ kind: 'dsh' }), isReady: () => true });
  deepEqual(reg.list(), [{ provider: 'dsh', displayName: 'DeepSeek Harness', available: true, supportsSubagent: true }]);
});

test('register 幂等：重复注册覆盖旧 factory + 日志，resolve/list 以最新为准（A18）', () => {
  const reg = new ProviderRegistry();
  const warns: string[] = [];
  reg.register({ provider: 'dsh', displayName: 'DeepSeek Harness', factory: () => 'old' });
  reg.register({ provider: 'dsh', displayName: 'DeepSeek Harness', factory: () => 'new' }, { warn: (m) => warns.push(m) });
  equal(reg.list().length, 1, '注册表单条 dsh');
  equal((reg.resolve('dsh').factory as () => string)(), 'new', 'resolve 以最新注册为准');
  equal(warns.length, 1, '重复注册写日志');
});

test('resolve 未注册 provider → exec-provider-unavailable（A19）', () => {
  const reg = new ProviderRegistry();
  reg.register({ provider: 'dsh', displayName: 'DeepSeek Harness', factory: () => ({}) });
  throws(() => reg.resolve('other'), ExecProviderUnavailableError);
});

test('resolve 已注册但 isReady 失败 → exec-provider-unavailable（P1-B4-2 双判②）', () => {
  const reg = new ProviderRegistry();
  reg.register({ provider: 'dsh', displayName: 'DeepSeek Harness', factory: () => ({}), isReady: () => false });
  throws(() => reg.resolve('dsh'), ExecProviderUnavailableError);
  deepEqual(reg.list(), [{ provider: 'dsh', displayName: 'DeepSeek Harness', available: false, supportsSubagent: true }]);
});

test('subagentPolicy：resolve 透传 agentSpec 语义（auto 默认 / restricted）', () => {
  const reg = new ProviderRegistry();
  reg.register({ provider: 'dsh', displayName: 'DeepSeek Harness', factory: () => ({}) });
  equal(reg.resolve('dsh').subagentPolicy, 'auto');
  equal(reg.resolve('dsh', 'restricted').subagentPolicy, 'restricted');
});

test('list() 空注册表 → 空数组（契约 §getAgentProviders 边界）', () => {
  const reg = new ProviderRegistry();
  deepEqual(reg.list(), []);
});

test('register 缺省 supportsSubagent/isReady 有默认值', () => {
  const reg = new ProviderRegistry();
  reg.register({ provider: 'dsh', displayName: 'DeepSeek Harness', factory: () => ({}) });
  deepEqual(reg.list(), [{ provider: 'dsh', displayName: 'DeepSeek Harness', available: true, supportsSubagent: true }]);
});

test('DEFAULT_PROVIDER = dsh', () => {
  equal(DEFAULT_PROVIDER, 'dsh');
});
