/// <reference types="vite/client" />

import type { PreloadBridge } from './shared/types';

declare global {
  interface Window {
    appBridge: PreloadBridge;
    appClient?: {
      appName: string;
      platform: string;
    };
  }
}

export {};
