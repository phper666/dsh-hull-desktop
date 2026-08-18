import type { Rectangle } from 'electron';

/**
 * 官方 view 边界纯函数（S8 §2 D2 + §4 单测策略）：
 * view 坐标相对窗口内容区（d.ts：setBounds "relative to the window"——
 * D2 注记「move 跨屏无需处理（内容坐标已正确）」据此）→ x=navWidth、y=0；
 * 宽 = 内容宽 - nav（窗口窄于 nav → 0，view 隐藏等效）；高原样（0/负兜底 0）。
 * 边界同步：resize / maximize / unmaximize / 全屏 / display-metrics-changed 统一走此函数（幂等）。
 */
export function getViewBounds(contentBounds: Rectangle, navWidth: number): Rectangle {
  return {
    x: navWidth,
    y: 0,
    width: Math.max(0, contentBounds.width - navWidth),
    height: Math.max(0, contentBounds.height),
  };
}
