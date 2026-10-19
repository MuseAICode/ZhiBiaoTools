import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  maskConfigForRenderer,
  resolveIncomingConfigSecrets,
  resolveImageModelListConfig,
} = require('../../electron/services/configSecrets.cjs');

const TEXT_KEY = 'sk-text-0123456789abcd';
const DEEPSEEK_KEY = 'sk-deepseek-0123456789wxyz';
const IMAGE_KEY = 'sk-image-0123456789efgh';
const COMFY_KEY = 'comfy-0123456789ijkl';
const MINERU_TOKEN = 'mineru-0123456789mnop';

function createStoredConfig() {
  return {
    text_model_provider: 'custom',
    api_key: TEXT_KEY,
    base_url: 'https://llm.example.com/v1',
    model_name: 'custom-model',
    text_model_profiles: {
      custom: { api_key: TEXT_KEY, base_url: 'https://llm.example.com/v1', model_name: 'custom-model' },
      deepseek: { api_key: DEEPSEEK_KEY, base_url: 'https://api.deepseek.com', model_name: 'deepseek-chat' },
      agnes: { api_key: '', base_url: 'https://apihub.agnes-ai.com/v1', model_name: '' },
    },
    image_model: { provider: 'custom', api_key: IMAGE_KEY, base_url: 'https://img.example.com/v1', model_name: 'img' },
    image_model_profiles: {
      custom: { provider: 'custom', api_key: 'stale-profile-key', base_url: 'https://img.example.com/v1' },
      comfyui: { provider: 'comfyui', api_key: COMFY_KEY, base_url: 'http://127.0.0.1:8188' },
    },
    components: {
      file_parser: { provider: 'mineru', mineru_token: MINERU_TOKEN },
      mermaid_concurrency_limit: 5,
    },
    developer_mode: true,
  };
}

// 模拟设置页：拿到打码后的配置，原样回传（可在其上做修改）。
function roundTrip(stored: ReturnType<typeof createStoredConfig>, edit: (config: any) => void = () => {}) {
  const fromRenderer = structuredClone(maskConfigForRenderer(stored));
  edit(fromRenderer);
  return resolveIncomingConfigSecrets(fromRenderer, stored);
}

