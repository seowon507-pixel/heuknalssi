// test-api.js
// 백엔드 API 흐름 검증. 서버를 실행한 뒤 `node test-api.js` 로 실행합니다.
// (로그인 이후: 처음 시작 → 캐릭터 선택 → 재선택 거부 흐름 확인)

const BASE = process.env.BASE || 'http://localhost:4000';
const log = (...a) => console.log(...a);

async function api(method, path, { userId, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (userId) headers['x-user-id'] = userId;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

// 매 실행마다 새 유저로 테스트 (기존 저장 상태 영향 없이)
const NEW_USER = 'tester-' + (process.argv[2] || Date.now());

(async () => {
  log('─'.repeat(50));
  log('1) 캐릭터 목록 (로그인 불필요)');
  let r = await api('GET', '/api/characters');
  log('  status', r.status, '| 캐릭터:', r.json.characters.map((c) => `${c.emoji}${c.name}`).join(' '));

  log('─'.repeat(50));
  log('2) 로그인 안 하면 온보딩 거부(401)');
  r = await api('GET', '/api/me/onboarding');
  log('  status', r.status, '|', r.json.error);

  log('─'.repeat(50));
  log(`3) 신규 유저(${NEW_USER}) 온보딩 → isFirstTime true 여야 함`);
  r = await api('GET', '/api/me/onboarding', { userId: NEW_USER });
  log('  status', r.status, '| isFirstTime:', r.json.isFirstTime, '| needsSelection:', r.json.needsCharacterSelection, '| current:', r.json.currentCharacter);

  log('─'.repeat(50));
  log('4) 캐릭터 선택 (상추)');
  r = await api('POST', '/api/me/character', { userId: NEW_USER, body: { characterId: 'lettuce' } });
  log('  status', r.status, '|', r.json.message);

  log('─'.repeat(50));
  log('5) 선택 후 온보딩 → isFirstTime false, 현재 캐릭터 표시');
  r = await api('GET', '/api/me/onboarding', { userId: NEW_USER });
  log('  status', r.status, '| isFirstTime:', r.json.isFirstTime, '| current:', r.json.currentCharacter && `${r.json.currentCharacter.emoji}${r.json.currentCharacter.stageName}`);

  log('─'.repeat(50));
  log('6) 키우는 중 또 선택 → 거부(400) 되어야 함');
  r = await api('POST', '/api/me/character', { userId: NEW_USER, body: { characterId: 'apple' } });
  log('  status', r.status, '|', r.json.message);

  log('─'.repeat(50));
  log('7) 없는 캐릭터 선택 → 거부(400)');
  const FRESH = NEW_USER + '-b';
  r = await api('POST', '/api/me/character', { userId: FRESH, body: { characterId: 'banana' } });
  log('  status', r.status, '|', r.json.message);

  log('─'.repeat(50));
  log('✅ API 테스트 종료');
})();
