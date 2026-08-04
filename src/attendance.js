// attendance.js
// 출석체크 & 포인트 적립 로직. 프론트엔드와 무관한 순수 함수들입니다.

import { POINT_RULES } from './config.js';
import { toDateKey, diffDays } from './dateUtil.js';

/** 출석 상태 초기값을 만듭니다. */
export function createAttendanceState() {
  return {
    lastCheckInKey: null, // 마지막 출석 날짜 'YYYY-MM-DD'
    currentStreak: 0,     // 현재 연속 출석 일수 (= 화면의 "N일차")
    longestStreak: 0,     // 최고 연속 기록
    totalCheckIns: 0,     // 총 출석 횟수(누적)
    history: [],          // 출석한 날짜 문자열 목록
  };
}

/**
 * 이번 출석으로 얻는 포인트를 계산합니다.
 * @param {number} streak - 이번 출석 반영 후의 연속 일수(1부터 시작)
 */
export function calcCheckInPoints(streak) {
  const { base, streakBonusPerDay, streakBonusCapDays, weeklyBonus, weeklyBonusEvery } = POINT_RULES;

  // 연속 보너스: (streak-1) 일만큼 붙되, 상한선까지만 증가
  const bonusDays = Math.min(Math.max(streak - 1, 0), streakBonusCapDays - 1);
  let points = base + bonusDays * streakBonusPerDay;

  // 주간 보너스: 연속 7일마다 한 번씩
  const weeklyBonusEarned = streak > 0 && streak % weeklyBonusEvery === 0;
  if (weeklyBonusEarned) points += weeklyBonus;

  return { points, weeklyBonusEarned };
}

/**
 * 출석체크를 수행합니다. (상태를 직접 변경하지 않고 결과를 돌려줍니다)
 * @param {object} state - createAttendanceState()로 만든 출석 상태
 * @param {Date|string} when - 출석 시각(Date) 또는 'YYYY-MM-DD' 키. 생략 시 오늘.
 * @returns {{
 *   ok: boolean, alreadyCheckedIn: boolean, streakReset: boolean,
 *   dayKey: string, streak: number, earnedPoints: number,
 *   weeklyBonusEarned: boolean, message: string
 * }}
 */
export function checkIn(state, when = new Date()) {
  const dayKey = typeof when === 'string' ? when : toDateKey(when);

  // 같은 날 중복 출석 방지
  if (state.lastCheckInKey === dayKey) {
    return {
      ok: false,
      alreadyCheckedIn: true,
      streakReset: false,
      dayKey,
      streak: state.currentStreak,
      earnedPoints: 0,
      weeklyBonusEarned: false,
      message: '오늘은 이미 출석했어요.',
    };
  }

  // 연속 여부 판정
  let streakReset = false;
  if (state.lastCheckInKey === null) {
    state.currentStreak = 1; // 첫 출석
  } else {
    const gap = diffDays(state.lastCheckInKey, dayKey);
    if (gap < 0) {
      // 마지막 출석일보다 과거 날짜 → 데이터 이상. 상태를 바꾸지 않고 거부.
      return {
        ok: false,
        alreadyCheckedIn: false,
        invalidDate: true,
        streakReset: false,
        dayKey,
        streak: state.currentStreak,
        earnedPoints: 0,
        weeklyBonusEarned: false,
        message: '과거 날짜로는 출석할 수 없어요.',
      };
    }
    if (gap === 1) {
      state.currentStreak += 1; // 어제 → 오늘: 연속 유지
    } else {
      state.currentStreak = 1;  // 하루 이상 건너뜀: 연속 초기화
      streakReset = true;
    }
  }

  // 상태 갱신
  state.lastCheckInKey = dayKey;
  state.totalCheckIns += 1;
  state.longestStreak = Math.max(state.longestStreak, state.currentStreak);
  state.history.push(dayKey);

  // 포인트 계산 (연속이 끊긴 날은 설정에 따라 포인트 없음)
  let points, weeklyBonusEarned;
  if (streakReset && POINT_RULES.noPointsOnStreakReset) {
    points = 0;
    weeklyBonusEarned = false;
  } else {
    ({ points, weeklyBonusEarned } = calcCheckInPoints(state.currentStreak));
  }

  const message =
    streakReset && points === 0
      ? `출석 체크! 하지만 연속이 끊겨 포인트가 없어요. (다시 1일차)`
      : `${state.currentStreak}일차 출석 완료! +${points}P`;

  return {
    ok: true,
    alreadyCheckedIn: false,
    streakReset,
    dayKey,
    streak: state.currentStreak,
    earnedPoints: points,
    weeklyBonusEarned,
    message,
  };
}

/** 오늘 출석했는지 여부 */
export function hasCheckedInToday(state, when = new Date()) {
  const dayKey = typeof when === 'string' ? when : toDateKey(when);
  return state.lastCheckInKey === dayKey;
}
