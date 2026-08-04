// growth.js
// 작물 캐릭터의 성장 단계 로직.
// 성장치(growth)가 쌓이면 씨앗 → ... → 다 큰 작물로 단계가 올라갑니다.

import { CROPS, GROWTH_RULES } from './config.js';

/**
 * 이번 출석으로 작물이 얻을 성장치를 계산합니다.
 * 연속 출석해야만 자라고(끊긴 날은 0), 연속이 길수록 성장치가 커집니다.
 * @param {number} streak - 이번 출석 반영 후 연속 일수 (1부터)
 * @param {boolean} wasReset - 이번 출석에서 연속이 끊겼는지(하루 이상 결석 후 출석)
 * @returns {number} 더할 성장치 (0 이상)
 */
export function growthForStreak(streak, wasReset = false) {
  const { base, perStreakDay, cap, growOnStreakResetDay } = GROWTH_RULES;
  if (wasReset && !growOnStreakResetDay) return 0; // 연속이 끊긴 날엔 자라지 않음
  const amount = base + Math.max(streak - 1, 0) * perStreakDay;
  return Math.min(amount, cap);
}

/**
 * 특정 작물을 새로 심을 때의 성장 상태를 만듭니다.
 * @param {string} cropId - 'lettuce' | 'cucumber' | 'potato' | 'apple' | 'pear'
 */
export function createCropState(cropId) {
  if (!CROPS[cropId]) {
    throw new Error(`알 수 없는 작물입니다: ${cropId}`);
  }
  return {
    cropId,
    growth: 0,        // 누적 성장치
    stageIndex: 0,    // 현재 단계 인덱스 (0 = 씨앗)
    startedKey: null, // 심은 날짜(선택적으로 기록)
    matured: false,   // 다 자랐는지
  };
}

/** 누적 성장치로부터 현재 단계 인덱스를 계산합니다. */
export function stageIndexForGrowth(cropId, growth) {
  const stages = CROPS[cropId].stages;
  let idx = 0;
  for (let i = 0; i < stages.length; i++) {
    if (growth >= stages[i].daysRequired) idx = i;
    else break;
  }
  return idx;
}

/** 다 자라기까지 필요한 총 성장치(마지막 단계 요구치) */
export function totalGrowthRequired(cropId) {
  const stages = CROPS[cropId].stages;
  return stages[stages.length - 1].daysRequired;
}

/**
 * 성장치를 더해 단계를 갱신합니다. (cropState를 직접 변경)
 * @param {object} cropState - createCropState()로 만든 상태
 * @param {number} amount - 더할 성장치 (기본 1 = 출석 1회)
 * @returns {{
 *   cropId: string, added: number, growth: number,
 *   prevStageIndex: number, stageIndex: number, stageChanged: boolean,
 *   justMatured: boolean, stage: object, progress: object
 * }}
 */
export function addGrowth(cropState, amount = 1) {
  const { cropId } = cropState;
  const stages = CROPS[cropId].stages;
  const maxGrowth = totalGrowthRequired(cropId);

  const prevStageIndex = cropState.stageIndex;

  // 다 자란 뒤에는 성장치가 더 쌓이지 않도록 상한 처리
  cropState.growth = Math.min(cropState.growth + amount, maxGrowth);
  cropState.stageIndex = stageIndexForGrowth(cropId, cropState.growth);

  const wasMatured = cropState.matured;
  cropState.matured = cropState.stageIndex === stages.length - 1;
  const justMatured = cropState.matured && !wasMatured;

  return {
    cropId,
    added: amount,
    growth: cropState.growth,
    prevStageIndex,
    stageIndex: cropState.stageIndex,
    stageChanged: cropState.stageIndex !== prevStageIndex,
    justMatured,
    stage: stages[cropState.stageIndex],
    progress: getGrowthProgress(cropState),
  };
}

/**
 * 현재 성장 진행 상황을 사람이 읽기 좋은 형태로 돌려줍니다.
 * (프론트에서 진행바/다음 단계 안내 등에 사용)
 */
export function getGrowthProgress(cropState) {
  const { cropId, growth, stageIndex } = cropState;
  const crop = CROPS[cropId];
  const stages = crop.stages;
  const maxGrowth = totalGrowthRequired(cropId);
  const isLast = stageIndex >= stages.length - 1;
  const nextStage = isLast ? null : stages[stageIndex + 1];

  return {
    cropId,
    cropName: crop.name,
    emoji: crop.emoji,
    stageIndex,
    stageKey: stages[stageIndex].key,
    stageName: stages[stageIndex].name,
    stageCount: stages.length,
    stages: stages.map((s) => ({ key: s.key, name: s.name })), // 단계 스테퍼 표시용
    startedKey: cropState.startedKey || null,                  // "태어난 지 N일째" 계산용
    matured: isLast,
    growth,
    totalRequired: maxGrowth,
    // 전체 성장 진행률 0~1
    overallRatio: maxGrowth === 0 ? 1 : growth / maxGrowth,
    // 다음 단계 정보
    nextStageName: nextStage ? nextStage.name : null,
    growthToNextStage: nextStage ? Math.max(nextStage.daysRequired - growth, 0) : 0,
  };
}
