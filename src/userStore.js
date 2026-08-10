// userStore.js
// 유저별 게임 상태를 보관/영속화하는 백엔드 저장소.
//
// - Supabase 로그인 유저(accessToken 있음): Postgres의 user_games/game_stock 테이블에 저장.
//   RLS가 auth.uid() = user_id로 막혀 있어서, 요청을 보낸 유저 본인의 access token을
//   그대로 실어 보내야 자기 행을 읽고 쓸 수 있습니다.
// - 로그인 전 x-user-id 폴백(accessToken 없음): 실제 Supabase 계정이 없어 위 방식을 못 쓰므로
//   예전처럼 로컬 파일(data/store.json)에 저장합니다. 서버리스 배포에서는 이 폴백 경로만
//   여전히 인스턴스 재시작마다 초기화됩니다.

import fs from 'node:fs';
import path from 'node:path';
import { FarmGame } from './farmGame.js';
import { createCatalogStock } from './redemption.js';
import { REWARDS } from './config.js';

const DATA_FILE = path.join(process.cwd(), 'data', 'store.json');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/u, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

// JSON은 Infinity를 저장 못하므로(=null) 불러올 때 되돌립니다.
function normalizeStock(stock) {
  const fixed = createCatalogStock(); // 기본값(설정 재고)으로 채운 뒤
  for (const id of Object.keys(REWARDS)) {
    if (stock && stock[id] != null) fixed[id] = stock[id];
  }
  return fixed;
}

async function supabaseRest(pathname, accessToken, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${pathname}`, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase 저장소 요청 실패 (${res.status}): ${pathname}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export class UserStore {
  /** @param {{persist?: boolean}} opts - persist=false면 메모리에만(테스트용) */
  constructor({ persist = true } = {}) {
    this.persist = persist;
    this.supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
    this.stock = createCatalogStock(); // 전역 재고 (모든 유저 공유, 비회원 폴백 기본값)
    this.games = new Map();            // 비회원(x-user-id) 전용: userId -> FarmGame
    if (persist) this._loadLocal();
  }

  _loadLocal() {
    try {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      this.stock = normalizeStock(data.stock);
      for (const [uid, state] of Object.entries(data.users || {})) {
        this.games.set(uid, new FarmGame(state, this.stock));
      }
    } catch {
      // 파일이 없으면 빈 상태로 시작
    }
  }

  _saveLocal() {
    if (!this.persist) return;
    const users = {};
    for (const [uid, game] of this.games) users[uid] = game.toJSON();
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify({ stock: this.stock, users }, null, 2));
    } catch {
      // 읽기 전용 파일시스템(예: 서버리스 배포)에서는 저장을 건너뜁니다.
      // 이 경우 진행 상황은 그 요청 처리 동안의 메모리에만 남습니다. (비회원 폴백 한정)
    }
  }

  /**
   * userId(+ 로그인 유저라면 accessToken)에 해당하는 게임을 가져오고, 없으면 새로 만듭니다.
   * (신규 = isFirstTime true)
   */
  async getOrCreate(userId, accessToken = null) {
    if (accessToken && this.supabaseConfigured) {
      const stockRows = await supabaseRest('/game_stock?id=eq.1&select=stock', accessToken);
      this.stock = normalizeStock(stockRows?.[0]?.stock);
      const rows = await supabaseRest(
        `/user_games?user_id=eq.${encodeURIComponent(userId)}&select=state`,
        accessToken,
      );
      const savedState = rows?.[0]?.state && Object.keys(rows[0].state).length ? rows[0].state : null;
      return new FarmGame(savedState, this.stock);
    }
    let game = this.games.get(userId);
    if (!game) {
      game = new FarmGame(null, this.stock);
      this.games.set(userId, game);
    } else {
      game.attachCatalogStock(this.stock); // 공유 재고 재연결
    }
    return game;
  }

  /** 변경 사항을 저장. 로그인 유저는 Supabase에, 비회원은 로컬 파일에 씁니다. */
  async save(userId, game, accessToken = null) {
    if (accessToken && this.supabaseConfigured) {
      const now = new Date().toISOString();
      await supabaseRest('/user_games?on_conflict=user_id', accessToken, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: userId, state: game.toJSON(), updated_at: now }),
      });
      await supabaseRest('/game_stock?id=eq.1', accessToken, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ stock: this.stock, updated_at: now }),
      });
      return;
    }
    this._saveLocal();
  }
}
