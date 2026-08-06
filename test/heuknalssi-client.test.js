import assert from 'node:assert/strict';
import test from 'node:test';

import { analysisRequest, HeuknalssiClient } from '../src/heuknalssiClient.js';

test('client composes session, location, and active-growing analysis requests', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/session')) {
      return jsonResponse(200, { csrfToken: 'csrf-token' }, {
        'set-cookie': 'heuknalssi_session=session-cookie; Path=/; HttpOnly',
      });
    }
    if (url.includes('/api/locations?')) {
      return jsonResponse(200, {
        candidates: [{ displayName: '인천광역시 남동구', candidateToken: 'candidate-token' }],
      });
    }
    if (url.endsWith('/api/analyses')) {
      return jsonResponse(201, {
        analysisId: 'analysis-1',
        growthScore: { score: 78 },
        environmentCause: { status: 'GOOD' },
      });
    }
    return jsonResponse(404, {});
  };
  const client = new HeuknalssiClient({
    baseUrl: 'http://core.test',
    requestOrigin: 'http://app.test',
    fetchImpl,
  });

  const result = await client.analyze({
    userId: 'tester',
    crop: 'apple',
    region: '인천광역시 남동구',
  });

  assert.equal(result.analysisId, 'analysis-1');
  assert.equal(calls.length, 3);
  const create = calls[2];
  assert.equal(create.options.headers.get('Cookie'), 'heuknalssi_session=session-cookie');
  assert.equal(create.options.headers.get('X-CSRF-Token'), 'csrf-token');
  const body = JSON.parse(create.options.body);
  assert.equal(body.usageMode, 'ACTIVE_GROWING');
  assert.equal(body.crop, 'APPLE');
  assert.equal(body.cultivationMode, 'OPEN_FIELD');
  assert.equal(body.growthStage, 'UNSPECIFIED');
  assert.equal('season' in body, false);
});

test('annual and unknown season request shapes follow backend contract', () => {
  const apple = analysisRequest({
    crop: 'APPLE',
    cultivationMode: 'OPEN_FIELD',
    candidateToken: 'a',
  });
  const lettuce = analysisRequest({
    crop: 'LETTUCE',
    cultivationMode: 'OPEN_FIELD',
    candidateToken: 'b',
  });

  assert.equal(apple.season, undefined);
  assert.equal(lettuce.season.kind, 'UNKNOWN');
  assert.equal(lettuce.season.userConfirmed, true);
});

test('client refreshes an expired core session once after a backend restart', async () => {
  let sessionCalls = 0;
  const cookies = [];
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/api/session')) {
      sessionCalls += 1;
      return jsonResponse(200, { csrfToken: `csrf-${sessionCalls}` }, {
        'set-cookie': `heuknalssi_session=session-${sessionCalls}; Path=/; HttpOnly`,
      });
    }
    if (url.includes('/api/locations?')) {
      const cookie = options.headers.get('Cookie');
      cookies.push(cookie);
      if (cookie === 'heuknalssi_session=session-1') {
        return jsonResponse(401, { error: { code: 'SESSION_INVALID' } });
      }
      return jsonResponse(200, {
        candidates: [{ displayName: '인천광역시 남동구', candidateToken: 'candidate-token' }],
      });
    }
    if (url.endsWith('/api/analyses')) {
      return jsonResponse(201, { analysisId: 'analysis-after-restart' });
    }
    return jsonResponse(404, {});
  };
  const client = new HeuknalssiClient({
    baseUrl: 'http://core.test',
    requestOrigin: 'http://app.test',
    fetchImpl,
  });

  const result = await client.analyze({
    userId: 'tester',
    crop: 'apple',
    region: '인천광역시 남동구',
  });

  assert.equal(result.analysisId, 'analysis-after-restart');
  assert.equal(sessionCalls, 2);
  assert.deepEqual(cookies, [
    'heuknalssi_session=session-1',
    'heuknalssi_session=session-2',
  ]);
});

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
