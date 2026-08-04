// farmGame.js
// 출석 + 포인트 + 작물 성장 + 비료 교환을 하나로 묶는 메인 엔진.
// 프론트엔드는 이 클래스의 메서드만 호출하면 됩니다. (UI 코드 없음)
//
// 흐름:
//   1) selectCrop()으로 키울 작물 하나 선택
//   2) 매일 checkIn() → 포인트 적립 + (연속 출석 시) 현재 작물 성장
//   3) 작물이 다 자라면(matured) 완료 목록에 넣고 selectCrop()으로 다음 작물 선택
//   4) 모은 포인트로 redeemFertilizer() → 실물 비료 교환 신청 (성장과 무관)

import { CROPS, CROP_IDS, REWARDS, REDEMPTION_RULES } from './config.js';
import { createAttendanceState, checkIn, hasCheckedInToday } from './attendance.js';
import { createCropState, addGrowth, getGrowthProgress, growthForStreak } from './growth.js';
import { createRedemptionLog, redeem, updateOrderStatus, countRedemptionsInMonth } from './redemption.js';
import { toDateKey } from './dateUtil.js';

export class FarmGame {
  /**
   * @param {object|null} savedState - 이전에 toJSON()으로 저장한 상태 (없으면 새 게임)
   * @param {object|null} catalogStock - createCatalogStock()로 만든 전역 재고(선택). 여러 사용자가 공유.
   *   저장되지 않는 전역 값이므로, 불러오기 후에는 attachCatalogStock()으로 다시 연결하세요.
   */
  constructor(savedState = null, catalogStock = null) {
    this.catalogStock = catalogStock; // 전역 재고 참조 (없으면 재고 무제한)
    if (savedState) {
      this.state = savedState;
      // 예전 저장 형식(단일 currentCrop)을 다중 작물(crops 배열)로 마이그레이션
      if (!Array.isArray(this.state.crops)) {
        this.state.crops = this.state.currentCrop ? [this.state.currentCrop] : [];
        delete this.state.currentCrop;
      }
    } else {
      this.state = {
        points: 0,
        attendance: createAttendanceState(),
        redemptions: createRedemptionLog(), // 실물 비료 교환 주문 기록
        crops: [],               // 지금 키우는 작물들 (createCropState 형태, 종류별 1개 · 최대 5종)
        completedCrops: [],      // 다 키운(수확한) 작물 기록 [{ cropId, finishedKey }]
      };
    }
  }

  // ── 저장/복원 ────────────────────────────────
  /** 직렬화(로컬스토리지/DB에 저장). JSON.stringify 가능 */
  toJSON() {
    return this.state;
  }
  static fromJSON(saved, catalogStock = null) {
    return new FarmGame(saved, catalogStock);
  }

  /** 전역 재고를 연결/교체합니다. (불러오기 후 재연결용) */
  attachCatalogStock(catalogStock) {
    this.catalogStock = catalogStock;
  }

  // ── 조회 ────────────────────────────────────
  get points() {
    return this.state.points;
  }

  /** 화면에 그릴 전체 요약 정보 */
  getStatus() {
    const s = this.state;
    return {
      points: s.points,
      streak: s.attendance.currentStreak,
      longestStreak: s.attendance.longestStreak,
      totalCheckIns: s.attendance.totalCheckIns,
      checkedInToday: hasCheckedInToday(s.attendance),
      attendanceHistory: s.attendance.history.slice(-90), // 달력/주간 표시용 최근 출석 날짜
      lastCheckInKey: s.attendance.lastCheckInKey,
      crops: s.crops.map((c) => getGrowthProgress(c)),     // 키우는 작물 전체
      currentCrop: s.crops.length ? getGrowthProgress(s.crops[0]) : null, // 구버전 호환용
      needsNewCrop: this.needsNewCrop(),
      completedCount: s.completedCrops.length,
      completedCrops: [...s.completedCrops],
      redemptions: [...s.redemptions], // 교환 주문 내역
    };
  }

  /** 선택 가능한 캐릭터(작물) 5종 목록. 로그인/유저와 무관한 정적 데이터. */
  static getCharacters() {
    return CROP_IDS.map((id) => ({ id, name: CROPS[id].name, emoji: CROPS[id].emoji }));
  }

  /** 선택 가능한 작물 목록 (인스턴스 편의용) */
  getSelectableCrops() {
    return FarmGame.getCharacters();
  }

  /**
   * 앱을 "처음 시작"하는 유저인지 (= 아직 작물을 한 번도 고르지 않음).
   * 로그인 직후 이 값이 true면 작물 선택 화면을 띄우면 됩니다.
   */
  isFirstTime() {
    return this.state.crops.length === 0 && this.state.completedCrops.length === 0;
  }

  /** 지금 작물을 골라야 하는 상태인지 (키우는 작물이 하나도 없음) */
  needsCharacterSelection() {
    return this.needsNewCrop();
  }

  /** 이번 달 남은 교환 가능 횟수 */
  remainingMonthlyRedemptions(when = new Date()) {
    const dayKey = when instanceof Date ? toDateKey(when) : when;
    const used = countRedemptionsInMonth(this.state.redemptions, dayKey);
    return Math.max(REDEMPTION_RULES.monthlyLimitPerUser - used, 0);
  }

