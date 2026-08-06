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
    soilTestsByFarmId: {
      'farm-1': { ph: 6.2, sampledOn: '2026-07-10' },
    },
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
  assert.throws(
    () =>
      assertStorablePayload({
        version: 2,
        farms: payload.farms,
        soilTestsByFarmId: {
          'farm-other': { ph: 5.8, sampledOn: '2026-07-10' },
        },
      }),
    (error) =>
      error instanceof DeviceBackupError &&
      error.code === 'INVALID_PAYLOAD',
  );
});

test('backup payload preserves planning and crop-cycle fields without accepting arbitrary nested data', () => {
  const farm = {
    id: 'farm-planning',
    name: '평창 감자 준비 농장',
    updatedAt: '2026-08-04T00:00:00.000Z',
    situation: 'planning',
    crops: ['POTATO'],
    cropSettings: {
      potato: {
        cultivation: 'open-field',
        season: 'spring',
        cycle: {
          seasonId: 'potato-2027-spring',
          anchorType: 'SOWING',
          anchorDate: '2027-03-15',
          status: 'PLANNING',
          userConfirmed: true,
        },
      },
    },
    region: '강원특별자치도 평창군 진부면',
  };

  assert.deepEqual(
    assertStorablePayload({ version: 2, farms: [farm] }).farms[0],
    farm,
  );
  assert.throws(
    () =>
      assertStorablePayload({
        version: 2,
        farms: [
          {
            ...farm,
            cropSettings: {
              potato: {
                ...farm.cropSettings.potato,
                cycle: { ...farm.cropSettings.potato.cycle, secret: 'no' },
              },
            },
          },
        ],
      }),
    (error) =>
      error instanceof DeviceBackupError &&
      error.code === 'INVALID_PAYLOAD',
  );
});

test('browser farm profiles preserve lowercase crop identifiers used by the UI', () => {
  const farm = {
    id: 'farm-browser',
    name: '인천 남동구 · 사과',
    updatedAt: '2026-08-04T00:00:00.000Z',
    situation: 'growing',
    crops: ['apple'],
    cropSettings: {
      apple: {
        cultivation: 'open-field',
        season: 'annual',
        growth: 'middle',
        cycle: {
          seasonId: 'season-apple-browser',
          anchorType: 'FLOWERING',
          anchorDate: '2026-04-15',
          status: 'ACTIVE',
        },
      },
    },
    region: '인천광역시 남동구',
  };

  assert.deepEqual(
    assertStorablePayload({ version: 2, farms: [farm] }).farms[0],
    farm,
  );
  assert.throws(
    () => assertStorablePayload({
      version: 2,
      farms: [{ ...farm, crops: ['APPLE', 'apple'] }],
    }),
    (error) => error instanceof DeviceBackupError && error.code === 'INVALID_PAYLOAD',
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

test('configured backup probe verifies a hashed roundtrip without exposing its id', async () => {
  const calls = [];
  const store = createDeviceBackupStore({
    url: 'https://project.supabase.co',
    serviceKey: 'sb_secret_server-test',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response('true', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    now: () => Date.parse('2026-08-03T00:00:00.000Z'),
    probeId: () => 'private-probe-id',
  });

  assert.deepEqual(await store.probe(), {
    ready: true,
    state: 'READY',
    verifiedAt: '2026-08-03T00:00:00.000Z',
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /heuknalssi_device_backup_probe$/u);
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.p_key_hash, /^[a-f0-9]{64}$/u);
  assert.equal(calls[0].init.body.includes('private-probe-id'), false);
  assert.equal(calls[0].init.headers.apikey, 'sb_secret_server-test');
  assert.equal(Object.hasOwn(calls[0].init.headers, 'Authorization'), false);
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
