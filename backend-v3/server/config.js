import { randomBytes } from 'node:crypto';

import { normalizeTrustedProxyConfig } from '../src/infrastructure/client-ip.js';

function enabled(value) {
  return String(value).toLowerCase() === 'true';
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

  return Object.freeze({
    nodeEnv,
    port,
    sessionSecret,
    allowedOrigins: validateOrigins(
      parseOrigins(env.ALLOWED_ORIGINS, nodeEnv),
      nodeEnv,
    ),
    trustedProxy: parseTrustedProxy(env),
    coreDeadlineMs: 5_000,
    sourceTimeoutMs: 3_000,
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
      soilV2: {
        enabled: enabled(env.ENABLE_LIVE_SOIL),
        serviceKey: env.DATA_GO_KR_SERVICE_KEY || null,
        endpoint: env.SOIL_STAT_ENDPOINT || null,
        contractVersion: null,
        defaultYear: null,
      },
    },
    capabilities: {
      smartfarm: enabled(env.ENABLE_SMARTFARM) ? 'UNSUPPORTED' : 'DISABLED',
      satellite: enabled(env.ENABLE_SATELLITE) ? 'UNSUPPORTED' : 'DISABLED',
      persistence: 'NOT_AVAILABLE',
      llmReport: enabled(env.ENABLE_LLM_REPORT) ? 'UNSUPPORTED' : 'DISABLED',
    },
  });
}
