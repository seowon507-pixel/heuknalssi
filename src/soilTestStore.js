// soilTestStore.js
// 유저가 직접 입력한 "내 밭 토양검정 결과지" 값을 보관/영속화합니다.
// 흙날씨 v3 코어 백엔드의 analyze() 요청에 실려가면, 지역 통계 대신
// 실측값으로 분석합니다 (backend-v3/src/domain/request.js의 soilTest 계약).

import fs from 'node:fs';
import path from 'node:path';

const DATA_FILE = path.join(process.cwd(), 'data', 'soil-tests.json');

export class SoilTestStore {
  /** @param {{persist?: boolean}} opts - persist=false면 메모리에만(테스트용) */
  constructor({ persist = true } = {}) {
    this.persist = persist;
    this.entries = new Map(); // userId -> soilTest
    if (persist) this._load();
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const [userId, value] of Object.entries(data || {})) {
        this.entries.set(userId, value);
      }
    } catch {
      // 파일이 없으면 빈 상태로 시작
    }
  }

  _save() {
    if (!this.persist) return;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(Object.fromEntries(this.entries), null, 2));
    } catch {
      // 읽기 전용 파일시스템(예: 서버리스 배포)에서는 저장을 건너뜁니다.
    }
  }

  get(userId) {
    return this.entries.get(userId) ?? null;
  }

  set(userId, soilTest) {
    this.entries.set(userId, soilTest);
    this._save();
  }

  clear(userId) {
    this.entries.delete(userId);
    this._save();
  }
}
