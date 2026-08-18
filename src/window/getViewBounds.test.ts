import { test } from 'node:test';
import { deepEqual } from 'node:assert/strict';

import { getViewBounds } from './getViewBounds';

/**
 * S8 §4 单测策略：getViewBounds 纯函数边界三用例（正常窗口 / 窗口窄于 nav / 0、负数兜底）。
 * 语义：view 坐标相对窗口内容区（D2 注记「move 跨屏无需处理」）→ x=navWidth、y=0；
 * 宽度 = 内容宽 - nav（不足则 0，等效隐藏）。
 */

test('getViewBounds：正常窗口 → 右侧内容区（x=nav 偏移，宽=扣除 nav）', () => {
  deepEqual(getViewBounds({ x: 0, y: 0, width: 1200, height: 800 }, 200), {
    x: 200,
    y: 0,
    width: 1000,
    height: 800,
  });
});

test('getViewBounds：窗口窄于 nav → 宽度兜底 0（view 隐藏等效）', () => {
  deepEqual(getViewBounds({ x: 0, y: 0, width: 100, height: 800 }, 200), {
    x: 200,
    y: 0,
    width: 0,
    height: 800,
  });
});

test('getViewBounds：0/负尺寸兜底 → 宽高均为 0；navWidth=0 原样', () => {
  deepEqual(getViewBounds({ x: 0, y: 0, width: 0, height: -5 }, 200), {
    x: 200,
    y: 0,
    width: 0,
    height: 0,
  });
  deepEqual(getViewBounds({ x: 10, y: 20, width: 300, height: 400 }, 0), {
    x: 0,
    y: 0,
    width: 300,
    height: 400,
  });
});
