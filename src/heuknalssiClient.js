import { randomUUID } from 'node:crypto';

const CROP_IDS = new Set(['APPLE', 'PEAR', 'CUCUMBER', 'POTATO', 'LETTUCE']);
const CULTIVATION_MODES = new Set(['OPEN_FIELD', 'FACILITY_SOIL', 'FACILITY_HYDRO']);

export class CoreBackendError extends Error {
  constructor(message, { status = 502, code = 'CORE_BACKEND_ERROR' } = {}) {
    super(message);
    this.name = 'CoreBackendError';
    this.status = status;
    this.code = code;
  }
}

export class HeuknalssiClient {
  constructor({
    baseUrl = process.env.HEUKNALSSI_BACKEND_ORIGIN || 'http://127.0.0.1:3100',
    requestOrigin = process.env.HEUKNALSSI_REQUEST_ORIGIN || 'http://127.0.0.1:3000',
    fetchImpl = globalThis.fetch,
    timeoutMs = 16_000,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/u, '');
    this.requestOrigin = requestOrigin;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.sessions = new Map();
  }

  async analyze({ userId, crop, region, cultivationMode = 'OPEN_FIELD', soilTest = null }) {
    const cropId = String(crop || '').toUpperCase();
    const normalizedRegion = String(region || '').trim();
    const mode = String(cultivationMode || '').toUpperCase();
    if (!CROP_IDS.has(cropId)) {
      throw new CoreBackendError('지원하는 작물을 선택해 주세요.', {
        status: 400,
        code: 'CROP_UNSUPPORTED',
      });
    }
    if (!normalizedRegion) {
      throw new CoreBackendError('농장 지역을 설정해 주세요.', {
        status: 400,
        code: 'REGION_REQUIRED',
      });
    }
    if (!CULTIVATION_MODES.has(mode)) {
      throw new CoreBackendError('재배 환경을 다시 확인해 주세요.', {
        status: 400,
        code: 'CULTIVATION_UNSUPPORTED',
      });
    }

    try {
      return await this.analyzeWithSession({
        userId,
        cropId,
        region: normalizedRegion,
        cultivationMode: mode,
        soilTest,
      });
    } catch (error) {
      if (!(error instanceof CoreBackendError) || error.status !== 401) throw error;
      this.sessions.delete(String(userId || 'anonymous'));
      return this.analyzeWithSession({
        userId,
        cropId,
        region: normalizedRegion,
        cultivationMode: mode,
        soilTest,
      });
    }
  }

  async analyzeWithSession({ userId, cropId, region, cultivationMode, soilTest = null }) {
    const session = await this.sessionFor(userId);
    const location = await this.request(
      `/api/locations?q=${encodeURIComponent(region)}`,
      { session },
    );
    const candidate = selectCandidate(location?.candidates, region);
    if (!candidate?.candidateToken) {
      throw new CoreBackendError('입력한 지역의 농장 위치를 찾지 못했습니다.', {
        status: 404,
        code: 'LOCATION_NOT_FOUND',
      });
    }

    const body = analysisRequest({
      crop: cropId,
      cultivationMode,
      candidateToken: candidate.candidateToken,
      soilTest,
    });
    return this.request('/api/analyses', {
      method: 'POST',
      session,
      csrf: true,
      headers: { 'Idempotency-Key': randomUUID() },
      body,
      expectedStatus: 201,
    });
  }

