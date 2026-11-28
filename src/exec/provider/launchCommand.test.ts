/**
 * launchCommand 单测（U-002 外部 ACP agent 启动命令解析）
 *
 * - 空白分隔 / 单双引号包裹（含空格路径）/ 双引号内 \" 转义
 * - 未闭合引号 / 空串 / 纯空白 → null
 */
import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';

import { parseLaunchCommand } from './launchCommand';

test('空串/纯空白 → null', () => {
  equal(parseLaunchCommand(''), null);
  equal(parseLaunchCommand('   \t \n '), null);
});

test('未闭合引号 → null（单双引号）', () => {
  equal(parseLaunchCommand('"/Applications/My Agent/agent'), null);
  equal(parseLaunchCommand("agent 'unclosed arg"), null);
});

test('普通切词：命令 + 参数 + 多余空白折叠', () => {
  deepEqual(parseLaunchCommand('  node   -e   "x"  '), { command: 'node', args: ['-e', 'x'] });
  deepEqual(parseLaunchCommand('java -jar agent.jar'), { command: 'java', args: ['-jar', 'agent.jar'] });
});

test('含空格路径：双引号包裹整段（设置页典型形态）', () => {
  deepEqual(parseLaunchCommand('"/Applications/My Agent/agent" --port 8080'), {
    command: '/Applications/My Agent/agent',
    args: ['--port', '8080'],
  });
});

test('单引号包裹：内部内容原样保留（含双引号）', () => {
  deepEqual(parseLaunchCommand("'/opt/My Agent/run' --flag 'a \"b\"'"), {
    command: '/opt/My Agent/run',
    args: ['--flag', 'a "b"'],
  });
});

test('双引号内转义引号 \\" → 字面引号', () => {
  deepEqual(parseLaunchCommand('agent --prompt "say \\"hi\\""'), {
    command: 'agent',
    args: ['--prompt', 'say "hi"'],
  });
});

test('引号与裸文本相邻仍属同一 token', () => {
  deepEqual(parseLaunchCommand('agent --flag="a b"'), { command: 'agent', args: ['--flag=a b'] });
});

test('只有空白命令（引号包裹空串）→ null', () => {
  equal(parseLaunchCommand('"" --x'), null);
});
