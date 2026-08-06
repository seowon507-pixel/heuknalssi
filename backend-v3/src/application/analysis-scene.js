import { buildEnvironmentScene } from '../domain/index.js';

/**
 * 분석 결과에 붙일 대시보드 원형 장면을 만든다. 명세 28번 10절 계약이다.
 *
 * 이 파일이 지키는 선:
 *
 * - **장면은 이미 검증된 백엔드 판정만 읽는다.** 예보 위험, 위험 상태,
 *   주요 행동 문구를 그대로 넘기고 온도·강수를 다시 판정하지 않는다.
 *   그래서 큰 상태 문구와 원형 장면이 어긋날 수 없다.
 * - **장면이 실패해도 분석은 실패하지 않는다.** 명세 11절이 요구하는
 *   조건이다. 장면 생성이 던지면 `state: 'UNAVAILABLE'` 만 남기고 분석은
 *   그대로 반환한다.
 * - **생육단계를 날짜나 날씨로 추측하지 않는다.** 요청에 검수된 단계가
 *   없으면 단계를 비우고 화면이 `단계 설정` 을 띄우게 한다.
 */

/**
 * 검수 규칙 저장소가 쓰는 생육단계 문자열을 명세 3절의 공통 5단계로 옮기는 표.
 * 표에 없는 값은 추측하지 않는다.
 */
const STAGE_NUMBER_BY_REVIEWED_STAGE = Object.freeze({
  FLOWERING: 4,
  TUBER_BULKING: 4,
  FLOWER_DIFFERENTIATION: 4,
});

/**
 * 오늘 날짜의 예보 하루치를 고른다. 없으면 null 이고 장면은 위험만으로
 * 결정된다. 가까운 날짜로 대체하지 않는다.
 */
export function selectTodayForecastDay(forecast, todayIso) {
  const days = forecast?.result?.days;
  if (!Array.isArray(days)) return null;
  const today = String(todayIso ?? '').slice(0, 10);
  if (today.length !== 10) return null;
  return days.find((day) => day?.date === today) ?? null;
}

/** 요청에 담긴 검수된 생육단계만 5단계 번호로 옮긴다. */
export function projectRequestStage(growthStage) {
  const stage = STAGE_NUMBER_BY_REVIEWED_STAGE[growthStage];
  if (stage === undefined) {
    return { stage: null, source: 'UNKNOWN' };
  }
  return { stage, source: 'USER_CONFIRMED' };
}

/**
 * @param {object} input
 * @param {object} input.request        검증된 분석 요청
 * @param {object} input.forecast       evaluateForecast 결과 모듈
 * @param {string} input.riskState      백엔드 위험 상태
 * @param {object} [input.decision]     결정 메시지 (원인 문구로만 사용)
 * @param {object} [input.primaryAction] 표시용 주요 행동 (제목 문구로만 사용)
 * @param {string} input.todayIso       서버 기준 오늘 (clock 에서 온 값)
 */
export function projectAnalysisScene({
  request,
  forecast,
  riskState,
  decision = null,
  primaryAction = null,
  todayIso,
}) {
  try {
    return buildEnvironmentScene({
      cropId: request?.crop,
      stage: projectRequestStage(request?.growthStage),
      forecastRisks: forecast?.result?.risks ?? [],
      todayForecast: selectTodayForecastDay(forecast, todayIso),
      riskState: riskState ?? null,
      // 원인·행동 문구는 백엔드가 이미 확정한 문장을 그대로 넘긴다.
      primaryCause: decision?.message ? { summaryKo: decision.message } : null,
      primaryAction: primaryAction?.title ? { titleKo: primaryAction.title } : null,
    });
  } catch (error) {
    // 장면 하나 때문에 오늘의 행동과 출석을 못 쓰게 만들지 않는다.
    return Object.freeze({
      state: 'UNAVAILABLE',
      reason: error?.code ?? 'SCENE_PROJECTION_FAILED',
    });
  }
}
