/**
 * U3 依赖图核心纯函数单测（node:test，docs/design/U3-依赖图可视化-kanban-depgraph-design.md §四/§六）
 * 覆盖：拓扑分层（链/并行/汇合/环容错）、重心排序确定性、中止链闭包、池态快照/回退、布局坐标。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const core = require('./depgraph-core.js');

const depsById = (tasks) => Object.fromEntries(tasks.map((t) => [t.id, t.deps || []]));

// ── 拓扑分层 ──
test('layerize 链式：a→b→c 三层', () => {
  const tasks = [{ id: 'a', deps: [] }, { id: 'b', deps: ['a'] }, { id: 'c', deps: ['b'] }];
  const { layers, cycle } = core.layerize(tasks, depsById(tasks));
  assert.deepEqual(layers, [['a'], ['b'], ['c']]);
  assert.deepEqual(cycle, []);
});

test('layerize 并行：无依赖同层（输入序）', () => {
  const tasks = [{ id: 'a', deps: [] }, { id: 'b', deps: [] }];
  const { layers } = core.layerize(tasks, depsById(tasks));
  assert.deepEqual(layers, [['a', 'b']]);
});

test('layerize 汇合：a→c 与 b→c 同汇于层1', () => {
  const tasks = [{ id: 'a', deps: [] }, { id: 'b', deps: [] }, { id: 'c', deps: ['a', 'b'] }];
  const { layers } = core.layerize(tasks, depsById(tasks));
  assert.deepEqual(layers, [['a', 'b'], ['c']]);
});

test('layerize 最长路径：d 依赖 c（c 依赖 a/b）→ d 层2', () => {
  const tasks = [
    { id: 'a', deps: [] }, { id: 'b', deps: [] },
    { id: 'c', deps: ['a', 'b'] }, { id: 'd', deps: ['c'] },
  ];
  const { layers } = core.layerize(tasks, depsById(tasks));
  assert.deepEqual(layers, [['a', 'b'], ['c'], ['d']]);
});

test('layerize 环容错：a↔b 压最后层 + cycle 标注，不崩', () => {
  const tasks = [{ id: 'a', deps: ['b'] }, { id: 'b', deps: ['a'] }];
  const { layers, cycle } = core.layerize(tasks, depsById(tasks));
  assert.strictEqual(layers.length, 1);
  assert.deepEqual([...layers[0]].sort(), ['a', 'b']);
  assert.deepEqual([...cycle].sort(), ['a', 'b']);
});

test('layerize 部分环：a 正常分层，b↔c 环整体压最后层', () => {
  const tasks = [{ id: 'a', deps: [] }, { id: 'b', deps: ['c'] }, { id: 'c', deps: ['b', 'a'] }];
  const { layers, cycle } = core.layerize(tasks, depsById(tasks));
  assert.deepEqual(layers[0], ['a']);
  assert.deepEqual([...layers[1]].sort(), ['b', 'c']);
  assert.deepEqual([...cycle].sort(), ['b', 'c']);
});

// ── 重心排序 ──
test('orderLayers 确定性：同输入两次结果一致', () => {
  const tasks = [
    { id: 'a', deps: [] }, { id: 'b', deps: [] }, { id: 'c', deps: ['a', 'b'] }, { id: 'd', deps: ['c'] },
  ];
  const d = depsById(tasks);
  const { layers } = core.layerize(tasks, d);
  assert.deepEqual(core.orderLayers(layers, d), core.orderLayers(layers, d));
});

test('orderLayers 重心排序：前驱均序（barycenter）生效', () => {
  // 层0 逆序 [x2,x1]；层1 = [y1(依赖x1), y2(依赖x2)] → 第1轮按前驱列均序重排
  const tasks = [
    { id: 'x1', deps: [] }, { id: 'x2', deps: [] },
    { id: 'y1', deps: ['x1'] }, { id: 'y2', deps: ['x2'] },
  ];
  const d = depsById(tasks);
  const ordered = core.orderLayers([['x2', 'x1'], ['y1', 'y2']], d);
  assert.deepEqual(ordered[1], ['y2', 'y1']); // y2 前驱 x2 列0 < y1 前驱 x1 列1
  assert.deepEqual(ordered[0], ['x2', 'x1']); // 第2轮按后继均序：x2 后继 y2 列0 → 不变
});

test('orderLayers 无前驱/无后继节点 bary=-1 排前', () => {
  const tasks = [
    { id: 'a', deps: [] }, { id: 'b', deps: ['a'] }, { id: 'c', deps: ['b'] },
  ];
  const d = depsById(tasks);
  const { layers } = core.layerize(tasks, d);
  assert.deepEqual(core.orderLayers(layers, d), [['a'], ['b'], ['c']]);
});

// ── 中止链闭包 ──
test('haltedSet：failed 后继闭包中 queued/idle 标中止', () => {
  const byId = {
    a: { id: 'a', executionStatus: 'failed', dependencies: [] },
    b: { id: 'b', executionStatus: 'queued', dependencies: ['a'] },
    c: { id: 'c', executionStatus: 'idle', dependencies: ['b'] },
  };
  assert.deepEqual([...core.haltedSet(byId, ['a'])].sort(), ['b', 'c']);
});

test('haltedSet：succeeded 后继不标中止，但其 idle 后继仍标', () => {
  const byId = {
    a: { id: 'a', executionStatus: 'failed', dependencies: [] },
    b: { id: 'b', executionStatus: 'succeeded', dependencies: ['a'] },
    c: { id: 'c', executionStatus: 'idle', dependencies: ['b'] },
  };
  assert.deepEqual([...core.haltedSet(byId, ['a'])], ['c']);
});

test('haltedSet：roots 省略时自动取 failed/cancelled/interrupted', () => {
  const byId = {
    a: { id: 'a', executionStatus: 'cancelled', dependencies: [] },
    b: { id: 'b', executionStatus: 'queued', dependencies: ['a'] },
    c: { id: 'c', executionStatus: 'running', dependencies: ['b'] },
    d: { id: 'd', executionStatus: 'idle', dependencies: [] },
  };
  assert.deepEqual([...core.haltedSet(byId)], ['b']);
});

test('haltedSet：非 queued/idle（paused/running）后继不标', () => {
  const byId = {
    a: { id: 'a', executionStatus: 'failed', dependencies: [] },
    b: { id: 'b', executionStatus: 'queued', dependencies: ['a'] },
    c: { id: 'c', executionStatus: 'paused', dependencies: ['b'] },
  };
  assert.deepEqual([...core.haltedSet(byId, ['a'])], ['b']);
});

// ── 池态 ──
test('poolState：snapshot 数组形态（running/queued 为列表）优先', () => {
  assert.deepEqual(core.poolState({ running: [{}, {}], queued: [{}], maxParallel: 3 }),
    { running: 2, queued: 1, maxParallel: 3, degraded: false });
});

test('poolState：snapshot 数字形态', () => {
  assert.deepEqual(core.poolState({ running: 1, queued: 2, maxParallel: 4 }),
    { running: 1, queued: 2, maxParallel: 4, degraded: false });
});

test('poolState：tasks 数组回退按 executionStatus 自算 + degraded', () => {
  const tasks = [
    { executionStatus: 'running' }, { executionStatus: 'running' },
    { executionStatus: 'queued' }, { executionStatus: 'idle' },
  ];
  assert.deepEqual(core.poolState(tasks), { running: 2, queued: 1, maxParallel: 3, degraded: true });
});

test('poolState：空输入回退空池', () => {
  assert.deepEqual(core.poolState([]), { running: 0, queued: 0, maxParallel: 3, degraded: true });
});

// ── 布局 ──
test('layout：节点坐标分层 + 边 bezier path + 层距 220', () => {
  const tasks = [{ id: 'a', deps: [] }, { id: 'b', deps: ['a'] }, { id: 'c', deps: ['b'] }];
  const d = depsById(tasks);
  const res = core.layout(tasks, d);
  assert.strictEqual(res.nodes.length, 3);
  assert.strictEqual(res.edges.length, 2);
  const pos = Object.fromEntries(res.nodes.map((n) => [n.id, n]));
  assert.strictEqual(pos.a.layer, 0);
  assert.strictEqual(pos.b.layer, 1);
  assert.strictEqual(pos.c.layer, 2);
  assert.strictEqual(pos.b.x - pos.a.x, 220); // 层距 220
  assert.strictEqual(pos.a.y, pos.b.y); // 单节点层垂直同 y
  assert.deepEqual(res.edges.map((e) => [e.from, e.to]), [['a', 'b'], ['b', 'c']]);
  for (const e of res.edges) {
    assert.match(e.path, /^M /);
    assert.ok(e.path.includes(' C '));
  }
  assert.ok(res.W > 0 && res.H > 0);
});

test('layout：opts 覆盖层距/节点尺寸', () => {
  const tasks = [{ id: 'a', deps: [] }, { id: 'b', deps: ['a'] }];
  const d = depsById(tasks);
  const res = core.layout(tasks, d, { layerGap: 100, nodeW: 120, nodeH: 40 });
  const pos = Object.fromEntries(res.nodes.map((n) => [n.id, n]));
  assert.strictEqual(pos.b.x - pos.a.x, 100);
});

test('layout：多节点层内垂直等距（nodeH 48 + gap 26）', () => {
  const tasks = [{ id: 'a', deps: [] }, { id: 'b', deps: [] }, { id: 'c', deps: [] }];
  const d = depsById(tasks);
  const res = core.layout(tasks, d);
  const pos = Object.fromEntries(res.nodes.map((n) => [n.id, n]));
  assert.strictEqual(pos.b.y - pos.a.y, 74);
  assert.strictEqual(pos.c.y - pos.b.y, 74);
});

test('layout：环容错不崩 + cycle 透出 + 环内无边', () => {
  const tasks = [{ id: 'a', deps: ['b'] }, { id: 'b', deps: ['a'] }];
  const d = depsById(tasks);
  const res = core.layout(tasks, d);
  assert.strictEqual(res.nodes.length, 2);
  assert.deepEqual([...res.cycle].sort(), ['a', 'b']);
  assert.strictEqual(res.edges.length, 0); // 同层环边跳过，避免退化 bezier
});
