/**
 * D11: 封面捕获完成的自定义事件名。单独成模块，让书架视图只静态依赖
 * 这个几字节的常量；重型的 PDF 首页渲染（coverCapture.ts）则仅由打开
 * EPUB 时的动态 import 拉起——否则静态/动态混合导入会把整个渲染管线
 * 留在首屏 chunk（构建产物已在 D10 基线确认 index chunk 989 KiB）。
 */
export const COVER_STORED_EVENT = "reade:cover-stored";
