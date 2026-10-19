// Renderer 只拿到打码后的配置：凭据字段一律返回空字符串，另附 credential_status 说明是否已配置和末尾几位。
// 回传配置时空值表示沿用已保存的值；Base URL 改动时不沿用，避免把已保存的 Key 发往新的地址。
const CREDENTIAL_TAIL_LENGTH = 4;
const MIN_LENGTH_FOR_TAIL = 12;
const EDITABLE_TEXT_ENDPOINT_PROVIDERS = new Set(['custom']);
const EDITABLE_IMAGE_ENDPOINT_PROVIDERS = new Set(['custom', 'comfyui']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function describeCredential(value) {
  const secret = String(value || '').trim();
  return {
    configured: Boolean(secret),
    // 过短的凭据不显示末尾，避免泄露大部分内容。
    tail: secret.length >= MIN_LENGTH_FOR_TAIL ? secret.slice(-CREDENTIAL_TAIL_LENGTH) : '',
  };
}

function normalizeEndpoint(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function mapProfiles(profiles, mapper) {
  return isPlainObject(profiles)
    ? Object.fromEntries(Object.entries(profiles).map(([provider, profile]) => [provider, mapper(provider, profile)]))
    : profiles;
}

function maskConfigForRenderer(config) {
  if (!isPlainObject(config)) return config;
  const textProfiles = isPlainObject(config.text_model_profiles) ? config.text_model_profiles : {};
  const imageProfiles = isPlainObject(config.image_model_profiles) ? { ...config.image_model_profiles } : {};
  const imageModel = isPlainObject(config.image_model) ? config.image_model : null;
  if (imageModel?.provider) imageProfiles[imageModel.provider] = imageModel;
  const fileParser = isPlainObject(config.components?.file_parser) ? config.components.file_parser : null;

  return {
    ...config,
    api_key: '',
    text_model_profiles: mapProfiles(config.text_model_profiles, (_provider, profile) => (isPlainObject(profile) ? { ...profile, api_key: '' } : profile)),
    ...(imageModel ? { image_model: { ...imageModel, api_key: '' } } : {}),
    image_model_profiles: mapProfiles(config.image_model_profiles, (_provider, profile) => (isPlainObject(profile) ? { ...profile, api_key: '' } : profile)),
    ...(fileParser ? { components: { ...config.components, file_parser: { ...fileParser, mineru_token: '' } } } : {}),
    credential_status: {
      text: Object.fromEntries(Object.entries(textProfiles).map(([provider, profile]) => [provider, describeCredential(profile?.api_key)])),
      image: Object.fromEntries(Object.entries(imageProfiles).map(([provider, profile]) => [provider, describeCredential(profile?.api_key)])),
      mineru: describeCredential(fileParser?.mineru_token),
    },
  };
}

// 新填写的值优先；否则只有清除标记或地址变化时置空，其余沿用已保存的值。
function resolveCredential(nextValue, storedValue, { cleared = false, endpointChanged = false } = {}) {
  const typed = typeof nextValue === 'string' ? nextValue.trim() : '';
  if (typed) return typed;
  if (cleared || endpointChanged) return '';
  return storedValue || '';
}

function endpointChanged(editable, nextBaseUrl, storedBaseUrl) {
  if (!editable || nextBaseUrl === undefined) return false;
  return normalizeEndpoint(nextBaseUrl) !== normalizeEndpoint(storedBaseUrl);
}

function getClearList(clear, key) {
  return Array.isArray(clear?.[key]) ? clear[key].map(String) : [];
}

function resolveTextProfile(provider, profile, storedProfile, clearedProviders) {
  if (!isPlainObject(profile)) return profile;
  return {
    ...profile,
    api_key: resolveCredential(profile.api_key, storedProfile?.api_key, {
      cleared: clearedProviders.includes(provider),
      endpointChanged: endpointChanged(EDITABLE_TEXT_ENDPOINT_PROVIDERS.has(provider), profile.base_url, storedProfile?.base_url),
    }),
  };
}

function resolveImageProfile(provider, profile, storedProfile, clearedProviders) {
  if (!isPlainObject(profile)) return profile;
  return {
    ...profile,
    api_key: resolveCredential(profile.api_key, storedProfile?.api_key, {
      cleared: clearedProviders.includes(provider),
      endpointChanged: endpointChanged(EDITABLE_IMAGE_ENDPOINT_PROVIDERS.has(provider), profile.base_url, storedProfile?.base_url),
    }),
  };
}

// 把 Renderer 回传的配置中留空的凭据还原为已保存的值，并去掉只用于展示的字段。
function resolveIncomingConfigSecrets(incoming, storedConfig) {
  if (!isPlainObject(incoming)) return incoming;
  const stored = isPlainObject(storedConfig) ? storedConfig : {};
  const { credential_status: _status, credential_clear: clear, ...config } = incoming;
  const clearedText = getClearList(clear, 'text');
  const clearedImage = getClearList(clear, 'image');
  const storedTextProfiles = isPlainObject(stored.text_model_profiles) ? stored.text_model_profiles : {};
  const storedImageProfiles = isPlainObject(stored.image_model_profiles) ? { ...stored.image_model_profiles } : {};
  if (isPlainObject(stored.image_model) && stored.image_model.provider) {
    storedImageProfiles[stored.image_model.provider] = stored.image_model;
  }
  const resolved = { ...config };

  if (isPlainObject(config.text_model_profiles)) {
    resolved.text_model_profiles = mapProfiles(config.text_model_profiles, (provider, profile) => (
      resolveTextProfile(provider, profile, storedTextProfiles[provider], clearedText)
    ));
  }

  // 顶层字段是当前文本服务商的镜像，按回传的服务商对应的已保存档案还原。
  const textProvider = config.text_model_provider ?? stored.text_model_provider;
  const textProviderTouched = clearedText.includes(textProvider);
  if ('api_key' in config || 'base_url' in config || textProviderTouched) {
    const storedProfile = storedTextProfiles[textProvider];
    resolved.api_key = resolveCredential(config.api_key, storedProfile?.api_key, {
      cleared: textProviderTouched,
      endpointChanged: endpointChanged(EDITABLE_TEXT_ENDPOINT_PROVIDERS.has(textProvider), config.base_url, storedProfile?.base_url),
    });
  }

  if (isPlainObject(config.image_model_profiles)) {
    resolved.image_model_profiles = mapProfiles(config.image_model_profiles, (provider, profile) => (
      resolveImageProfile(provider, profile, storedImageProfiles[provider], clearedImage)
    ));
  }

  if (isPlainObject(config.image_model)) {
    const provider = config.image_model.provider ?? stored.image_model?.provider;
    resolved.image_model = resolveImageProfile(provider, config.image_model, storedImageProfiles[provider], clearedImage);
  }

  if (isPlainObject(config.components?.file_parser)) {
    resolved.components = {
      ...config.components,
      file_parser: {
        ...config.components.file_parser,
        mineru_token: resolveCredential(config.components.file_parser.mineru_token, stored.components?.file_parser?.mineru_token, {
          cleared: clear?.mineru === true,
        }),
      },
    };
  }

  return resolved;
}

// 生图模型列表复用文本模型的拉取接口：顶层 Key 和 Base URL 由设置页替换为生图档案的值，按生图档案还原。
function resolveImageModelListConfig(incoming, storedConfig) {
  const resolved = resolveIncomingConfigSecrets(incoming, storedConfig);
  if (!isPlainObject(resolved)) return resolved;
  const provider = incoming.image_model?.provider ?? storedConfig?.image_model?.provider;
  const storedProfile = storedConfig?.image_model?.provider === provider
    ? storedConfig.image_model
    : storedConfig?.image_model_profiles?.[provider];
  return {
    ...resolved,
    api_key: resolveCredential(incoming.api_key, storedProfile?.api_key, {
      endpointChanged: normalizeEndpoint(incoming.base_url) !== normalizeEndpoint(storedProfile?.base_url),
    }),
  };
}

module.exports = {
  maskConfigForRenderer,
  resolveIncomingConfigSecrets,
  resolveImageModelListConfig,
};
