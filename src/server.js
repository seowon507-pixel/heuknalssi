// server.js
// 청년농부 앱 백엔드 API (Node 내장 http, 외부 라이브러리 없음).
// 로그인 이후 흐름 지원: "처음 시작한 유저면 캐릭터 5종 중 선택".
//
// 실행:  node src/server.js   (기본 포트 4000)
//
// ── 인증(로그인) 연동 자리 ──────────────────────────────
// 지금은 요청 헤더 `x-user-id` 로 유저를 식별합니다.
// 나중에 로그인 화면을 붙이면, 로그인 성공 후 발급한 토큰을 검증해서
// userId를 넣어주는 방식(getUserId 함수)만 교체하면 됩니다.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FarmGame } from './farmGame.js';
import { CoreBackendError, HeuknalssiClient } from './heuknalssiClient.js';
import { UserStore } from './userStore.js';
import { toDateKey } from './dateUtil.js';

const PORT = process.env.PORT || 4000;
const store = new UserStore();
const coreBackend = new HeuknalssiClient();
const environmentCache = new Map();
const ENVIRONMENT_CACHE_MS = 10 * 60 * 1000;

// 프론트엔드 정적 파일 폴더 (public/)
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// /api 이외의 경로는 public/ 의 정적 파일로 응답 (없으면 index.html)
function serveStatic(res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  let filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) filePath = path.join(PUBLIC_DIR, 'index.html');
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }
  const type = MIME[path.extname(filePath)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, ...CORS_HEADERS });
  fs.createReadStream(filePath).pipe(res);
}

// ── 응답 도우미 ─────────────────────────────
// CORS: 브라우저 프론트엔드가 다른 오리진에서 호출할 수 있도록 허용 (개발용 전체 허용)
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-user-id',
};

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...CORS_HEADERS,
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// 로그인 연동 지점: 지금은 헤더에서 userId를 읽음 (나중에 토큰 검증으로 교체)
function getUserId(req) {
  const raw = req.headers['x-user-id'];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw); // 한글 이름 등은 인코딩되어 오므로 복원
  } catch {
    return raw;
  }
}

