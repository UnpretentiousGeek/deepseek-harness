# Agent Note: Composer paperclip file picker for image intake

Status: implemented

[English](2026-08-21-composer-image-file-picker.md) | 中文

## Problem

草稿图片此前只能通过剪贴板粘贴和整页拖放进入输入框。两条路径都不可见：输入框上没有任何控件提示附件功能的存在，从磁盘选择截图必须先知道某个手势。输入框的其他每个功能都有可见控件，唯独媒体输入无法被发现。

## Decision

输入框工具行在命令按钮旁增加一个回形针按钮。它打开隐藏的原生文件选择器，并把选中的文件送入与粘贴、拖放相同的 intake 通道：先执行 `imageLimits` 投影预检查，`addImages` 仍是权威拒绝方。仅当附件面存在时渲染该按钮；其禁用条件与拖放接受条件一致（会话锁定、提交中、无附件面）。

文件输入的 `accept` 提示跟随投影的 intake 媒体类型；限制帧尚未到达时回退到固定的四种图片类型。提示不做任何决定：选择器放过的文件仍会被 `addImages` 以不支持类型的文案拒绝。文件输入在每次 change 后清空 value，使重复选择同一文件能再次触发 change。

按钮位于 conversation bar 条目，而非附件展示插件。`conversation.input.attachments` 槽位拥有草稿轨道、拖放遮罩和灯箱，且不接收任何草稿变更面；intake 面本就是 bar 条目的 prop。

## Alternatives considered

**放在命令按钮的菜单里。**"+"按钮打开的是斜杠命令名册，属于提示语言界面而非媒体入口；把选择器嵌进去会让最常见的媒体操作多花一步手势，也给菜单错误 labeling。

**把附件接缝扩展到任意文件。**附件后端、消息内容部件和提供方序列化均只支持图片；通用文件附件是跨层特性，需要独立的产品决策（类型、大小上限、非图片字节如何变为模型可见）。选择器交付当下已存在的能力；工作区文件已可通过 @ 引用到达智能体。

**由 ui-attachment 插件渲染按钮。**槽位契约只给该插件展示 props，为这一个控件新增注入的变更面并不值得——bar 条目已经接好了全部线路。

## Consequences

媒体附件变得可发现，三条 intake 路径共享同一套限额逻辑。范围仍限于图片：携带 PDF 的用户仍以路径引用或粘贴文本，选择器的 `accept` 提示可能放行宿主随后拒绝的类型。无附件面时隐藏 input 保持惰性，与会话缺失时的输入框姿态一致。

## Testing

input-bar 规格覆盖：点击回形针打开选择器、选中文件经共享 intake 并清空 value、空选择的空操作、`accept` 从投影限额与回退集合的推导、无附件面时的缺席、以及提交阶段的锁定。`DSH_SNAPSHOT=replay pnpm run test:web` 固定组装后的输入框输出。
