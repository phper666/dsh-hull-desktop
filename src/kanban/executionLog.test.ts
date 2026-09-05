/**
 * 执行输出日志读取单测（Q-回复落盘 2026-09-05）
 * readLatestExecutionLog：最新 execution 条目 outputPath → 日志文本；无记录/文件缺失 → null；
 * outputPath 越界（非 kanban/executions/ 前缀）→ null（防路径逃逸）。
 */
import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readLatestExecutionLog } from './executionLog';
import type { Task } from './types';

function fakeTask(outputPaths: Array<string | null>): Task {
  return {
    id: 't_1', parentId: null, columnId: 'c_todo', title: '任务', executionMode: 'auto',
    executionStatus: 'idle', currentExecutionId: null, acceptanceCriteria: null,
    agentSpec: { provider: 'dsh', agent: null, model: null, subagentPolicy: 'auto' },
    dependencies: [], description: null, labels: [], priority: 'P2', assignee: null,
    dueDate: null, startDate: null, order: 0, blockedFromColumnId: null, archivedAt: null,
    archivedFromColumnId: null, createdAt: '', updatedAt: '',
    timeline: outputPaths.map((p, i) => ({
      id: `e_${i}`, type: 'execution' as const, content: '执行', attachments: [],
      createdAt: '', author: null, source: { type: 'agent' as const, provider: 'dsh' },
      execution: p === null ? null : { status: 'succeeded' as const, command: '', startedAt: '', finishedAt: '', exitCode: 0, outputPath: p, selfCheck: null },
    })),
  } as unknown as Task;
}

test('readLatestExecutionLog：最新 execution 条目日志文本', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-execlog-'));
  try {
    mkdirSync(join(dir, 'kanban', 'executions'), { recursive: true });
    writeFileSync(join(dir, 'kanban', 'executions', 'e_1.log'), 'chunk-1chunk-2', 'utf8');
    writeFileSync(join(dir, 'kanban', 'executions', 'e_2.log'), '最新输出', 'utf8');
    const text = readLatestExecutionLog(dir, fakeTask(['kanban/executions/e_1.log', 'kanban/executions/e_2.log']));
    equal(text, '最新输出', '取最新（最后一条）execution 的日志');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLatestExecutionLog：无 execution 记录 / 文件缺失 → null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-execlog-'));
  try {
    equal(readLatestExecutionLog(dir, fakeTask([])), null, '无 execution 条目');
    equal(readLatestExecutionLog(dir, fakeTask(['kanban/executions/e_missing.log'])), null, '日志文件不存在');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLatestExecutionLog：outputPath 越界（目录逃逸）→ null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-execlog-'));
  try {
    equal(readLatestExecutionLog(dir, fakeTask(['../../etc/passwd'])), null, '非 kanban/executions/ 前缀拒绝');
    ok('未抛异常');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
