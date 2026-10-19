import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createConfigStore } = require('../../electron/services/configStore.cjs');

let userDataDir = '';

// configStore 只用到 app.getPath('userData')，用临时目录代替 Electron app。
function createStore() {
  return createConfigStore({ getPath: () => userDataDir });
}

function configFile() {
  return path.join(userDataDir, 'user_config.json');
}

function writeRawConfig(config: unknown) {
  fs.writeFileSync(configFile(), JSON.stringify(config), 'utf-8');
}

function readRawConfig() {
  return JSON.parse(fs.readFileSync(configFile(), 'utf-8'));
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-store-test-'));
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('configStore.load：全新 userData', () => {
  it('没有配置文件时写入默认配置：文本和生图都是空的“自定义”', () => {
    const config = createStore().load();

    expect(config.text_model_provider).toBe('custom');
    expect(config.api_key).toBe('');
    expect(config.base_url).toBe('');
    expect(config.model_name).toBe('');
    expect(config.image_model.provider).toBe('custom');
    expect(config.image_model.api_key).toBe('');
    expect(config.image_model.status).toBe('untested');
    expect(config.components.file_parser).toEqual({ provider: 'local', mineru_token: '' });
    expect(Object.keys(config.text_model_profiles).sort()).toEqual(['agnes', 'custom', 'deepseek', 'volcengine']);
    expect(Object.keys(config.image_model_profiles).sort()).toEqual(['agnes', 'comfyui', 'custom', 'google-ai-studio', 'volcengine']);
    expect(readRawConfig()).toEqual(config);
  });

  it('配置文件损坏时抛出可读的错误', () => {
    fs.writeFileSync(configFile(), '{ not json', 'utf-8');
    expect(() => createStore().load()).toThrow(/^配置文件读取失败：/);
  });
});

describe('configStore.load：旧配置兼容', () => {
  it('只有顶层字段、没有服务商和档案的早期配置：迁入“自定义”档案', () => {
    writeRawConfig({ api_key: 'sk-legacy', base_url: 'https://llm.example.com/v1', model_name: 'legacy-model' });
    const config = createStore().load();

    expect(config.text_model_provider).toBe('custom');
    expect(config.text_model_profiles.custom).toMatchObject({
      api_key: 'sk-legacy',
      base_url: 'https://llm.example.com/v1',
      model_name: 'legacy-model',
    });
    expect(config.api_key).toBe('sk-legacy');
    expect(config.base_url).toBe('https://llm.example.com/v1');
  });

  it('预置服务商的顶层字段写回对应档案，Base URL 固定为预置地址', () => {
    writeRawConfig({
      text_model_provider: 'deepseek',
      api_key: 'sk-deepseek',
      base_url: 'https://attacker.example.com',
      model_name: 'deepseek-chat',
    });
    const config = createStore().load();

    expect(config.text_model_provider).toBe('deepseek');
    expect(config.text_model_profiles.deepseek).toMatchObject({
      api_key: 'sk-deepseek',
      base_url: 'https://api.deepseek.com',
      model_name: 'deepseek-chat',
    });
    expect(config.base_url).toBe('https://api.deepseek.com');
    expect(config.text_model_profiles.custom.api_key).toBe('');
  });

  it('已移除的服务商（如 jinlong）切到“自定义”，自定义档案为空时带入原档案', () => {
    writeRawConfig({
      text_model_provider: 'jinlong',
      api_key: '',
      base_url: '',
      model_name: '',
      text_model_profiles: {
        jinlong: { api_key: 'sk-jinlong', base_url: 'https://relay.example.com/v1', model_name: 'relay-model' },
        custom: { api_key: '', base_url: '', model_name: '' },
      },
    });
    const config = createStore().load();

    expect(config.text_model_provider).toBe('custom');
    expect(config.text_model_profiles.custom).toMatchObject({
      api_key: 'sk-jinlong',
      base_url: 'https://relay.example.com/v1',
      model_name: 'relay-model',
    });
    expect(config.text_model_profiles).not.toHaveProperty('jinlong');
    expect(readRawConfig().text_model_profiles).not.toHaveProperty('jinlong');
  });

  it('已移除的服务商切到“自定义”时，已有内容的自定义档案保持不变', () => {
    const custom = { api_key: 'sk-mine', base_url: 'https://mine.example.com/v1', model_name: 'mine' };
    writeRawConfig({
      text_model_provider: 'official',
      api_key: 'sk-official',
      base_url: 'https://official.example.com',
      text_model_profiles: { custom },
    });
    const config = createStore().load();

    expect(config.text_model_provider).toBe('custom');
    expect(config.text_model_profiles.custom).toMatchObject(custom);
    expect(config.api_key).toBe('sk-mine');
  });

  it('旧档案缺少的新字段补默认值，非法取值回退', () => {
    writeRawConfig({
      text_model_provider: 'custom',
      text_model_profiles: {
        custom: {
          api_key: 'sk-old',
          base_url: 'https://llm.example.com/v1',
          model_name: 'm',
          context_length_limit: -1,
          concurrency_limit: 'abc',
          temperature: 5,
          request_mode: 'websocket',
        },
      },
    });
    const config = createStore().load();

    expect(config.text_model_profiles.custom).toMatchObject({
      api_key: 'sk-old',
      multimodal_enabled: false,
      reasoning_effort: '',
      context_length_limit: 400000,
      concurrency_limit: 10,
      temperature_enabled: false,
      temperature: 0.7,
      request_mode: 'stream',
    });
  });

  it('未知生图服务商回退到“自定义”，已知服务商的生图配置写入对应档案', () => {
    writeRawConfig({ image_model: { provider: 'jinlong', api_key: 'sk-img', model_name: 'x' } });
    expect(createStore().load().image_model).toMatchObject({ provider: 'custom', api_key: 'sk-img' });

    writeRawConfig({ image_model: { provider: 'comfyui', base_url: 'http://10.0.0.8:8188', image_size: 'huge' } });
    const config = createStore().load();
    expect(config.image_model).toMatchObject({ provider: 'comfyui', base_url: 'http://10.0.0.8:8188', image_size: '1024x1024' });
    expect(config.image_model_profiles.comfyui).toEqual(config.image_model);
  });

  it('组件设置缺失时补默认值，并发量限制在 1-20', () => {
    writeRawConfig({ components: { mermaid_concurrency_limit: 99, html_concurrency_limit: 0 } });
    const { components } = createStore().load();
    expect(components).toEqual({
      file_parser: { provider: 'local', mineru_token: '' },
      mermaid_concurrency_limit: 20,
      html_concurrency_limit: 1,
    });
  });

  it('GPU 加速曾被关闭但未标记已配置的旧值：恢复为开启', () => {
    writeRawConfig({ gpu_hardware_acceleration_enabled: false, gpu_hardware_acceleration_configured: false });
    const config = createStore().load();
    expect(config.gpu_hardware_acceleration_enabled).toBe(true);
    expect(config.gpu_hardware_acceleration_configured).toBe(true);
  });

  it('归一化后有变化的旧配置写回磁盘，没有变化的不重写', () => {
    writeRawConfig({ text_model_provider: 'deepseek', api_key: 'sk-legacy' });
    const store = createStore();
    const config = store.load();
    expect(readRawConfig()).toEqual(config);

    fs.utimesSync(configFile(), new Date(0), new Date(0));
    store.load();
    expect(fs.statSync(configFile()).mtimeMs).toBe(0);
  });

  it('经“未知服务商 → 自定义”路径读取的旧配置保留 output_token_limit', () => {
    writeRawConfig({
      text_model_provider: 'jinlong',
      text_model_profiles: { jinlong: { api_key: 'sk-jinlong', output_token_limit: 8192 } },
    });
    const config = createStore().load();
    expect(config.output_token_limit).toBe(8192);
    expect(config.text_model_profiles.custom.output_token_limit).toBe(8192);
  });
});

describe('configStore.save', () => {
  it('只回传部分字段时，其他服务商档案保留磁盘上的值', () => {
    const store = createStore();
    writeRawConfig({
      text_model_provider: 'custom',
      text_model_profiles: {
        custom: { api_key: 'sk-custom', base_url: 'https://llm.example.com/v1', model_name: 'c' },
        deepseek: { api_key: 'sk-deepseek', model_name: 'deepseek-chat' },
      },
    });
    store.load();

    const result = store.save({ text_model_provider: 'deepseek' });
    expect(result.success).toBe(true);

    const config = store.load();
    expect(config.text_model_provider).toBe('deepseek');
    expect(config.api_key).toBe('sk-deepseek');
    expect(config.model_name).toBe('deepseek-chat');
    expect(config.text_model_profiles.custom).toMatchObject({ api_key: 'sk-custom', model_name: 'c' });
  });

  it('顶层字段写入当前服务商的档案', () => {
    const store = createStore();
    store.load();
    store.save({ text_model_provider: 'custom', api_key: 'sk-new', base_url: 'https://new.example.com/v1', model_name: 'n' });

    const config = store.load();
    expect(config.text_model_profiles.custom).toMatchObject({ api_key: 'sk-new', base_url: 'https://new.example.com/v1', model_name: 'n' });
  });

  it('写入后不留下临时文件', () => {
    const store = createStore();
    store.load();
    store.save({ developer_mode: true });
    expect(fs.readdirSync(userDataDir)).toEqual(['user_config.json']);
  });
});
