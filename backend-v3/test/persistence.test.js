import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPersistentStore,
  createSupabaseKvStore,
} from '../src/infrastructure/index.js';

const URL_BASE = 'https://project.supabase.co';
const SECRET = 'service-role-secret-value';

/** PostgREST 흉내. 어떤 요청이 나갔는지 그대로 기록한다. */
function fakeSupabase({ rows = new Map(), failWith = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', init });
    if (failWith) {
      return { ok: false, status: failWith, text: async () => '' };
    }
    const parsed = new URL(String(url));
    if ((init?.method ?? 'GET') === 'GET') {
      const keyFilter = parsed.searchParams.get('key') ?? '';
      const wanted = keyFilter.startsWith('eq.')
        ? [decodeURIComponent(keyFilter.slice(3))]
        : [...(keyFilter.match(/"((?:[^"\\]|\\.)*)"/gu) ?? [])].map((item) =>
            item.slice(1, -1).replaceAll('\\"', '"'),
          );
      const found = wanted
        .filter((key) => rows.has(key))
        .map((key) => ({ key, value: rows.get(key) }));
      return { ok: true, status: 200, text: async () => JSON.stringify(found) };
    }
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      rows.set(body.key, body.value);
      return { ok: true, status: 204, text: async () => '' };
    }
    if (init.method === 'DELETE') {
      const keyFilter = parsed.searchParams.get('key') ?? '';
      rows.delete(decodeURIComponent(keyFilter.slice(3)));
      return { ok: true, status: 204, text: async () => '' };
    }
    return { ok: false, status: 405, text: async () => '' };
  };
  return { fetchImpl, calls, rows };
}

test('Supabase 설정이 없으면 configured가 false이고 아무 요청도 보내지 않는다', async () => {
  let called = 0;
  const kv = createSupabaseKvStore({
    url: '',
    secretKey: '',
    fetchImpl: async () => {
      called += 1;
      return { ok: true, status: 200, text: async () => '[]' };
    },
  });

  assert.equal(kv.configured, false);
  assert.equal(await kv.get('any'), undefined);
  await kv.set('any', { a: 1 }, 1_000);
  await kv.delete('any');
  assert.equal(called, 0);
});

test('만료 판정은 DB에 맡기고 조회에 조건을 실어 보낸다', async () => {
  const { fetchImpl, calls } = fakeSupabase();
  const kv = createSupabaseKvStore({
    url: URL_BASE,
    secretKey: SECRET,
    fetchImpl,
  });

  await kv.get('session:abc');
  assert.equal(calls.length, 1);
  // 인스턴스마다 시계가 어긋나도 만료된 값이 되살아나면 안 된다.
  assert.match(calls[0].url, /expires_at=gt\.now\(\)/u);
});

test('비밀 키는 헤더로만 나가고 URL에 실리지 않는다', async () => {
  const { fetchImpl, calls } = fakeSupabase();
  const kv = createSupabaseKvStore({
    url: URL_BASE,
    secretKey: SECRET,
    fetchImpl,
  });

  await kv.set('session:abc', { id: 'abc' }, 60_000);
  const [call] = calls;
  assert.equal(call.init.headers.apikey, SECRET);
  assert.equal(call.init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(call.url.includes(SECRET), false);
});

test('오류 본문은 삼키고 상태 코드로만 분류한다', async () => {
  for (const [status, code] of [
    [401, 'AUTH_ERROR'],
    [403, 'AUTH_ERROR'],
    [500, 'STORE_ERROR'],
  ]) {
    const { fetchImpl } = fakeSupabase({ failWith: status });
    const kv = createSupabaseKvStore({
      url: URL_BASE,
      secretKey: SECRET,
      fetchImpl,
    });
    await assert.rejects(() => kv.get('k'), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      // 메시지에 키가 섞여 나오면 안 된다.
      assert.equal(error.message.includes(SECRET), false);
      return true;
    });
  }
});

