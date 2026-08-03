import { randomBytes } from 'node:crypto';

import { normalizeTrustedProxyConfig } from '../src/infrastructure/client-ip.js';

function enabled(value) {
  return String(value).toLowerCase() === 'true';
}

function enabledWhenConfigured(value, credential) {
  if (String(value).toLowerCase() === 'false') return false;
  return enabled(value) || Boolean(credential);
}

function parseOrigins(value, nodeEnv) {
  const origins = String(value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length) return origins;
  if (nodeEnv === 'production') {
    throw new Error('ALLOWED_ORIGINS is required in production');
  }
  return ['http://localhost:3000'];
}

function validateOrigins(origins, nodeEnv) {
  return origins.map((origin) => {
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`Invalid ALLOWED_ORIGINS entry: ${origin}`);
    }
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      !['http:', 'https:'].includes(url.protocol)
    ) {
      throw new Error(`Invalid ALLOWED_ORIGINS entry: ${origin}`);
    }
    if (nodeEnv === 'production' && url.protocol !== 'https:') {
      throw new Error('Production ALLOWED_ORIGINS entries must use HTTPS');
    }
    return url.origin;
  });
}

function parseTrustedProxy(env) {
  if (
    env.TRUST_PROXY !== undefined &&
    String(env.TRUST_PROXY).trim() !== ''
  ) {
    throw new Error(
      'TRUST_PROXY is unsupported; configure TRUSTED_PROXY_RANGES explicitly',
    );
  }

  const value = String(env.TRUSTED_PROXY_RANGES ?? '').trim();
  if (!value) {
    return normalizeTrustedProxyConfig();
  }
  const ranges = value.split(',').map((range) => range.trim());
  if (ranges.some((range) => range.length === 0)) {
    throw new Error(
      'Invalid TRUSTED_PROXY_RANGES: entries must be non-empty',
    );
  }
  try {
    return normalizeTrustedProxyConfig({
      mode: 'allowlist',
      ranges,
    });
  } catch (error) {
    throw new Error(
      `Invalid TRUSTED_PROXY_RANGES: ${error.message}`,
      { cause: error },
    );
  }
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV === 'production' ? 'production' : 'development';
  const suppliedSecret = typeof env.SESSION_SECRET === 'string' ? env.SESSION_SECRET : '';
  if (nodeEnv === 'production' && suppliedSecret.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters in production');
  }

  const sessionSecret = suppliedSecret || randomBytes(32).toString('base64url');
  const port = Number(env.PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  const googleAiApiKey =
    env.GOOGLE_AI_API_KEY ||
    env.GEMINI_API_KEY ||
    env.GOOGLE_API_KEY ||
    null;
  const supabaseUrl = env.SUPABASE_URL || null;
  const supabaseSecretKey =
    env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || null;

  return Object.freeze({
    nodeEnv,
    port,
    sessionSecret,
    allowedOrigins: validateOrigins(
      parseOrigins(env.ALLOWED_ORIGINS, nodeEnv),
      nodeEnv,
    ),
    trustedProxy: parseTrustedProxy(env),
    coreDeadlineMs: 11_000,
    sourceTimeoutMs: 10_000,
    candidateTtlMs: 10 * 60 * 1000,
    analysisTtlMs: 60 * 60 * 1000,
    reportLockTtlMs: 15_000,
    adapterConfig: {
      kakao: {
        enabled: enabled(env.ENABLE_LIVE_KAKAO),
        apiKey: env.KAKAO_REST_API_KEY || null,
        contractVersion: env.KAKAO_CONTRACT_VERSION || null,
      },
      kmaShort: {
        enabled: enabled(env.ENABLE_LIVE_KMA_SHORT),
        serviceKey: env.DATA_GO_KR_SERVICE_KEY || null,
        contractVersion: env.KMA_SHORT_CONTRACT_VERSION || null,
      },
      kmaMid: {
        enabled: enabled(env.ENABLE_LIVE_KMA_MID),
        serviceKey: env.DATA_GO_KR_SERVICE_KEY || null,
        contractVersion: env.KMA_MID_CONTRACT_VERSION || null,
      },
      kmaAsos: {
        enabled: enabled(env.ENABLE_LIVE_KMA_ASOS),
        serviceKey: env.DATA_GO_KR_SERVICE_KEY || null,
        contractVersion: env.KMA_ASOS_CONTRACT_VERSION || null,
      },
      // API 허브를 우선 사용하며 미승인·장애 시 같은 기준기간 검수본을 쓴다.
      kmaClimate: {
        enabled: enabled(env.ENABLE_LIVE_KMA_CLIMATE_NORMAL),
        apiKey: env.KMA_API_HUB_AUTH_KEY || null,
        contractVersion: env.KMA_CLIMATE_NORMAL_CONTRACT_VERSION || null,
      },
      kmaLocationCatalog: {
        enabled: enabled(env.ENABLE_LIVE_KMA_LOCATION_CATALOG),
        apiKey: env.KMA_API_HUB_AUTH_KEY || null,
        contractVersion:
          env.KMA_LOCATION_CATALOG_CONTRACT_VERSION || null,
      },
      soilV2: {
        enabled: enabled(env.ENABLE_LIVE_SOIL),
        serviceKey: env.DATA_GO_KR_SERVICE_KEY || null,
        endpoint: env.SOIL_STAT_ENDPOINT || null,
        contractVersion: null,
      },
      soilField: {
        enabled: enabled(env.ENABLE_LIVE_SOIL_FIELD),
        serviceKey: env.DATA_GO_KR_SERVICE_KEY || null,
        endpoint: env.SOIL_FIELD_ENDPOINT || null,
        contractVersion: env.SOIL_FIELD_CONTRACT_VERSION || null,
      },
      soilExam: {
        enabled: enabled(env.ENABLE_LIVE_SOIL_EXAM),
        serviceKey: env.DATA_GO_KR_SERVICE_KEY || null,
        endpoint: env.SOIL_EXAM_ENDPOINT || null,
        contractVersion: env.SOIL_EXAM_CONTRACT_VERSION || null,
      },
      smartfarm: {
        enabled: false,
        serviceKey: null,
        contractVersion: null,
      },
      satellite: {
        enabled: enabled(env.ENABLE_SATELLITE),
        clientId: env.COPERNICUS_CLIENT_ID || null,
        clientSecret: env.COPERNICUS_CLIENT_SECRET || null,
        contractVersion: env.COPERNICUS_CONTRACT_VERSION || null,
      },
    },
    // 기기 이관 백업 저장소. 미설정이면 기능만 꺼지고 분석에는 영향이 없다.
    deviceBackupConfig: {
      url: supabaseUrl,
      secretKey: supabaseSecretKey,
    },
    // 세션·후보·분석·멱등성·속도 제한은 동일한 서버 전용 경로를 쓴다.
    // 설정만으로 READY가 되지 않으며 런타임 원자 probe를 통과해야 한다.
    sharedStateConfig: {
      url: supabaseUrl,
      secretKey: supabaseSecretKey,
    },
    photoStorageConfig: {
      url: supabaseUrl,
      secretKey: supabaseSecretKey,
      bucket: env.SUPABASE_PHOTO_BUCKET || 'farm-photos',
    },
    assistantConfig: {
      enabled: enabledWhenConfigured(env.ENABLE_GOOGLE_AI, googleAiApiKey),
      apiKey: googleAiApiKey,
      model: env.GOOGLE_AI_MODEL || 'gemini-3.5-flash-lite',
    },
    capabilities: {
      smartfarm: 'DISABLED',
      pestReference: 'REVIEWED_REFERENCE',
      pestLiveOccurrence: 'NOT_CONNECTED',
      satellite: enabled(env.ENABLE_SATELLITE)
        ? env.COPERNICUS_CLIENT_ID && env.COPERNICUS_CLIENT_SECRET
          ? 'CONFIGURED_UNVERIFIED'
          : 'CATALOG_ONLY'
        : 'DISABLED',
      persistence:
        supabaseUrl && supabaseSecretKey
          ? 'CONFIGURED_UNVERIFIED'
          : 'NOT_AVAILABLE',
      llmReport: enabled(env.ENABLE_LLM_REPORT) ? 'UNSUPPORTED' : 'DISABLED',
      assistant: enabledWhenConfigured(env.ENABLE_GOOGLE_AI, googleAiApiKey)
        ? 'READY'
        : 'FALLBACK',
      deviceBackup:
        supabaseUrl && supabaseSecretKey
          ? 'CONFIGURED_UNVERIFIED'
          : 'NOT_AVAILABLE',
      photoHistory:
        supabaseUrl && supabaseSecretKey
          ? 'CONFIGURED_UNVERIFIED'
          : 'LOCAL_ONLY',
    },
  });
}
