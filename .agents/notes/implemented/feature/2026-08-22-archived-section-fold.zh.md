# Agent Note: Collapsible Archived Sidebar Section

Status: implemented

[English](2026-08-22-archived-section-fold.md) | 中文

## Problem

侧边栏尾部的「归档」区无条件渲染全部已归档会话。归档是比重命名删除更轻量的操作，因此该区的常态就是很长——它会膨胀到与一个繁忙的 Workspace 分组相同的高度，而 Workspace 分组早已支持折叠。该区需要同样的折叠能力，但不能发明第二种交互模型，也不能在折叠后丢失归档数量。

## Decision

「归档」区的区头是一个与 Workspace 文件夹行同样式的折叠控件：悬停和键盘聚焦时，归档图标替换为同款实心三角形箭头——折叠时朝右，展开时旋转 90° 朝下。点击区头切换会话行的显隐；折叠时区头和会话计数仍然可见，因此该区依旧可被发现，计数也仍能一眼回答"是否归档过内容"。

折叠状态存放在浏览器持久化的 workspace 视图 store（`archivedExpanded`，默认展开）中，与 Workspace 分组展开状态并列（[侧边栏排序与折叠](2026-08-11-workspace-sidebar-order-and-folding.zh.md)）；分组树和平铺列表共享同一个状态：在一种视图下折叠，另一种视图同样折叠，因为两者渲染的是同一个尾部区域。store 的持久化 key 升级到 `dsh.workspace.view.v6`——持久化是整值 JSON，否则旧存储值会整体替换状态并使 `archivedExpanded` 变成 undefined。

归档集合为空时该区照旧不渲染；已归档行也依旧不参与拖拽/排序机制。

## Alternatives considered

**在每个列表组件内用局部 `useState`。** 每次宽/窄栏、分组/平铺的重挂载都会重置折叠状态，两个列表组件对该区的状态也会各执一词。

**复用 `groupExpansion` 并保留一个特殊 key。** 同一 store action 已经按保留的 workspace 账户 key 修剪 `groupExpansion` 条目，归档 key 需要一条修剪豁免规则，且该字段的文档语义（"per-Workspace identity"）会被悄悄扩大。

**保留旧 key，在读取处把 `undefined` 归并为展开。** 每个读取点都要为类型上不可能出现的值携带迁移逻辑；版本升级把这份成本换成一次性重置浏览器本地的视图偏好。

## Consequences

- 折叠后的归档不再挤占侧边栏，且折叠状态跨刷新和视图切换保持。
- v5→v6 的 key 升级一次性重置分组模式、排序模式、分组展开和各账户的会话顺序；浏览器本地视图偏好不承诺兼容。
- 折叠只隐藏行——恢复/取消归档/删除都作用于可见行，因此今天没有任何手势需要自动展开该区。

## Testing

组件测试覆盖：默认展开渲染、折叠后行列表隐藏而区头和计数保留、通过持久化 store 在完整卸载/重挂载后保持折叠、以及分组与平铺两种视图共享同一折叠状态。