  /** 실제 Kakao 주소 검색으로 후보 지역 목록을 돌려줍니다 (온보딩 위치 확인용). */
  async searchLocations(userId, query) {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) {
      throw new CoreBackendError('주소를 입력해 주세요.', { status: 400, code: 'QUERY_REQUIRED' });
    }
    try {
      return await this.searchLocationsWithSession(userId, normalizedQuery);
    } catch (error) {
      if (!(error instanceof CoreBackendError) || error.status !== 401) throw error;
      this.sessions.delete(String(userId || 'anonymous'));
      return this.searchLocationsWithSession(userId, normalizedQuery);
    }
  }

  async searchLocationsWithSession(userId, normalizedQuery) {
    const session = await this.sessionFor(userId);
    const location = await this.request(
      `/api/locations?q=${encodeURIComponent(normalizedQuery)}`,
      { session },
    );
    return Array.isArray(location?.candidates) ? location.candidates : [];
  }

  /** 실제 카카오 역지오코딩으로, 좌표(위도/경도)를 실제 주소 후보로 바꿔줍니다. */
  async resolveCurrentLocation(userId, latitude, longitude) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new CoreBackendError('현재 위치 좌표가 올바르지 않습니다.', {
        status: 400,
        code: 'INVALID_COORDINATES',
      });
    }
    try {
      return await this.resolveCurrentLocationWithSession(userId, latitude, longitude);
    } catch (error) {
      if (!(error instanceof CoreBackendError) || error.status !== 401) throw error;
      this.sessions.delete(String(userId || 'anonymous'));
      return this.resolveCurrentLocationWithSession(userId, latitude, longitude);
    }
  }

  async resolveCurrentLocationWithSession(userId, latitude, longitude) {
    const session = await this.sessionFor(userId);
    const location = await this.request('/api/locations/current', {
      method: 'POST',
      session,
      csrf: true,
      headers: { 'Idempotency-Key': randomUUID() },
      body: { latitude, longitude },
    });
    return Array.isArray(location?.candidates) ? location.candidates : [];
  }

  async sessionFor(userId) {
    const key = String(userId || 'anonymous');
    const cached = this.sessions.get(key);
    if (cached) return cached;
    const response = await this.rawRequest('/api/session');
    const body = await parseBody(response);
    if (!response.ok || !body?.csrfToken) {
      throw coreResponseError(response, body);
    }
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? null;
    if (!cookie) {
      throw new CoreBackendError('분석 세션 쿠키를 받지 못했습니다.', {
        code: 'SESSION_COOKIE_MISSING',
      });
    }
    const session = { cookie, csrfToken: body.csrfToken };
    this.sessions.set(key, session);
    return session;
  }

  async request(pathname, options = {}) {
    const response = await this.rawRequest(pathname, options);
    const body = await parseBody(response);
    const expected = options.expectedStatus;
    if (!response.ok || (expected && response.status !== expected)) {
      throw coreResponseError(response, body);
    }
    return body;
  }

  async rawRequest(pathname, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Origin', this.requestOrigin);
    headers.set('Accept', 'application/json');
    if (options.session?.cookie) headers.set('Cookie', options.session.cookie);
    if (options.csrf && options.session?.csrfToken) {
      headers.set('X-CSRF-Token', options.session.csrfToken);
    }
    let body;
    if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(options.body);
    }
    try {
      return await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method: options.method || 'GET',
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new CoreBackendError(
        error?.name === 'TimeoutError'
          ? '농장 분석 시간이 초과되었습니다. 잠시 뒤 다시 시도해 주세요.'
          : '흙날씨 분석 서버에 연결하지 못했습니다.',
        { code: error?.name === 'TimeoutError' ? 'CORE_TIMEOUT' : 'CORE_UNREACHABLE' },
      );
    }
  }
}

export function analysisRequest({ crop, cultivationMode, candidateToken, soilTest = null }) {
  const request = {
    usageMode: 'ACTIVE_GROWING',
    location: { candidateToken, userConfirmed: true },
    crop,
    cultivationMode,
    growthStage: 'UNSPECIFIED',
    options: {
      includeSmartfarmBenchmark: false,
      includeSatelliteObservation: false,
      saveConsent: false,
    },
  };
  if (!['APPLE', 'PEAR'].includes(crop)) {
    request.season = {
      kind: 'UNKNOWN',
      profileId: 'UNKNOWN',
      startMonth: null,
      endMonth: null,
      userConfirmed: true,
    };
  }
  if (soilTest) {
    request.soilTest = { ...soilTest, userConfirmed: true };
  }
  return request;
}

function selectCandidate(candidates, query) {
  if (!Array.isArray(candidates)) return null;
  const normalized = query.replace(/\s+/gu, '');
  return (
    candidates.find((candidate) =>
      String(candidate?.displayName || '').replace(/\s+/gu, '').includes(normalized),
    ) ?? candidates[0] ?? null
  );
}

async function parseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: 'INVALID_CORE_RESPONSE' } };
  }
}

function coreResponseError(response, body) {
  const code = body?.error?.code || body?.code || 'CORE_BACKEND_ERROR';
  const message = body?.error?.message || body?.message || `분석 서버 오류 (${response.status})`;
  return new CoreBackendError(message, { status: response.status || 502, code });
}