describe('maskConfigForRenderer', () => {
  it('把所有凭据字段置空，其余字段原样保留', () => {
    const masked = maskConfigForRenderer(createStoredConfig());

    expect(masked.api_key).toBe('');
    expect(masked.text_model_profiles.custom.api_key).toBe('');
    expect(masked.text_model_profiles.deepseek.api_key).toBe('');
    expect(masked.image_model.api_key).toBe('');
    expect(masked.image_model_profiles.custom.api_key).toBe('');
    expect(masked.image_model_profiles.comfyui.api_key).toBe('');
    expect(masked.components.file_parser.mineru_token).toBe('');

    expect(masked.base_url).toBe('https://llm.example.com/v1');
    expect(masked.text_model_profiles.deepseek.model_name).toBe('deepseek-chat');
    expect(masked.components.file_parser.provider).toBe('mineru');
    expect(masked.components.mermaid_concurrency_limit).toBe(5);
    expect(masked.developer_mode).toBe(true);
  });

  it('打码结果中任何位置都不出现明文凭据', () => {
    const serialized = JSON.stringify(maskConfigForRenderer(createStoredConfig()));
    for (const secret of [TEXT_KEY, DEEPSEEK_KEY, IMAGE_KEY, COMFY_KEY, MINERU_TOKEN, 'stale-profile-key']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('credential_status 只给出是否已配置和末尾 4 位，过短的凭据不显示末尾', () => {
    const stored = createStoredConfig();
    stored.text_model_profiles.agnes.api_key = 'short-key';
    const { credential_status: status } = maskConfigForRenderer(stored);

    expect(status.text.custom).toEqual({ configured: true, tail: 'abcd' });
    expect(status.text.deepseek).toEqual({ configured: true, tail: 'wxyz' });
    expect(status.text.agnes).toEqual({ configured: true, tail: '' });
    expect(status.image.comfyui).toEqual({ configured: true, tail: 'ijkl' });
    expect(status.mineru).toEqual({ configured: true, tail: 'mnop' });
  });

  it('生图状态以当前选中的 image_model 为准，而不是档案里的旧值', () => {
    const { credential_status: status } = maskConfigForRenderer(createStoredConfig());
    expect(status.image.custom).toEqual({ configured: true, tail: 'efgh' });
  });

  it('未配置的凭据显示为未配置', () => {
    const stored = createStoredConfig();
    stored.text_model_profiles.agnes.api_key = '   ';
    stored.components.file_parser.mineru_token = '';
    const { credential_status: status } = maskConfigForRenderer(stored);

    expect(status.text.agnes).toEqual({ configured: false, tail: '' });
    expect(status.mineru).toEqual({ configured: false, tail: '' });
  });

  it('不修改传入的配置对象', () => {
    const stored = createStoredConfig();
    const snapshot = structuredClone(stored);
    maskConfigForRenderer(stored);
    expect(stored).toEqual(snapshot);
  });

  it('非对象输入原样返回', () => {
    expect(maskConfigForRenderer(null)).toBeNull();
    expect(maskConfigForRenderer(undefined)).toBeUndefined();
  });
});

describe('resolveIncomingConfigSecrets', () => {
  it('打码后原样回传：所有凭据还原为已保存的值', () => {
    const resolved = roundTrip(createStoredConfig());

    expect(resolved.api_key).toBe(TEXT_KEY);
    expect(resolved.text_model_profiles.custom.api_key).toBe(TEXT_KEY);
    expect(resolved.text_model_profiles.deepseek.api_key).toBe(DEEPSEEK_KEY);
    expect(resolved.text_model_profiles.agnes.api_key).toBe('');
    // 当前生图档案按 image_model 还原，覆盖 image_model_profiles 中的旧值。
    expect(resolved.image_model.api_key).toBe(IMAGE_KEY);
    expect(resolved.image_model_profiles.custom.api_key).toBe(IMAGE_KEY);
    expect(resolved.image_model_profiles.comfyui.api_key).toBe(COMFY_KEY);
    expect(resolved.components.file_parser.mineru_token).toBe(MINERU_TOKEN);
  });

  it('去掉只用于展示和请求的 credential_status、credential_clear', () => {
    const resolved = roundTrip(createStoredConfig(), (config) => {
      config.credential_clear = { text: [], image: [] };
    });
    expect(resolved).not.toHaveProperty('credential_status');
    expect(resolved).not.toHaveProperty('credential_clear');
  });

  it('新填写的凭据优先，并去掉首尾空白', () => {
    const resolved = roundTrip(createStoredConfig(), (config) => {
      config.api_key = '  sk-new-top  ';
      config.text_model_profiles.custom.api_key = ' sk-new-custom ';
      config.text_model_profiles.deepseek.api_key = 'sk-new-deepseek';
      config.image_model.api_key = 'sk-new-image';
      config.components.file_parser.mineru_token = 'new-token';
    });

    expect(resolved.api_key).toBe('sk-new-top');
    expect(resolved.text_model_profiles.custom.api_key).toBe('sk-new-custom');
    expect(resolved.text_model_profiles.deepseek.api_key).toBe('sk-new-deepseek');
    expect(resolved.image_model.api_key).toBe('sk-new-image');
    expect(resolved.components.file_parser.mineru_token).toBe('new-token');
  });

  it('credential_clear 显式清除对应凭据，其余照常还原', () => {
    const resolved = roundTrip(createStoredConfig(), (config) => {
      config.credential_clear = { text: ['custom'], image: ['comfyui'], mineru: true };
    });

    expect(resolved.api_key).toBe('');
    expect(resolved.text_model_profiles.custom.api_key).toBe('');
    expect(resolved.text_model_profiles.deepseek.api_key).toBe(DEEPSEEK_KEY);
    expect(resolved.image_model_profiles.comfyui.api_key).toBe('');
    expect(resolved.image_model.api_key).toBe(IMAGE_KEY);
    expect(resolved.components.file_parser.mineru_token).toBe('');
  });

  it('清除当前文本服务商时，即使回传中没有顶层 api_key 也清空顶层镜像', () => {
    const stored = createStoredConfig();
    const resolved = resolveIncomingConfigSecrets({ credential_clear: { text: ['custom'] } }, stored);
    expect(resolved.api_key).toBe('');
  });

  describe('修改 Base URL 后不还原 Key', () => {
    it('自定义文本档案改了 Base URL：档案和顶层镜像的 Key 都置空', () => {
      const resolved = roundTrip(createStoredConfig(), (config) => {
        config.base_url = 'https://attacker.example.com/v1';
        config.text_model_profiles.custom.base_url = 'https://attacker.example.com/v1';
      });

      expect(resolved.api_key).toBe('');
      expect(resolved.text_model_profiles.custom.api_key).toBe('');
      // 其他档案不受影响。
      expect(resolved.text_model_profiles.deepseek.api_key).toBe(DEEPSEEK_KEY);
    });

    it('只改顶层 base_url 也不还原顶层 Key', () => {
      const resolved = roundTrip(createStoredConfig(), (config) => {
        config.base_url = 'https://attacker.example.com/v1';
      });
      expect(resolved.api_key).toBe('');
      expect(resolved.text_model_profiles.custom.api_key).toBe(TEXT_KEY);
    });

    it('改了 Base URL 同时填写了新 Key：使用新 Key', () => {
      const resolved = roundTrip(createStoredConfig(), (config) => {
        config.text_model_profiles.custom.base_url = 'https://other.example.com/v1';
        config.text_model_profiles.custom.api_key = 'sk-for-other';
      });
      expect(resolved.text_model_profiles.custom.api_key).toBe('sk-for-other');
    });

    it('只差末尾斜杠或首尾空白不算改动', () => {
      const resolved = roundTrip(createStoredConfig(), (config) => {
        config.base_url = ' https://llm.example.com/v1/ ';
        config.text_model_profiles.custom.base_url = 'https://llm.example.com/v1//';
      });
      expect(resolved.api_key).toBe(TEXT_KEY);
      expect(resolved.text_model_profiles.custom.api_key).toBe(TEXT_KEY);
    });

    it('预置文本服务商的 Base URL 不可编辑，回传值不同也照常还原', () => {
      const resolved = roundTrip(createStoredConfig(), (config) => {
        config.text_model_profiles.deepseek.base_url = 'https://attacker.example.com';
      });
      expect(resolved.text_model_profiles.deepseek.api_key).toBe(DEEPSEEK_KEY);
    });

    it('自定义和 ComfyUI 生图档案改了 Base URL：Key 置空', () => {
      const resolved = roundTrip(createStoredConfig(), (config) => {
        config.image_model.base_url = 'https://attacker.example.com/v1';
        config.image_model_profiles.comfyui.base_url = 'http://10.0.0.8:8188';
      });
      expect(resolved.image_model.api_key).toBe('');
      expect(resolved.image_model_profiles.comfyui.api_key).toBe('');
    });

    it('回传中没有 base_url 字段时不视为改动', () => {
      const stored = createStoredConfig();
      const resolved = resolveIncomingConfigSecrets({
        text_model_profiles: { custom: { api_key: '', model_name: 'renamed' } },
      }, stored);
      expect(resolved.text_model_profiles.custom.api_key).toBe(TEXT_KEY);
    });
  });

  it('切换文本服务商时，顶层 Key 按新服务商的已保存档案还原', () => {
    const resolved = roundTrip(createStoredConfig(), (config) => {
      config.text_model_provider = 'deepseek';
      config.base_url = 'https://api.deepseek.com';
    });
    expect(resolved.api_key).toBe(DEEPSEEK_KEY);
  });

  it('已保存配置缺失时，留空的凭据保持为空', () => {
    const masked = maskConfigForRenderer(createStoredConfig());
    const resolved = resolveIncomingConfigSecrets(masked, null);
    expect(resolved.api_key).toBe('');
    expect(resolved.text_model_profiles.custom.api_key).toBe('');
    expect(resolved.image_model.api_key).toBe('');
    expect(resolved.components.file_parser.mineru_token).toBe('');
  });
});

describe('resolveImageModelListConfig', () => {
  // 设置页拉取生图模型列表时，把顶层 Key 和 Base URL 换成生图档案的值。
  function imageListRequest(stored: ReturnType<typeof createStoredConfig>, provider: string, baseUrl: string) {
    const masked = structuredClone(maskConfigForRenderer(stored));
    if (provider !== masked.image_model.provider) masked.image_model = { ...masked.image_model_profiles[provider] };
    return { ...masked, api_key: '', base_url: baseUrl };
  }

  it('顶层 Key 按当前生图档案还原，而不是文本模型的 Key', () => {
    const stored = createStoredConfig();
    const resolved = resolveImageModelListConfig(imageListRequest(stored, 'custom', 'https://img.example.com/v1'), stored);
    expect(resolved.api_key).toBe(IMAGE_KEY);
  });

  it('生图服务商不是当前选中的，按 image_model_profiles 还原', () => {
    const stored = createStoredConfig();
    const resolved = resolveImageModelListConfig(imageListRequest(stored, 'comfyui', 'http://127.0.0.1:8188/'), stored);
    expect(resolved.api_key).toBe(COMFY_KEY);
  });

  it('Base URL 与生图档案不一致时不还原 Key', () => {
    const stored = createStoredConfig();
    const resolved = resolveImageModelListConfig(imageListRequest(stored, 'custom', 'https://attacker.example.com/v1'), stored);
    expect(resolved.api_key).toBe('');
  });
});