// ── 라우터 ─────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    // CORS 프리플라이트(OPTIONS) 처리
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      return res.end();
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = requestUrl;

    // API가 아닌 경로는 프론트엔드 정적 파일로 응답
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      return serveStatic(res, pathname);
    }

    // (공개) 선택 가능한 캐릭터 5종 — 로그인 없이도 조회 가능
    if (req.method === 'GET' && pathname === '/api/characters') {
      return send(res, 200, { characters: FarmGame.getCharacters() });
    }

    // 여기부터는 로그인 필요
    const userId = getUserId(req);
    if (!userId) {
      return send(res, 401, { error: '로그인이 필요합니다. (x-user-id 헤더 없음)' });
    }
    const game = store.getOrCreate(userId);

    // 위치 확인 전용 프록시입니다. 상세 주소와 좌표는 후보를 만드는 동안만
    // 흙날씨 백엔드로 전달하고, 이 앱의 사용자 저장소에는 남기지 않습니다.
    if (req.method === 'GET' && pathname === '/api/me/locations') {
      const query = String(requestUrl.searchParams.get('q') || '').trim().slice(0, 160);
      try {
        const result = await coreBackend.searchLocations({ userId, query });
        return send(res, 200, {
          ok: true,
          candidates: locationCandidateProjection(result?.candidates),
        });
      } catch (error) {
        return sendCoreError(res, error, '주소 후보를 찾지 못했습니다.');
      }
    }

    if (req.method === 'POST' && pathname === '/api/me/locations/current') {
      const body = await readJson(req);
      const latitude = Number(body.latitude);
      const longitude = Number(body.longitude);
      try {
        const result = await coreBackend.resolveCurrentLocation({ userId, latitude, longitude });
        return send(res, 200, {
          ok: true,
          candidates: locationCandidateProjection(result?.candidates),
        });
      } catch (error) {
        return sendCoreError(res, error, '현재 위치의 주소를 확인하지 못했습니다.');
      }
    }

    // 개인정보 최소화: 프로필에는 시·군·구 수준 지역명만 저장합니다.
    if (req.method === 'GET' && pathname === '/api/me/profile') {
      return send(res, 200, {
        ok: true,
        profile: game.getProfile(),
        cropProfiles: game.getStatus().cropProfiles,
        titles: game.getTitleProgress(),
      });
    }

    if (req.method === 'POST' && pathname === '/api/me/profile') {
      const body = await readJson(req);
      const update = {};
      if (body.displayName !== undefined) update.displayName = String(body.displayName).trim().slice(0, 20);
      if (body.onboardingComplete !== undefined) update.onboardingComplete = body.onboardingComplete === true;
      if (body.usageMode !== undefined) update.usageMode = body.usageMode;
      if (body.region !== undefined) update.region = String(body.region).trim().slice(0, 80);
      if (body.cultivationMode !== undefined) update.cultivationMode = body.cultivationMode;
      if (body.notificationsEnabled !== undefined) update.notificationsEnabled = body.notificationsEnabled === true;
      if (body.selectedTitleKey !== undefined) update.selectedTitleKey = body.selectedTitleKey;
      if (body.selectedBorderKey !== undefined) update.selectedBorderKey = body.selectedBorderKey;
      const profile = game.updateProfile(update);
      store.save();
      return send(res, 200, { ok: true, profile, titles: game.getTitleProgress() });
    }

    // 흙날씨 v3의 실제 공공데이터·작물 규칙 분석을 모바일 화면에 전달합니다.
    if ((req.method === 'GET' || req.method === 'POST') && pathname === '/api/me/environment') {
      const body = req.method === 'POST' ? await readJson(req) : {};
      const crop = body.crop || requestUrl.searchParams.get('crop');
      const region = body.region || requestUrl.searchParams.get('region');
      const candidateToken = String(body.candidateToken || '').trim();
      const cultivationMode = body.cultivationMode || requestUrl.searchParams.get('cultivationMode') || 'OPEN_FIELD';
      const requestedUsageMode = body.usageMode || requestUrl.searchParams.get('usageMode');
      const usageMode = requestedUsageMode === 'LAND_SEARCH'
        ? 'LAND_SEARCH'
        : 'ACTIVE_GROWING';
      const locationKey = candidateToken
        ? createHash('sha256').update(candidateToken).digest('hex').slice(0, 16)
        : String(region || '');
      const cacheKey = `${userId}:${crop}:${locationKey}:${cultivationMode}:${usageMode}`;
      const cached = environmentCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return send(res, 200, {
          ok: true,
          cached: true,
          analysis: cached.analysis,
          suitability: suitabilitySummary(cached.analysis),
          preventive: { added: [], notifications: [] },
        });
      }
      try {
        const fullAnalysis = await coreBackend.analyze({
          userId,
          crop,
          region,
          candidateToken,
          cultivationMode,
          usageMode,
        });
        const analysis = mobileAnalysisProjection(fullAnalysis);
        const preventive = usageMode === 'ACTIVE_GROWING'
          ? game.syncPreventiveTodos(analysis)
          : { added: [], notifications: [] };
        if (preventive.added.length) store.save();
        environmentCache.set(cacheKey, {
          analysis,
          expiresAt: Date.now() + ENVIRONMENT_CACHE_MS,
        });
        return send(res, 200, {
          ok: true,
          cached: false,
          analysis,
          suitability: suitabilitySummary(analysis),
          preventive,
        });
      } catch (error) {
        const statusCode = error instanceof CoreBackendError ? error.status : 502;
        return send(res, statusCode, {
          ok: false,
          code: error instanceof CoreBackendError ? error.code : 'CORE_BACKEND_ERROR',
          message: error instanceof CoreBackendError
            ? error.message
            : '농장 환경 분석을 불러오지 못했습니다.',
        });
      }
    }

    // (로그인 직후 호출) 온보딩 상태 — isFirstTime=true면 캐릭터 선택 화면 표시
    if (req.method === 'GET' && pathname === '/api/me/onboarding') {
      return send(res, 200, {
        userId,
        isFirstTime: game.isFirstTime(),
        needsCharacterSelection: game.needsCharacterSelection(),
        currentCharacter: game.getStatus().currentCrop, // 없으면 null
        characters: FarmGame.getCharacters(),            // 선택지 5종 함께 제공
      });
    }

    // 캐릭터 선택 (첫 시작 시, 또는 이전 작물을 다 키운 뒤)
    if (req.method === 'POST' && pathname === '/api/me/character') {
      const body = await readJson(req);
      const characterId = body.characterId;
      if (!characterId) {
        return send(res, 400, { ok: false, message: 'characterId가 필요합니다.' });
      }
      const context = body.cropContext || {};
      const result = game.selectCrop(characterId, new Date(), {
        usageMode: context.usageMode,
        region: String(context.region || '').trim().slice(0, 80),
        address: '',
        cultivationMode: context.cultivationMode,
        stageKey: context.stageKey,
        startedKey: context.startedKey,
        analysisId: context.analysisId,
      });
      if (!result.ok) {
        return send(res, 400, result); // 없는 작물이거나 이미 키우는 중
      }
      store.save();
      return send(res, 200, { ok: true, message: result.message, progress: result.progress });
    }

    // 전체 상태 조회(선택)
    if (req.method === 'GET' && pathname === '/api/me/status') {
      return send(res, 200, game.getStatus());
    }

    if (req.method === 'GET' && pathname === '/api/me/notifications') {
      return send(res, 200, {
        ok: true,
        notifications: [...(game.state.notifications || [])].reverse(),
      });
    }

    if (req.method === 'POST' && pathname === '/api/me/notifications/read') {
      const body = await readJson(req);
      for (const item of game.state.notifications || []) {
        if (!body.id || item.id === body.id) item.read = true;
      }
      store.save();
      return send(res, 200, { ok: true });
    }

    // 출석체크 (하루 1회 · 연속 출석 시 작물 성장)
    if (req.method === 'POST' && pathname === '/api/me/checkin') {
      const result = game.checkIn();
      if (result.ok) store.save();
      return send(res, 200, { ...result, status: game.getStatus() });
    }

    // 다 자란 작물 수확 (완료 기록으로 이동)
    if (req.method === 'POST' && pathname === '/api/me/harvest') {
      const body = await readJson(req);
      if (!body.cropId) {
        return send(res, 400, { ok: false, message: 'cropId가 필요합니다.' });
      }
      const result = game.harvestCrop(body.cropId);
      if (result.ok) store.save();
      return send(res, 200, { ...result, status: game.getStatus() });
    }

    // 비료 교환 카탈로그 + 이번 달 남은 교환 횟수
    if (req.method === 'GET' && pathname === '/api/me/rewards') {
      return send(res, 200, {
        points: game.points,
        remainingMonthly: game.remainingMonthlyRedemptions(),
        catalog: game.getRewardCatalog(),
        redemptions: game.getRedemptions(),
      });
    }

    // 비료 교환 신청
    if (req.method === 'POST' && pathname === '/api/me/redeem') {
      const body = await readJson(req);
      if (!body.rewardId) {
        return send(res, 400, { ok: false, message: 'rewardId가 필요합니다.' });
      }
      const result = game.redeemFertilizer(body.rewardId);
      if (result.ok) store.save();
      return send(res, 200, { ...result, points: game.points });
    }

    // 교환 주문 취소 (발송 전만 가능 · 포인트 자동 환불)
    if (req.method === 'POST' && pathname === '/api/me/redeem/cancel') {
      const body = await readJson(req);
      if (!body.orderId) {
        return send(res, 400, { ok: false, message: 'orderId가 필요합니다.' });
      }
      const result = game.setRedemptionStatus(body.orderId, 'canceled');
      if (result.ok) store.save();
      return send(res, 200, { ...result, points: game.points });
    }

    // ── 할 일 (간단한 개인 투두 · 게임 상태와 함께 저장) ──
    if (pathname === '/api/me/todos' && req.method === 'GET') {
      return send(res, 200, { todos: game.state.todos || [] });
    }
    if (pathname === '/api/me/todos' && req.method === 'POST') {
      const body = await readJson(req);
      const text = String(body.text || '').trim().slice(0, 60);
      if (!text) return send(res, 400, { ok: false, message: '할 일 내용이 필요합니다.' });
      const todos = (game.state.todos ||= []);
      const todo = {
        id: `t${Date.now()}${Math.floor(Math.random() * 1000)}`,
        text,
        done: false,
        createdKey: toDateKey(new Date()),
      };
      todos.push(todo);
      store.save();
      return send(res, 200, { ok: true, todo, todos });
    }
    if (pathname === '/api/me/todos/toggle' && req.method === 'POST') {
      const body = await readJson(req);
      const todos = (game.state.todos ||= []);
      const todo = todos.find((t) => t.id === body.id);
      if (!todo) return send(res, 404, { ok: false, message: '할 일을 찾을 수 없어요.' });
      todo.done = !todo.done;
      store.save();
      return send(res, 200, { ok: true, todo, todos });
    }
    if (pathname === '/api/me/todos/delete' && req.method === 'POST') {
      const body = await readJson(req);
      const todos = (game.state.todos ||= []);
      const idx = todos.findIndex((t) => t.id === body.id);
      if (idx < 0) return send(res, 404, { ok: false, message: '할 일을 찾을 수 없어요.' });
      todos.splice(idx, 1);
      store.save();
      return send(res, 200, { ok: true, todos });
    }

    // ── 다이어리 (하루 한 편 · 그날의 작물 모습을 함께 기록) ──
    if (pathname === '/api/me/diary' && req.method === 'GET') {
      return send(res, 200, { entries: game.state.diary || [] });
    }
    if (pathname === '/api/me/diary' && req.method === 'POST') {
      const body = await readJson(req);
      const text = String(body.text || '').trim().slice(0, 300);
      const diary = (game.state.diary ||= []);
      const dayKey = toDateKey(new Date());
      const existingIdx = diary.findIndex((e) => e.dayKey === dayKey);

      // 빈 내용으로 저장하면 오늘 일기를 지움
      if (!text) {
        if (existingIdx < 0) return send(res, 400, { ok: false, message: '일기 내용이 필요합니다.' });
        diary.splice(existingIdx, 1);
        store.save();
        return send(res, 200, { ok: true, deleted: true, entries: diary, message: '오늘 일기를 지웠어요.' });
      }

      const crop = game.getStatus().currentCrop;
      const entry = {
        dayKey,
        text,
        cropId: crop ? crop.cropId : null,
        stageKey: crop ? crop.stageKey : null,
      };
      if (existingIdx >= 0) diary[existingIdx] = entry;
      else diary.push(entry);
      store.save();
      return send(res, 200, { ok: true, entry, entries: diary });
    }

    return send(res, 404, { error: '없는 경로입니다.', path: pathname });
  } catch (err) {
    // 예기치 못한 오류로 요청이 멈추지 않도록 500으로 응답
    console.error('[server error]', err);
    return send(res, 500, { error: '서버 내부 오류', detail: String(err && err.message || err) });
  }
});