test('요청에서 읽은 값은 다시 쓰지 않고, 바꾼 값만 반영한다', async () => {
  const rows = new Map([['analysis:kept', { id: 'kept' }]]);
  const { fetchImpl, calls } = fakeSupabase({ rows });
  const kv = createSupabaseKvStore({
    url: URL_BASE,
    secretKey: SECRET,
    fetchImpl,
  });
  const bridge = createPersistentStore({
    kv,
    namespace: 'analysis',
    clock: () => 1_000,
  });

  await bridge.hydrate(['kept'], { ttlMs: 60_000 });
  assert.deepEqual(bridge.store.get('kept'), { id: 'kept' });

  await bridge.flush();
  // 읽기만 했으므로 쓰기 요청이 없어야 한다.
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);

  bridge.store.set('fresh', { id: 'fresh' }, 60_000);
  await bridge.flush();
  const writes = calls.filter((call) => call.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].init.body).key, 'analysis:fresh');
});

test('종류가 달라도 같은 표를 쓰므로 접두어로 갈라 놓는다', async () => {
  const { fetchImpl, calls, rows } = fakeSupabase();
  const kv = createSupabaseKvStore({
    url: URL_BASE,
    secretKey: SECRET,
    fetchImpl,
  });
  const session = createPersistentStore({ kv, namespace: 'session' });
  const analysis = createPersistentStore({ kv, namespace: 'analysis' });

  session.store.set('same-id', { kind: 'session' }, 60_000);
  analysis.store.set('same-id', { kind: 'analysis' }, 60_000);
  await Promise.all([session.flush(), analysis.flush()]);

  assert.deepEqual(rows.get('session:same-id'), { kind: 'session' });
  assert.deepEqual(rows.get('analysis:same-id'), { kind: 'analysis' });
  assert.equal(calls.filter((call) => call.method === 'POST').length, 2);
});

test('공유 저장소가 죽어도 요청은 메모리로 계속 처리된다', async () => {
  const { fetchImpl } = fakeSupabase({ failWith: 500 });
  const kv = createSupabaseKvStore({
    url: URL_BASE,
    secretKey: SECRET,
    fetchImpl,
  });
  const seen = [];
  const bridge = createPersistentStore({
    kv,
    namespace: 'analysis',
    onError: (error) => seen.push(error.code),
  });

  await bridge.hydrate(['missing'], { ttlMs: 60_000 });
  bridge.store.set('local', { id: 'local' }, 60_000);
  await bridge.flush();

  // 저장은 실패해도 이 인스턴스에서는 값이 살아 있어야 한다.
  assert.deepEqual(bridge.store.get('local'), { id: 'local' });
  assert.deepEqual(seen, ['STORE_ERROR', 'STORE_ERROR']);
});

test('되살릴 항목이 없거나 이미 메모리에 있으면 왕복하지 않는다', async () => {
  const { fetchImpl, calls } = fakeSupabase();
  const kv = createSupabaseKvStore({
    url: URL_BASE,
    secretKey: SECRET,
    fetchImpl,
  });
  const bridge = createPersistentStore({ kv, namespace: 'session' });

  await bridge.hydrate([], { ttlMs: 60_000 });
  await bridge.hydrate([null, undefined], { ttlMs: 60_000 });
  assert.equal(calls.length, 0);

  bridge.store.set('live', { id: 'live' }, 60_000);
  await bridge.hydrate(['live'], { ttlMs: 60_000 });
  assert.equal(calls.filter((call) => call.method === 'GET').length, 0);
});

test('한 요청에서 되살릴 키 수에 상한을 둔다', async () => {
  const { fetchImpl } = fakeSupabase();
  const kv = createSupabaseKvStore({
    url: URL_BASE,
    secretKey: SECRET,
    fetchImpl,
  });
  const tooMany = Array.from({ length: 33 }, (_, index) => `k${index}`);

  await assert.rejects(() => kv.getMany(tooMany), (error) => {
    assert.equal(error.code, 'TOO_MANY_KEYS');
    return true;
  });
});

test('접두어 없이 만들 수 없다', () => {
  assert.throws(() => createPersistentStore({ kv: null }), TypeError);
  assert.throws(
    () => createPersistentStore({ kv: null, namespace: '' }),
    TypeError,
  );
});
