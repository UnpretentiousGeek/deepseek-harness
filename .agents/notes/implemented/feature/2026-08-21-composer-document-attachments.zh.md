# Agent Note: Composer document attachments extracted to text

Status: implemented

[English](2026-08-21-composer-document-attachments.md) | 中文

## Problem

输入框此前只接受图片。来自工作区之外的 JSON、Markdown、CSV、PDF、DOCX 和 XLSX 文件没有进入 prompt 的路径：附件接缝只支持位图，模型可见内容契约中也没有它们的位置。用户只能手动复制粘贴或自行把文件搬进工作区。

## Decision

文档成为附件接缝的第二种上传类型，并且在任何持久化之前就变成纯文本。输入框的回形针选择器、粘贴和拖放同时接受两类；文档草稿在附件栏渲染为文件名芯片，提交时作为 `document` wire 部件发送。宿主在 prompt 准入时按 store 的 `documentLimits` 校验批次并提取每个成员的文本，用固定的 `<document name="…" type="…">` 信封包裹为普通的持久文本块。

由于持久记录就是文本，下游没有任何改动：不新增会话事件、不改提供方序列化、不需要压缩占位符、不动 SDK 投影。“模型可见 ⟺ 已记录”平凡成立，每条模型路由——包括纯文本路由——都无需门控即可消费文档。

提取按格式分派：文本类媒体按 UTF-8 解码并带二进制防护（NUL 字节或替换字符占多数即拒绝）；PDF 走内置 pdf.js 构建，DOCX 用 mammoth 纯文本读取器，XLSX 工作簿序列化为逐工作表的 TSV 块。空提取（空文件、扫描页）会大声失败而不是附加空白。超限提取被接纳并以可见的 `[Document truncated.]` 标记截断；各项上限（默认单文件 10 MiB、每条消息 10 个文档与 30 MiB、每个文档 200,000 字符）是附件后端配置，并以 `documentLimits` 投影给客户端，与 `imageLimits` 并列参与同一整批加入预检。

基类 `AttachmentStore` 不接受任何文档——默认策略的媒体类型列表为空，使每个批次以 `UNSUPPORTED_DOCUMENT_TYPE` 拒绝——具备解析能力的后端覆盖限额与逐文件提取器。斜杠命令保持仅图片契约：附加到图片命令上的文档以产品文案拒绝，通用不支持通知的措辞也改为“附件”。

## Alternatives considered

**新增持久的 `document` 内容部件。** 它会波及会话日志契约、所有提供方适配器、压缩占位符和两套 SDK 投影，只为承载没有提供方原生接受的字节。在准入时提取让 wire 保持诚实、日志保持可移植。

**工作区交接（保存文件并告知智能体路径）。** 零依赖且永远格式无关，但内容不会自动进入上下文，每次使用多一次工具往返，还需要写入会话工作区的物料化管道。在“内联提取”决策下落选；可作为超大文件的伴生方案重启讨论。

**客户端侧提取。** 宿主更薄，但会把 pdf.js、mammoth 和 ExcelJS 打进浏览器载荷并复制准入策略。服务端提取保留统一的限额故事与依赖集合。

## Consequences

文档在所有路由可用，代价是本地附件后端新增三个运行时依赖（unpdf、mammoth、exceljs）。解析质量取决于解析器：版式复杂的 PDF 与合并单元格的表格提取并不完美，扫描版 PDF 大声失败，旧二进制格式（.doc、.xls、.ppt）按名拒绝。大文档按其提取文本占用上下文，受字符上限与截断标记约束。

## Testing

本地后端规格往返手写的 PDF、手工构建的 DOCX zip 和 ExcelJS 写出的工作簿，并钉住二进制防护、空提取拒绝、批量限额顺序、截断标记与基类不接受任何文档的策略。api-proxy 规格钉住持久信封文本与不支持类型的拒绝。Composer 规格覆盖混合类型加入、按类型限额预检、document wire 部件、命令面拒绝与选择器 accept 提示。`DSH_SNAPSHOT=replay pnpm run test:web` 固定组装后的 composer 输出。
