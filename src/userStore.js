// userStore.js
// 유저별 게임 상태를 보관/영속화하는 백엔드 저장소.
// 로그인 기능이 붙으면 userId만 이 저장소에 연결하면 됩니다.
// (지금은 파일(JSON)에 저장 — 실서비스에선 DB로 교체)

import fs from 'node:fs';
import path from 'node:path';
import { FarmGame } from './farmGame.js';
import { createCatalogStock } from './redemption.js';
import { REWARDS } from './config.js';

const DATA_FILE = path.join(process.cwd(), 'data', 'store.json');

// JSON은 Infinity를 저장 못하므로(=null) 불러올 때 되돌립니다.
function normalizeStock(stock) {
  const fixed = createCatalogStock(); // 기본값(설정 재고)으로 채운 뒤
  for (const id of Object.keys(REWARDS)) {
    if (stock && stock[id] != null) fixed[id] = stock[id];
  }
  return fixed;
}

export class UserStore {
  /** @param {{persist?: boolean}} opts - persist=false면 메모리에만(테스트용) */
  constructor({ persist = true } = {}) {
    this.persist = persist;
    this.stock = createCatalogStock(); // 전역 재고 (모든 유저 공유)
    this.games = new Map();            // userId -> FarmGame
    if (persist) this._load();
  }

  _load() {
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

  _save() {
    if (!this.persist) return;
    const users = {};
    for (const [uid, game] of this.games) users[uid] = game.toJSON();
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify({ stock: this.stock, users }, null, 2));
  }

  /** userId에 해당하는 게임을 가져오고, 없으면 새로 만듭니다. (신규 = isFirstTime true) */
  getOrCreate(userId) {
    let game = this.games.get(userId);
    if (!game) {
      game = new FarmGame(null, this.stock);
      this.games.set(userId, game);
    } else {
      game.attachCatalogStock(this.stock); // 공유 재고 재연결
    }
    return game;
  }

  /** 변경 사항을 파일에 저장 */
  save() {
    this._save();
  }
}
