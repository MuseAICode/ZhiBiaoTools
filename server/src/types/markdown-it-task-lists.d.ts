// markdown-it-task-lists 2.1.1 没有自带类型声明；只声明整本导出（src/export/documentHtml.ts）用到的插件签名。
declare module 'markdown-it-task-lists' {
  import type { PluginWithOptions } from 'markdown-it';

  const taskLists: PluginWithOptions<{ enabled?: boolean; label?: boolean; labelAfter?: boolean }>;
  export default taskLists;
}