function mobileAnalysisProjection(analysis) {
  return {
    analysisId: analysis?.analysisId ?? null,
    createdAt: analysis?.createdAt ?? null,
    inputSummary: analysis?.inputSummary ?? null,
    growthScore: analysis?.growthScore ?? null,
    environmentCause: analysis?.environmentCause ?? null,
    forecast: analysis?.forecast ?? null,
    actions: analysis?.actions ?? [],
    decision: analysis?.decision ?? null,
  };
}

function suitabilitySummary(analysis) {
  const score = analysis?.growthScore?.score;
  const state = analysis?.growthScore?.state;
  const isSuitable = state === 'READY' && Number.isFinite(score) && score >= 70;
  return {
    isSuitable,
    score: Number.isFinite(score) ? score : null,
    label: isSuitable ? '재배하기 좋은 편이에요' : '먼저 확인할 조건이 있어요',
    reason: analysis?.environmentCause?.causeLabel || '분석 자료를 확인해 주세요',
  };
}

function sendCoreError(res, error, fallbackMessage) {
  const statusCode = error instanceof CoreBackendError ? error.status : 502;
  return send(res, statusCode, {
    ok: false,
    code: error instanceof CoreBackendError ? error.code : 'CORE_BACKEND_ERROR',
    message: error instanceof CoreBackendError ? error.message : fallbackMessage,
  });
}

function locationCandidateProjection(candidates) {
  if (!Array.isArray(candidates)) return [];
  return candidates.slice(0, 8).flatMap((candidate) => {
    const candidateToken = String(candidate?.candidateToken || '').trim();
    const displayName = String(candidate?.displayName || '').trim();
    if (!candidateToken || !displayName) return [];
    return [{ candidateToken, displayName: displayName.slice(0, 160) }];
  });
}

server.listen(PORT, () => {
  console.log(`🌾 백엔드 API 실행 중: http://localhost:${PORT}`);
});

export { server };
