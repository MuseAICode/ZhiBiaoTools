import { useCallback } from 'react';
import type { AppMenuNotice } from '../types/navigation';
import { useToast } from './ToastProvider';

export const developingNotice: AppMenuNotice = {
  message: '功能开发中，敬请期待。',
};

// 以提示条展示未开放功能说明，有外部链接时附带直达按钮。
export function useNoticeToast() {
  const { showToast } = useToast();

  return useCallback((notice: AppMenuNotice) => {
    const { externalUrl } = notice;
    showToast(notice.message, 'info', {
      duration: 7000,
      actions: externalUrl ? [
        {
          label: notice.actionLabel || '打开链接',
          variant: 'primary',
          onClick: () => openExternalUrl(externalUrl),
        },
      ] : undefined,
    });
  }, [showToast]);
}

async function openExternalUrl(url: string) {
  if (window.appBridge?.openExternal) {
    await window.appBridge.openExternal(url);
    return;
  }

  window.open(url, '_blank', 'noopener,noreferrer');
}
