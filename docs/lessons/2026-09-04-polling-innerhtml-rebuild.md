# 2026-09-04 轮询 + innerHTML 无条件重建 → hover 闪烁与静态子节点丢失

**引用编号**：LESSON-20260904-02

## 现象

设置页「复制地址」按钮悬停时像被不停点击一样闪烁；且该按钮首次轮询后永久消失。

## 根因

同一个模式埋了两个 bug：250ms 轮询 `renderDsh()` 每 tick 无条件 `wrap.innerHTML = statusHtml`：

1. **hover 闪烁**：悬停中的按钮节点每秒被销毁重建 4 次，`:hover` 反复丢失
2. **静态子节点丢失**：innerHTML 整体替换删掉了静态 HTML 里的 `#dsh-copy-url`，后续 `getElementById` 永远 null——静默失效，无报错

## 规则沉淀

1. **轮询渲染一律加内容比对守卫**：`if (el.innerHTML !== newHtml) el.innerHTML = newHtml`——DOM 没变不重写，hover/选中态/焦点全保住，事件绑定也自然不重复
2. **innerHTML 整体重写会连带销毁静态模板里的子节点**：把交互元素（按钮）放进被轮询重建的容器前，先确认重建内容里包含它；「getElementById 为 null」类静默失效优先查这里
3. **onclick 属性赋值放守卫内**：DOM 未变时旧绑定仍在节点上，重绑既多余又（用 addEventListener 时）会叠加

## 引用

- 实现记录：`docs/lessons/2026-09-04-shell-nav-tokens-ui-fixes.md` #4/#5
- 修复：shell.html renderDsh 内容比对守卫
