import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
  VERIFIED_KMA_MID_CONTRACT_VERSION,
  VERIFIED_KMA_SHORT_CONTRACT_VERSION,
} from '../src/adapters/index.js';
import { createBackend } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import {
  loadRuntimeOptions,
  validateRuntimeOptions,
} from '../server/runtime-bootstrap.js';

const PRODUCTION_SECRET =
  'production-session-secret-that-is-longer-than-thirty-two-characters';

test('production configuration requires a strong secret and HTTPS origins', () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        SESSION_SECRET: 'short',
        ALLOWED_ORIGINS: 'https://app.example.test',
      }),
    /SESSION_SECRET/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        SESSION_SECRET: PRODUCTION_SECRET,
        ALLOWED_ORIGINS: 'http://app.example.test',
      }),
    /must use HTTPS/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        SESSION_SECRET: PRODUCTION_SECRET,
        ALLOWED_ORIGINS: 'https://app.example.test/path',
      }),
    /Invalid ALLOWED_ORIGINS/,
  );

  const config = loadConfig({
    NODE_ENV: 'production',
    SESSION_SECRET: PRODUCTION_SECRET,
    ALLOWED_ORIGINS: 'https://app.example.test',
  });
  assert.deepEqual(config.allowedOrigins, ['https://app.example.test']);
});

test('device backup is unavailable without both server-side values and accepts a secret key', () => {
  const disabled = loadConfig({});
  assert.equal(disabled.capabilities.deviceBackup, 'NOT_AVAILABLE');
  assert.deepEqual(disabled.deviceBackupConfig, {
    url: null,
    secretKey: null,
  });
  assert.equal(disabled.capabilities.persistence, 'NOT_AVAILABLE');
  assert.deepEqual(disabled.sharedStateConfig, {
    url: null,
    secretKey: null,
  });

  const enabled = loadConfig({
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SECRET_KEY: 'server-side-secret-for-test',
  });
  assert.equal(
    enabled.capabilities.deviceBackup,
    'CONFIGURED_UNVERIFIED',
  );
  assert.equal(
    enabled.deviceBackupConfig.secretKey,
    'server-side-secret-for-test',
  );
  assert.equal(enabled.capabilities.persistence, 'CONFIGURED_UNVERIFIED');
  assert.deepEqual(enabled.sharedStateConfig, {
    url: 'https://project.supabase.co',
    secretKey: 'server-side-secret-for-test',
  });
});

test('default server preflight reports deployment HOLD without verified assets', async () => {
  const backend = createBackend({
    env: {
      NODE_ENV: 'development',
      SESSION_SECRET: 'development-session-secret-longer-than-thirty-two',
      ALLOWED_ORIGINS: 'http://localhost:3000',
    },
    logger: { info() {}, error() {} },
  });
  const preflight = await backend.services.getPreflight();
  assert.equal(preflight.ready, false);
  assert.equal(preflight.serviceState, 'HOLD');
  assert.equal(preflight.ruleRegistry.activeRuleCount, 0);
  assert.equal(preflight.locationMappings.verifiedCount, 0);
  assert.equal(preflight.adapters.climate, 'UNSUPPORTED');
  assert.equal(preflight.adapters.observations, 'UNSUPPORTED');
  assert.ok(preflight.blockers.length > 0);

  const serialized = JSON.stringify(preflight);
  assert.equal(serialized.includes(PRODUCTION_SECRET), false);
  assert.equal(/api[_-]?key|session[_-]?secret/iu.test(serialized), false);
});

test('server composition promotes persistence only after its live RPC probe', async () => {
  const calls = [];
  const backend = createBackend({
    env: {
      NODE_ENV: 'development',
      SESSION_SECRET: 'development-session-secret-longer-than-thirty-two',
      ALLOWED_ORIGINS: 'http://localhost:3000',
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SECRET_KEY: 'sb_secret_server-composition-test',
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response('true', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    logger: { info() {}, error() {} },
  });

  const preflight = await backend.services.getPreflight();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /heuknalssi_shared_state_probe$/u);
  assert.equal(calls[0].options.headers.apikey, 'sb_secret_server-composition-test');
  assert.equal(
    Object.hasOwn(calls[0].options.headers, 'Authorization'),
    false,
  );
  assert.equal(preflight.capabilities.persistence, 'READY');
  assert.equal(preflight.storage.state, 'READY');
  assert.deepEqual(preflight.deploymentBlockers, []);
  assert.equal(preflight.deploymentState, 'HOLD');
});

test('preflight accepts only the exact frozen live-adapter contract versions', async () => {
  const commonEnv = {
    NODE_ENV: 'development',
    SESSION_SECRET: 'development-session-secret-longer-than-thirty-two',
    ALLOWED_ORIGINS: 'http://localhost:3000',
    ENABLE_LIVE_KAKAO: 'true',
    ENABLE_LIVE_KMA_SHORT: 'true',
    ENABLE_LIVE_KMA_MID: 'true',
    KAKAO_REST_API_KEY: 'redacted-test-key',
    DATA_GO_KR_SERVICE_KEY: 'redacted-test-key',
  };
  const unsupported = createBackend({
    env: {
      ...commonEnv,
      KAKAO_CONTRACT_VERSION: 'arbitrary-contract',
      KMA_SHORT_CONTRACT_VERSION: 'arbitrary-contract',
      KMA_MID_CONTRACT_VERSION: 'arbitrary-contract',
    },
    logger: { info() {}, error() {} },
  });
  const held = await unsupported.services.getPreflight();
  assert.equal(held.adapters.kakao, 'HOLD');
  assert.equal(held.adapters.kmaShort, 'HOLD');
  assert.equal(held.adapters.kmaMid, 'HOLD');

  const verified = createBackend({
    env: {
      ...commonEnv,
      KAKAO_CONTRACT_VERSION:
        VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
      KMA_SHORT_CONTRACT_VERSION:
        VERIFIED_KMA_SHORT_CONTRACT_VERSION,
      KMA_MID_CONTRACT_VERSION:
        VERIFIED_KMA_MID_CONTRACT_VERSION,
    },
    logger: { info() {}, error() {} },
  });
  const configured = await verified.services.getPreflight();
  assert.equal(configured.adapters.kakao, 'READY');
  assert.equal(configured.adapters.kmaShort, 'READY');
  assert.equal(configured.adapters.kmaMid, 'READY');
  assert.equal(configured.ready, false);
  assert.equal(configured.serviceState, 'HOLD');
});

test('trusted runtime bootstrap is opt-in and accepts only composition options', async () => {
  assert.deepEqual(await loadRuntimeOptions({ env: {} }), {});
  assert.deepEqual(
    await loadRuntimeOptions({
      env: {
        TRUSTED_BACKEND_RUNTIME_MODULE: fileURLToPath(
          new URL('./fixtures/runtime-options.mjs', import.meta.url),
        ),
      },
    }),
    {
      rules: [],
      verifiedLocationMappings: {},
    },
  );
  assert.throws(
    () => validateRuntimeOptions({ server: {} }),
    /unsupported options/,
  );
  assert.throws(
    () => validateRuntimeOptions([]),
    /plain object/,
  );
  await assert.rejects(
    () =>
      loadRuntimeOptions({
        env: { TRUSTED_BACKEND_RUNTIME_MODULE: './runtime.mjs' },
      }),
    /absolute local path/,
  );
  await assert.rejects(
    () =>
      loadRuntimeOptions({
        env: { TRUSTED_BACKEND_RUNTIME_MODULE: '/tmp/runtime.json' },
      }),
    /\.js or \.mjs/,
  );
});
