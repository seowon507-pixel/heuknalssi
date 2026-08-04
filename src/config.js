// config.js
// 게임 밸런스 설정을 한곳에 모아둡니다. 숫자만 바꾸면 난이도/보상이 조정됩니다.

// ─────────────────────────────────────────────
// 1) 출석체크 포인트 규칙
// ─────────────────────────────────────────────
export const POINT_RULES = {
  base: 10,                   // 출석 1회 기본 포인트
  streakBonusPerDay: 2,       // 연속 출석 하루당 추가 포인트 (2일차=+2, 3일차=+4 ...)
  streakBonusCapDays: 7,      // 연속 보너스는 최대 이 일수까지만 증가 (그 이상은 고정)
  weeklyBonus: 50,            // 연속 7일 달성할 때마다 지급되는 보너스
  weeklyBonusEvery: 7,        // 며칠마다 주간 보너스를 줄지
  noPointsOnStreakReset: true, // 결석 후 출석(연속 끊긴 날)엔 포인트를 주지 않음
};

// ─────────────────────────────────────────────
// 1-2) 성장 규칙 (연속 출석해야만 자라고, 연속이 길수록 빨리 자람)
//   - 연속 출석 중: 성장치 = base + (연속일수-1) * perStreakDay, 단 cap 이내
//   - 연속이 끊긴 날: growOnStreakResetDay=false 면 자라지 않음(+0)
// ─────────────────────────────────────────────
// 연속 성장치: min(streak, cap) → 1,2,3,3,3,3,3 ...
// 누적: 1,3,6,9,12,15,18 (완벽 연속 시 7일차에 18 도달)
// → 모든 작물의 마지막 단계 요구치를 18로 맞춰 "7일에 완성"이 되게 했습니다.
export const GROWTH_RULES = {
  base: 1,                     // 연속 1일차에 얻는 성장치
  perStreakDay: 1,             // 연속 하루 늘 때마다 추가되는 성장치
  cap: 3,                      // 한 번 출석으로 얻는 최대 성장치
  growOnStreakResetDay: false, // 연속이 끊긴 날엔 자라지 않음
};

// ─────────────────────────────────────────────
// 2) 작물(캐릭터) 성장 단계 정의
//    daysRequired = 그 단계에 도달하기 위해 필요한 "누적 성장치"
//    성장치는 출석 1회당 +1, 비료 사용 시 추가로 붙습니다.
// ─────────────────────────────────────────────
export const CROPS = {
  lettuce: {
    id: 'lettuce',
    name: '상추',
    emoji: '🥬',
    stages: [
      { key: 'seed',    name: '상추 씨앗',     daysRequired: 0 },
      { key: 'sprout',  name: '상추 새싹',     daysRequired: 3 },
      { key: 'growing', name: '자라는 상추',   daysRequired: 9 },
      { key: 'mature',  name: '듬직한 상추',   daysRequired: 18 },
    ],
  },
  cucumber: {
    id: 'cucumber',
    name: '오이',
    emoji: '🥒',
    stages: [
      { key: 'seed',     name: '오이 씨앗',      daysRequired: 0 },
      { key: 'sprout',   name: '오이 새싹',      daysRequired: 3 },
      { key: 'seedling', name: '어린 오이',      daysRequired: 6 },
      { key: 'flower',   name: '오이꽃',         daysRequired: 9 },
      { key: 'fruit',    name: '열매 맺은 오이', daysRequired: 12 },
      { key: 'mature',   name: '듬직한 오이',    daysRequired: 18 },
    ],
  },
  potato: {
    id: 'potato',
    name: '감자',
    emoji: '🥔',
    stages: [
      { key: 'seed',    name: '씨감자',        daysRequired: 0 },
      { key: 'sprout',  name: '감자 싹',       daysRequired: 3 },
      { key: 'leafing', name: '잎 자라는 감자', daysRequired: 6 },
      { key: 'bulking', name: '알 굵는 감자',  daysRequired: 12 },
      { key: 'mature',  name: '듬직한 감자',   daysRequired: 18 },
    ],
  },
  apple: {
    id: 'apple',
    name: '사과',
    emoji: '🍎',
    stages: [
      { key: 'sapling', name: '사과 묘목',       daysRequired: 0 },
      { key: 'young',   name: '어린 사과나무',   daysRequired: 3 },
      { key: 'grown',   name: '사과 성목',       daysRequired: 6 },
      { key: 'blossom', name: '사과꽃',          daysRequired: 9 },
      { key: 'fruit',   name: '열매 맺은 사과',  daysRequired: 12 },
      { key: 'mature',  name: '듬직한 사과나무', daysRequired: 18 },
    ],
  },
  pear: {
    id: 'pear',
    name: '배',
    emoji: '🍐',
    stages: [
      { key: 'sapling', name: '배 묘목',        daysRequired: 0 },
      { key: 'young',   name: '어린 배나무',    daysRequired: 3 },
      { key: 'grown',   name: '배 성목',        daysRequired: 6 },
      { key: 'blossom', name: '배꽃',           daysRequired: 9 },
      { key: 'fruit',   name: '열매 맺은 배',   daysRequired: 12 },
      { key: 'mature',  name: '듬직한 배나무',  daysRequired: 18 },
    ],
  },
};

// 선택 가능한 작물 id 목록
export const CROP_IDS = Object.keys(CROPS);

// ─────────────────────────────────────────────
// 3) 비료 교환(리딤) 카탈로그  ※ 실물 비료로 교환하는 보상 목록
//    캐릭터 성장과는 무관하며, 모은 포인트로 실제 비료를 신청합니다.
//    pointCost = 교환에 필요한 포인트
//    가격 기준: 꾸준히 출석 시 약 200P/주 → "노력 기간"으로 환산해 책정
// ─────────────────────────────────────────────
//    stock = 전체 재고(선착순 한정 수량). 여러 사용자가 함께 소진하는 "전역" 값.
export const REWARDS = {
  organic_small: {
    id: 'organic_small',
    name: '유기질 비료 (소포장)',
    emoji: '🌱',
    realItem: '유기질 비료 1kg',
    pointCost: 400,   // 약 2주
    stock: 100,       // 초기 재고
  },
  compound_mid: {
    id: 'compound_mid',
    name: '복합 비료 (중포장)',
    emoji: '🪴',
    realItem: '복합 비료 5kg',
    pointCost: 600,   // 약 3주
    stock: 50,
  },
  bulk_large: {
    id: 'bulk_large',
    name: '대용량 비료',
    emoji: '🚜',
    realItem: '20kg 비료 한 포',
    pointCost: 1000,  // 약 5주
    stock: 20,
  },
};

export const REWARD_IDS = Object.keys(REWARDS);

// ─────────────────────────────────────────────
// 4) 교환 제한 규칙
// ─────────────────────────────────────────────
export const REDEMPTION_RULES = {
  monthlyLimitPerUser: 2, // 한 사용자가 한 달에 교환할 수 있는 최대 횟수
};
