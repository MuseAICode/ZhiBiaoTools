// 导出 Excel 时显示的时间（标书查重、废标检查的导出共用）：按北京时间显示（桌面版用本机时区）。
const DISPLAY_TIME_ZONE = 'Asia/Shanghai';

function timeParts(date: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/** YYYY-MM-DD HH:MM:SS（与桌面版 formatDisplayTime 相同）。 */
export function formatDisplayTime(date: Date): string {
  const p = timeParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** 下载文件名中的时间：YYYYMMDD_HHMMSS（与桌面版 formatFileTimestamp 相同）。 */
export function fileTimestamp(date: Date): string {
  const p = timeParts(date);
  return `${p.year}${p.month}${p.day}_${p.hour}${p.minute}${p.second}`;
}
