import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DeviceBackupError,
  assertStorablePayload,
  createDeviceBackupStore,
  generateAccountKey,
  hashAccountKey,
  normalizeAccountKey,
} from '../src/infrastructure/index.js';

test('account keys avoid ambiguous characters and normalize separators', () => {
  const key = generateAccountKey(() => 0);
  assert.equal(key, 'AAAA-AAAA-AAAA');
  assert.equal(normalizeAccountKey('aaaa aaaa-aaaa'), key);
  assert.throws(
    () => normalizeAccountKey('OAAA-AAAA-AAAA'),
    (error) =>
      error instanceof DeviceBackupError &&
      error.code === 'INVALID_ACCOUNT_KEY',
  );
});

test('account-key hashing is deterministic and never returns the raw key', () => {
  const key = 'AAAA-AAAA-AAAA';
  const hash = hashAccountKey(key);
  assert.equal(hash, hashAccountKey('aaaa aaaa aaaa'));
  assert.match(hash, /^[a-f0-9]{64}$/u);
  assert.equal(hash.includes(key), false);
});

test('backup payload rejects unknown fields and oversized content', () => {
  assert.equal(
    assertStorablePayload({ region: '강원특별자치도 평창군' }).region,
    '강원특별자치도 평창군',
  );
  assert.throws(
    () => assertStorablePayload({ secret: 'not allowed' }),
    (error) =>
      error instanceof DeviceBackupError &&
      error.code === 'INVALID_PAYLOAD',
  );
  assert.throws(
    () =>
      assertStorablePayload({
        region: '강원특별자치도 평창군',
        todo: { details: '가'.repeat(140_000) },
      }),
    (error) =>
      error instanceof DeviceBackupError &&
      error.code === 'PAYLOAD_TOO_LARGE',
  );
});

test('backup payload accepts the complete local farm workspace and rejects malformed farms', () => {
  const payload = {
    version: 2,
    region: '경상북도 안동시',
    activeFarmId: 'farm-1',
    farms: [
      {
        id: 'farm-1',
        name: '안동 사과 농장',
        updatedAt: '2026-08-03T00:00:00.000Z',
        situation: 'growing',
        crops: ['APPLE'],
        cropSettings: {
          APPLE: {
            cultivationMode: 'OPEN_FIELD',
            growthStage: 'middle',
            seasonProfile: 'annual',
          },
        },
        region: '경상북도 안동시',
      },
    ],
    alarm: { enabled: true, hour: 7 },
    todo: { title: '과원 상태 확인' },
  };

  assert.deepEqual(assertStorablePayload(payload), payload);
  assert.throws(
    () =>
      assertStorablePayload({
        version: 2,
        activeFarmId: 'farm-missing',
        farms: payload.farms,
      }),
    (error) =>
      error instanceof DeviceBackupError &&
      error.code === 'INVALID_PAYLOAD',
  );
  assert.throws(
    () =>
      assertStorablePayload({
        version: 2,
        farms: [{ ...payload.farms[0], crops: ['UNKNOWN'] }],
      }),
    (error) =>
      error instanceof DeviceBackupError &&
      error.code === 'INVALID_PAYLOAD',
  );
});

test('unconfigured backup store fails closed', async () => {
  const store = createDeviceBackupStore();
  assert.equal(store.configured, false);
  await assert.rejects(
    store.save('AAAA-AAAA-AAAA', { region: '평창군' }),
    (error) =>
      error instanceof DeviceBackupError &&
      error.code === 'BACKUP_NOT_CONFIGURED',
  );
  await assert.rejects(
    store.load('AAAA-AAAA-AAAA'),
    (error) =>
      error instanceof DeviceBackupError &&
      error.code === 'BACKUP_NOT_CONFIGURED',
  );
});

test('configured backup store calls only the two hashed RPC contracts', async () => {
  const calls = [];
  const responses = [
    new Response(JSON.stringify('2026-07-27T00:00:00.000Z')),
    new Response(
      JSON.stringify([
        {
          payload: { region: '평창군' },
          updated_at: '2026-07-27T00:00:00.000Z',
        },
      ]),
    ),
  ];
  const store = createDeviceBackupStore({
    url: 'https://project.supabase.co/',
    serviceKey: 'server-only-secret',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return responses.shift();
    },
  });

  await store.save('AAAA-AAAA-AAAA', { region: '평창군' });
  const restored = await store.load('AAAA-AAAA-AAAA');

  assert.equal(calls[0].url.endsWith('/rest/v1/rpc/save_device_backup'), true);
  assert.equal(calls[1].url.endsWith('/rest/v1/rpc/load_device_backup'), true);
  assert.equal(
    JSON.parse(calls[0].init.body).p_key_hash,
    hashAccountKey('AAAA-AAAA-AAAA'),
  );
  assert.equal(calls[0].init.body.includes('AAAA-AAAA-AAAA'), false);
  assert.equal(calls[0].init.headers.apikey, 'server-only-secret');
  assert.deepEqual(restored.payload, { region: '평창군' });
});

test('provider failures are reduced to a stable backup error', async () => {
  const store = createDeviceBackupStore({
    url: 'https://project.supabase.co',
    serviceKey: 'server-only-secret',
    fetchImpl: async () => new Response('provider details', { status: 500 }),
  });
  await assert.rejects(
    store.load('AAAA-AAAA-AAAA'),
    (error) =>
      error instanceof DeviceBackupError &&
      error.code === 'BACKUP_STORE_ERROR' &&
      !error.message.includes('provider details'),
  );
});