  /** 비료 교환 카탈로그 (가격·재고·교환가능 여부 포함) */
  getRewardCatalog() {
    const stock = this.catalogStock;
    return Object.values(REWARDS).map((r) => {
      const remainingStock = stock ? (stock[r.id] ?? Infinity) : Infinity;
      return {
        id: r.id,
        name: r.name,
        emoji: r.emoji,
        realItem: r.realItem,
        pointCost: r.pointCost,
        remainingStock,
        soldOut: remainingStock < 1,
        affordable: this.state.points >= r.pointCost,
      };
    });
  }

  /** 새 작물을 골라야 하는 상태인지 (키우는 작물이 하나도 없음) */
  needsNewCrop() {
    return this.state.crops.length === 0;
  }

  // ── 1) 작물 선택 ─────────────────────────────
  /**
   * 키울 작물을 하나 추가합니다. (여러 종류 동시 재배 가능, 같은 종류는 1개씩)
   */
  selectCrop(cropId, when = new Date()) {
    const crop = CROPS[cropId];
    if (!crop) {
      return { ok: false, message: `없는 작물입니다: ${cropId}` };
    }
    if (this.state.crops.some((c) => c.cropId === cropId)) {
      return { ok: false, message: `${crop.name}는 이미 키우고 있어요.` };
    }
    if (this.state.crops.length >= CROP_IDS.length) {
      return { ok: false, message: '밭이 가득 찼어요. 수확한 뒤 새로 심을 수 있어요.' };
    }

    const cropState = createCropState(cropId);
    cropState.startedKey = typeof when === 'string' ? when : toDateKey(when);
    this.state.crops.push(cropState);

    return {
      ok: true,
      message: `${crop.emoji} ${crop.name} 씨앗을 심었어요! 매일 돌봐주세요.`,
      progress: getGrowthProgress(cropState),
    };
  }

  /**
   * 다 자란 작물을 수확해 완료 기록으로 옮깁니다.
   */
  harvestCrop(cropId, when = new Date()) {
    const idx = this.state.crops.findIndex((c) => c.cropId === cropId);
    if (idx < 0) {
      return { ok: false, message: '키우고 있지 않은 작물이에요.' };
    }
    const crop = this.state.crops[idx];
    if (!crop.matured) {
      return { ok: false, message: '아직 다 자라지 않았어요. 조금만 더 돌봐주세요.' };
    }
    const dayKey = typeof when === 'string' ? when : toDateKey(when);
    this.state.completedCrops.push({
      cropId,
      finishedKey: crop.finishedKey || dayKey,
    });
    this.state.crops.splice(idx, 1);
    const info = CROPS[cropId];
    return { ok: true, message: `${info.emoji} ${info.name} 수확 완료! 기록에 고이 남았어요.` };
  }

  // ── 2) 출석체크 ─────────────────────────────
  /**
   * 하루 출석. 성공 시 포인트를 적립하고, 연속 출석 중이면 현재 작물을 성장시킵니다.
   * (연속이 끊긴 날은 포인트 0 & 성장 0)
   * @param {Date|string} when - 출석 시각 또는 'YYYY-MM-DD'. 생략 시 오늘.
   */
  checkIn(when = new Date()) {
    const result = checkIn(this.state.attendance, when);

    if (!result.ok) {
      return { ...result, growth: null, cropMatured: false };
    }

    // 포인트 적립
    this.state.points += result.earnedPoints;

    // 키우는 작물 전체 성장 (연속 출석해야만 자라고, 연속이 길수록 성장치가 커짐)
    const growthAmount = growthForStreak(result.streak, result.streakReset);
    const grown = [];
    let cropMatured = false;
    for (const crop of this.state.crops) {
      if (crop.matured) continue;
      const g = addGrowth(crop, growthAmount);
      if (g.justMatured) {
        cropMatured = true;
        crop.finishedKey = result.dayKey;
      }
      grown.push(g);
    }

    // 안내 메시지에 성장 상황 덧붙이기 (실제로 성장이 적용됐을 때만)
    let growthNote = '';
    if (grown.length) {
      if (growthAmount === 0) growthNote = ' (연속이 끊겨 작물은 자라지 않았어요)';
      else growthNote = ` (성장 +${growthAmount})`;
    }
    if (cropMatured) growthNote += ' 다 자란 작물이 있어요!';

    return {
      ...result,
      message: result.message + growthNote,
      growthAmount,
      pointsTotal: this.state.points,
      growth: grown,
      cropMatured,
      needsNewCrop: this.needsNewCrop(),
    };
  }

  // ── 3) 실물 비료 교환 ────────────────────────
  /**
   * 모은 포인트로 실물 비료를 교환 신청합니다. (성장과 무관)
   * @param {string} rewardId - 'organic_small' | 'compound_mid' | 'bulk_large'
   */
  redeemFertilizer(rewardId, when = new Date()) {
    const res = redeem(this.state.points, this.state.redemptions, rewardId, when, this.catalogStock);
    if (res.ok) this.state.points = res.remainingPoints;
    return res;
  }

  /**
   * 교환 주문 상태를 변경합니다. (승인/발송/완료/취소)
   * 취소 시 차감했던 포인트를 자동 환불합니다.
   */
  setRedemptionStatus(orderId, status) {
    const res = updateOrderStatus(this.state.redemptions, orderId, status, this.catalogStock);
    if (res.ok && res.refundPoints > 0) {
      this.state.points += res.refundPoints; // 취소 환불 (재고는 updateOrderStatus가 복원)
    }
    return res;
  }

  /** 교환 주문 내역 조회 */
  getRedemptions() {
    return [...this.state.redemptions];
  }
}
