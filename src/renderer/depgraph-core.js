/**
 * U3 依赖图核心（纯函数，docs/design/U3-依赖图可视化-kanban-depgraph-design.md §四）
 * 拓扑分层（Kahn，环容错）+ 重心排序（2 轮，确定性）+ 布局坐标 + 池态 + 中止链闭包。
 * UMD：Node 下 module.exports（node:test 直测）；浏览器挂 window.depgraphCore。
 * 零依赖、零 DOM——渲染层（depgraph.js）与单测共用。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.depgraphCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HALT_SOURCE = new Set(['failed', 'cancelled', 'interrupted']);
  const DEFAULT_OPTS = { layerGap: 220, nodeW: 178, nodeH: 48, nodeGapY: 26, pad: 28 };

  /** 反向邻接：depId → 依赖它的后继 id（按 tasks 输入序，确定性） */
  function successorsOf(tasks, depsById) {
    const succ = new Map();
    for (const t of tasks) {
      for (const d of depsById[t.id] || []) {
        if (!succ.has(d)) succ.set(d, []);
        succ.get(d).push(t.id);
      }
    }
    return succ;
  }

  /**
   * Kahn 拓扑分层：层 = 到任一源的最长路径深度；环（异常数据）→ 整环压最后层并标 cycle。
   * @returns {{ layers: string[][], cycle: string[] }}
   */
  function layerize(tasks, depsById) {
    const ids = tasks.map((t) => t.id);
    const idSet = new Set(ids);
    // 入度只计任务集内合法引用（外部/脏引用不阻塞分层）
    const indeg = new Map(ids.map((id) => [id, (depsById[id] || []).filter((d) => idSet.has(d)).length]));
    const layer = new Map();
    const succ = successorsOf(tasks, depsById);
    const queue = ids.filter((id) => indeg.get(id) === 0);
    const done = new Set();
    for (const id of queue) layer.set(id, 0);
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi];
      done.add(cur);
      for (const s of succ.get(cur) || []) {
        layer.set(s, Math.max(layer.get(s) ?? -1, layer.get(cur) + 1));
        indeg.set(s, indeg.get(s) - 1);
        if (indeg.get(s) === 0) queue.push(s);
      }
    }
    const layers = [];
    const cycle = [];
    for (const id of ids) {
      if (!done.has(id)) { cycle.push(id); continue; }
      (layers[layer.get(id)] = layers[layer.get(id)] || []).push(id);
    }
    if (cycle.length) layers.push(cycle); // 环残留压最后层
    return { layers, cycle };
  }

  /**
   * 重心排序：第 1 轮源→汇按「前驱列均序」、第 2 轮汇→源按「后继列均序」。
   * 显式 tie-break（原序）→ 跨引擎确定性。
   * @param {string[][]} layers
   * @param {Record<string,string[]>} depsById
   * @returns {string[][]}
   */
  function orderLayers(layers, depsById) {
    const result = layers.map((L) => L.slice());
    if (result.length < 2) return result;
    const ids = result.flat();
    const preds = new Map(ids.map((id) => [id, []]));
    const succs = new Map();
    for (const id of ids) {
      for (const d of depsById[id] || []) {
        if (!ids.includes(d)) continue; // 脏引用/环外跳过
        preds.get(id).push(d);
        if (!succs.has(d)) succs.set(d, []);
        succs.get(d).push(id);
      }
    }
    const sortLayer = (li, neighborOf, neighborLayer) => {
      const cur = result[li];
      const scored = cur.map((id, i) => {
        const valid = (neighborOf.get(id) || []).filter((n) => result[neighborLayer].includes(n));
        const bary = valid.length
          ? valid.reduce((s, n) => s + result[neighborLayer].indexOf(n), 0) / valid.length
          : -1; // 无邻接节点 → 排前
        return [id, bary, i];
      });
      scored.sort((a, b) => a[1] - b[1] || a[2] - b[2]); // bary 主键 + 原序 tie-break
      result[li] = scored.map(([id]) => id);
    };
    for (let li = 1; li < result.length; li++) sortLayer(li, preds, li - 1);   // 轮1：前驱均序
    for (let li = result.length - 2; li >= 0; li--) sortLayer(li, succs, li + 1); // 轮2：后继均序
    return result;
  }

  /**
   * 布局：层距 layerGap（层中心距 220 默认）、节点 nodeW×nodeH（178×48）、层内垂直等距。
   * 边 = bezier path（M x1 y1 C mx y1, mx y2, x2 y2），同层（环）边跳过防退化。
   * @returns {{ nodes: {id,x,y,layer}[], edges: {from,to,path}[], W, H, layers, cycle }}
   */
  function layout(tasks, depsById, opts) {
    const o = Object.assign({}, DEFAULT_OPTS, opts || {});
    const { layers, cycle } = layerize(tasks, depsById);
    const ordered = orderLayers(layers, depsById);
    const pos = new Map();
    const nodes = [];
    for (let li = 0; li < ordered.length; li++) {
      const L = ordered[li];
      const x = o.pad + li * o.layerGap; // 层中心距 = layerGap
      const totalH = L.length * o.nodeH + (L.length - 1) * o.nodeGapY;
      L.forEach((id, i) => {
        const y = o.pad + (totalH - o.nodeH) / 2 + i * (o.nodeH + o.nodeGapY);
        pos.set(id, { x, y, layer: li });
        nodes.push({ id, x, y, layer: li });
      });
    }
    const edges = [];
    for (const t of tasks) {
      for (const d of depsById[t.id] || []) {
        const p = pos.get(d);
        const q = pos.get(t.id);
        if (!p || !q || p.layer === q.layer) continue; // 缺失/同层（环）跳过
        const x1 = p.x + o.nodeW, y1 = p.y + o.nodeH / 2;
        const x2 = q.x, y2 = q.y + o.nodeH / 2;
        const mx = (x1 + x2) / 2;
        edges.push({ from: d, to: t.id, path: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}` });
      }
    }
    const W = o.pad * 2 + (ordered.length - 1) * o.layerGap + o.nodeW;
    const maxNodes = ordered.length ? Math.max(...ordered.map((L) => L.length)) : 0;
    const H = o.pad * 2 + maxNodes * o.nodeH + Math.max(0, maxNodes - 1) * o.nodeGapY;
    return { nodes, edges, W, H, layers: ordered, cycle };
  }

  /**
   * 池态：快照（{running,queued,maxParallel}，running/queued 可为列表或计数）优先；
   * 回退 tasks 数组按 executionStatus 自算（degraded:true）。
   * @param {object|object[]} snapshotOrTasks
   * @returns {{ running, queued, maxParallel, degraded }}
   */
  function poolState(snapshotOrTasks) {
    const s = snapshotOrTasks;
    if (s && !Array.isArray(s)) {
      const num = (v) => (Array.isArray(v) ? v.length : Number(v) || 0);
      return {
        running: num(s.running),
        queued: num(s.queued),
        maxParallel: Number(s.maxParallel) || 3,
        degraded: false,
      };
    }
    const tasks = Array.isArray(s) ? s : [];
    let running = 0;
    let queued = 0;
    for (const t of tasks) {
      if (t.executionStatus === 'running') running++;
      else if (t.executionStatus === 'queued') queued++;
    }
    return { running, queued, maxParallel: 3, degraded: true };
  }

  /**
   * 中止链派生（视觉语义，非数据）：failed/cancelled/interrupted 源沿依赖正向闭包，
   * 凡 queued/idle 者标「已中止」；roots 省略时按源状态自动推导。
   * @param {Record<string,{executionStatus:string,dependencies?:string[]}>} tasksById
   * @param {string[]} [roots]
   * @returns {Set<string>}
   */
  function haltedSet(tasksById, roots) {
    const ids = Object.keys(tasksById);
    const src = Array.isArray(roots)
      ? roots
      : ids.filter((id) => HALT_SOURCE.has(tasksById[id]?.executionStatus));
    if (!src.length) return new Set();
    const succ = new Map();
    for (const id of ids) {
      for (const d of tasksById[id].dependencies || []) {
        if (!(d in tasksById)) continue;
        if (!succ.has(d)) succ.set(d, []);
        succ.get(d).push(id);
      }
    }
    const halted = new Set();
    const seen = new Set(src);
    const queue = src.slice();
    for (let qi = 0; qi < queue.length; qi++) {
      for (const s of succ.get(queue[qi]) || []) {
        if (seen.has(s)) continue;
        seen.add(s);
        queue.push(s);
        const st = tasksById[s]?.executionStatus;
        if (st === 'queued' || st === 'idle') halted.add(s);
      }
    }
    return halted;
  }

  return { layerize, orderLayers, layout, poolState, haltedSet };
});
