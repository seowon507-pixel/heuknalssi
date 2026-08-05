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

const TITLE_LEVELS = Object.freeze([
  Object.freeze({ key: 'seed', name: '씨앗', requiredCheckIns: 0, borderName: '씨앗 테두리' }),
  Object.freeze({ key: 'sprout', name: '새싹', requiredCheckIns: 3, borderName: '새싹 테두리' }),
  Object.freeze({ key: 'sapling', name: '어린 나무', requiredCheckIns: 7, borderName: '나뭇잎 테두리' }),
  Object.freeze({ key: 'tree', name: '튼튼한 나무', requiredCheckIns: 14, borderName: '나무 테두리' }),
  Object.freeze({ key: 'grove', name: '작은 숲', requiredCheckIns: 30, borderName: '숲 테두리' }),
  Object.freeze({ key: 'worldtree', name: '세계수', requiredCheckIns: 60, borderName: '세계수 테두리' }),
]);

function defaultProfile() {
  return {
    displayName: '',
    onboardingComplete: false,
    usageMode: null,
    region: '',
    address: '',
    cultivationMode: 'OPEN_FIELD',
    notificationsEnabled: false,
    selectedTitleKey: 'seed',
    selectedBorderKey: 'seed',
  };
}

function signalEvidence(analysis, overrides = {}) {
  const environment = analysis?.environmentCause || {};
  const weather = environment.weather || {};
  const soil = environment.soil || {};
  const daily = Array.isArray(weather.daily) ? weather.daily : [];
  const linkedDate = overrides.linkedDate || null;
  const axisIsSoil = overrides.axis && overrides.axis === soil;
  const matchingDay = overrides.matchingDay
    || (!axisIsSoil && daily.find((day) => day?.date === linkedDate))
    || (!axisIsSoil && daily.find((day) => day?.status === 'DANGER' || day?.status === 'CAUTION'))
    || null;
  const axis = overrides.axis
    || (soil.status === 'DANGER' || (soil.status === 'CAUTION' && weather.status !== 'DANGER')
      ? soil
      : weather);
  const cropId = String(analysis?.inputSummary?.crop || '').toLowerCase();

  return {
    cropId: cropId || null,
    cropName: CROPS[cropId]?.name || null,
    dateKey: linkedDate || matchingDay?.date || String(analysis?.createdAt || '').slice(0, 10) || null,
    untilKey: overrides.untilKey || null,
    status: matchingDay?.status || axis.status || environment.status || 'CAUTION',
    statusLabel: matchingDay?.statusLabel || axis.statusLabel || environment.statusLabel || '주의',
    axis: axisIsSoil ? 'soil' : 'weather',
    causeCode: matchingDay?.code || axis.code || null,
    causeLabel: matchingDay?.label || axis.label || environment.causeLabel || '환경 변화',
    reason: overrides.reason || null,
    recheck: overrides.recheck || null,
  };
}

function fallbackReason(code, cropName = '작물') {
  const reasons = {
    HIGH_TEMPERATURE: `예보 기온이 ${cropName}의 고온 기준을 넘어 잎·꽃·과실이 스트레스를 받을 수 있어요.`,
    EXTREME_HEAT: `폭염 수준의 고온이 예상되어 ${cropName}의 수분 손실과 햇볕 피해 위험이 커져요.`,
    LOW_TEMPERATURE: `예보 기온이 ${cropName}의 저온 기준보다 낮아 생육이 느려지거나 냉해가 생길 수 있어요.`,
    FROST: `영하 또는 서리 조건이 예상되어 ${cropName}의 어린 조직이 손상될 수 있어요.`,
    RAIN: `비 예보로 토양 수분과 배수 상태가 빠르게 달라질 수 있어요.`,
    HEAVY_RAIN: `많은 비가 예상되어 뿌리 과습과 침수 피해 위험이 커져요.`,
    STRONG_WIND: `강한 바람이 예상되어 작물과 지주·시설이 흔들리거나 쓰러질 수 있어요.`,
    TYPHOON: `태풍 영향이 예상되어 작물 쓰러짐과 시설·배수 피해 위험이 커요.`,
    DROUGHT: `비가 부족한 기간이 이어져 ${cropName}의 수분 스트레스 위험이 커져요.`,
    SOIL_DRY: `토양 수분이 부족해 ${cropName}의 생육과 양분 흡수가 떨어질 수 있어요.`,
    SOIL_WET: `토양 수분이 많아 뿌리 호흡과 양분 흡수가 어려워질 수 있어요.`,
    POOR_DRAINAGE: `물이 빠지는 속도가 느려 뿌리 주변에 물이 오래 머물 수 있어요.`,
    PH_IMBALANCE: `토양 산도가 ${cropName}의 적정 범위와 달라 양분 흡수가 불안정해질 수 있어요.`,
    SALINITY_HIGH: `토양 염류가 높아 ${cropName}의 물과 양분 흡수가 방해될 수 있어요.`,
    TEXTURE_CAUTION: `토성이 ${cropName} 재배에 불리해 물 빠짐과 수분 유지가 어려울 수 있어요.`,
    FLOODING: `침수 수준의 물이 예상되어 뿌리와 지상부 피해 위험이 커요.`,
  };
  return reasons[code] || `${cropName}의 작물 기준에서 확인이 필요한 환경 신호가 나타났어요.`;
}

function preventiveTodoSemanticKey(todo) {
  if (todo?.source !== 'ENVIRONMENT_ANALYSIS') return null;
  const sourceMatch = String(todo.sourceKey || '').match(
    /^environment:(\d{4}-\d{2}-\d{2}):([^:]+):/u,
  );
  // 구버전 할 일은 원인 날짜를 따로 저장하지 않아 UTC 분석일이 sourceKey에
  // 들어갔습니다. 이때는 사용자가 본 생성일을 우선해 같은 국내 날짜의 중복을 합칩니다.
  const signalDate = todo.evidence?.dateKey || todo.createdKey || sourceMatch?.[1] || '';
  const cropId = String(todo.cropId || sourceMatch?.[2] || 'crop').toLowerCase();
  const text = String(todo.text || '').trim().replace(/\s+/gu, ' ');
  return `${signalDate}:${cropId}:${text}`;
}

const LOW_VALUE_PREVENTIVE_PATTERNS = Object.freeze([
  /농업기술센터/u,
  /다시\s*분석/u,
  /작기.*확인/u,
  /시기인지/u,
  /근거.*확인|확인.*근거/u,
  /가까운\s*기상위험|기상위험.*확인/u,
]);

function isEssentialPreventiveTodo(todo) {
  if (todo?.source !== 'ENVIRONMENT_ANALYSIS') return true;
  const text = String(todo.text || '').trim();
  return text.length > 0 && !LOW_VALUE_PREVENTIVE_PATTERNS.some((pattern) => pattern.test(text));
}

function uniqueTodos(todos) {
  const seen = new Set();
  const groupCounts = new Map();
  return todos.filter((todo) => {
    if (!isEssentialPreventiveTodo(todo)) return false;
    const key = preventiveTodoSemanticKey(todo);
    if (!key) return true;
    if (seen.has(key)) return false;
    const [signalDate, cropId] = key.split(':', 2);
    const groupKey = `${signalDate}:${cropId}`;
    const maxPerCrop = todo.priority === 'DANGER' ? 2 : 1;
    if ((groupCounts.get(groupKey) || 0) >= maxPerCrop) return false;
    seen.add(key);
    groupCounts.set(groupKey, (groupCounts.get(groupKey) || 0) + 1);
    return true;
  });
}

function preventiveActionItems(analysis) {
  const risks = Array.isArray(analysis?.forecast?.result?.risks)
    ? analysis.forecast.result.risks
    : [];
  const daily = Array.isArray(analysis?.environmentCause?.weather?.daily)
    ? analysis.environmentCause.weather.daily
    : [];
  const riskItems = risks.flatMap((risk) => {
    const actions = Array.isArray(risk?.guidance?.actions) ? risk.guidance.actions : [];
    const linkedDate = risk?.dateRange?.from || null;
    const matchingDay = daily.find((day) =>
      (risk?.riskId && day?.riskId === risk.riskId)
      || (linkedDate && day?.date === linkedDate));
    const evidence = signalEvidence(analysis, {
      axis: analysis?.environmentCause?.weather,
      linkedDate,
      untilKey: risk?.dateRange?.to || null,
      matchingDay,
      reason: risk?.guidance?.reason || null,
      recheck: risk?.guidance?.recheck || null,
    });
    return actions.map((text) => ({ text, evidence }));
  });
  const reviewedActions = (analysis?.actions || [])
    .map((action) => action?.title)
    .filter((title) => title && title !== '근거 확인');
  const fallbackByCode = {
    HIGH_TEMPERATURE: '한낮 전에 잎과 토양 수분을 확인하고 필요한 관수를 준비해요.',
    EXTREME_HEAT: '폭염 시간대 작업을 피하고 차광·환기·관수 상태를 바로 확인해요.',
    LOW_TEMPERATURE: '저온 예보 전 보온 자재와 시설 온도를 확인해요.',
    FROST: '서리 예보 전 보온 덮개와 방상 장비를 준비해요.',
    RAIN: '비가 오기 전 배수로와 쓰러짐 위험을 확인해요.',
    HEAVY_RAIN: '폭우 전에 배수로를 정리하고 침수 취약 구역을 점검해요.',
    STRONG_WIND: '강풍 전에 지주와 시설 고정 상태를 확인해요.',
    TYPHOON: '태풍 전에 시설물과 작물 지주를 보강하고 배수로를 비워요.',
    DROUGHT: '토양 수분을 확인하고 작물 단계에 맞춰 관수 계획을 조정해요.',
    SOIL_DRY: '토양 수분을 직접 확인한 뒤 필요한 양만 관수해요.',
    SOIL_WET: '추가 관수를 멈추고 배수 상태를 확인해요.',
    POOR_DRAINAGE: '고인 물과 배수로 막힘을 확인하고 물 빠짐을 확보해요.',
    PH_IMBALANCE: '임의로 자재를 넣지 말고 토양검정 결과와 작물 기준을 먼저 확인해요.',
    SALINITY_HIGH: 'EC 실측값을 확인하고 비료·관수 이력을 함께 점검해요.',
    TEXTURE_CAUTION: '토성에 맞는 배수·관수 방법인지 농업기술센터와 확인해요.',
    FLOODING: '침수 구역의 물을 빼고 뿌리와 시설 피해를 바로 확인해요.',
  };
  const axes = [
    analysis?.environmentCause?.weather,
    analysis?.environmentCause?.soil,
  ].filter((axis) => axis?.status === 'CAUTION' || axis?.status === 'DANGER');
  const defaultEvidence = signalEvidence(analysis);
  const reviewedItems = reviewedActions.map((text) => ({ text, evidence: defaultEvidence }));
  const fallbackItems = axes
    .map((axis) => {
      const text = fallbackByCode[axis.code];
      if (!text) return null;
      const evidence = signalEvidence(analysis, { axis });
      evidence.reason = fallbackReason(axis.code, evidence.cropName || '작물');
      return { text, evidence };
    })
    .filter(Boolean);
  const unique = new Map();
  for (const item of [...riskItems, ...reviewedItems, ...fallbackItems]) {
    if (typeof item?.text !== 'string' || !item.text.trim()) continue;
    if (!isEssentialPreventiveTodo({ source: 'ENVIRONMENT_ANALYSIS', text: item.text })) continue;
    if (!unique.has(item.text)) unique.set(item.text, item);
  }
  const maxActions = analysis?.environmentCause?.status === 'DANGER' ? 2 : 1;
  return [...unique.values()].slice(0, maxActions);
}

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
      this.#normalizeState();
    } else {
      this.state = {
        points: 0,
        attendance: createAttendanceState(),
        redemptions: createRedemptionLog(), // 실물 비료 교환 주문 기록
        crops: [],               // 지금 키우는 작물들 (createCropState 형태, 종류별 1개 · 최대 5종)
        completedCrops: [],      // 다 키운(수확한) 작물 기록 [{ cropId, finishedKey }]
        profile: defaultProfile(),
        cropProfiles: {},
        todos: [],
        diary: [],
        notifications: [],
        chatHistory: [],
      };
    }
  }

  #normalizeState() {
    this.state.profile = { ...defaultProfile(), ...(this.state.profile || {}) };
    this.state.cropProfiles = this.state.cropProfiles || {};
    this.state.todos = uniqueTodos(Array.isArray(this.state.todos) ? this.state.todos : []);
    this.state.diary = Array.isArray(this.state.diary) ? this.state.diary : [];
    this.state.notifications = Array.isArray(this.state.notifications)
      ? this.state.notifications
      : [];
    this.state.chatHistory = Array.isArray(this.state.chatHistory)
      ? this.state.chatHistory
      : [];
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
      profile: structuredClone(s.profile),
      cropProfiles: structuredClone(s.cropProfiles),
      titles: this.getTitleProgress(),
      unreadNotifications: s.notifications.filter((item) => !item.read).length,
    };
  }

  getProfile() {
    return structuredClone(this.state.profile);
  }

  updateProfile(input = {}) {
    const allowed = [
      'displayName',
      'onboardingComplete',
      'usageMode',
      'region',
      'address',
      'cultivationMode',
      'notificationsEnabled',
      'selectedTitleKey',
      'selectedBorderKey',
    ];
    for (const key of allowed) {
      if (input[key] !== undefined) this.state.profile[key] = input[key];
    }
    const progress = this.getTitleProgress();
    const unlockedKeys = new Set(progress.unlocked.map((title) => title.key));
    if (!unlockedKeys.has(this.state.profile.selectedTitleKey)) {
      this.state.profile.selectedTitleKey = progress.current.key;
    }
    if (!unlockedKeys.has(this.state.profile.selectedBorderKey)) {
      this.state.profile.selectedBorderKey = progress.current.key;
    }
    return this.getProfile();
  }

  configureCrop(cropId, context = {}) {
    if (!CROPS[cropId]) {
      return { ok: false, message: `없는 작물입니다: ${cropId}` };
    }
    const existing = this.state.cropProfiles[cropId] || {};
    this.state.cropProfiles[cropId] = {
      ...existing,
      usageMode: context.usageMode || existing.usageMode || 'ACTIVE_GROWING',
      region: context.region || existing.region || this.state.profile.region || '',
      address: context.address || existing.address || '',
      cultivationMode: context.cultivationMode || existing.cultivationMode || 'OPEN_FIELD',
      stageKey: context.stageKey || existing.stageKey || 'seed',
      startedKey: context.startedKey || existing.startedKey || toDateKey(new Date()),
      analysisId: context.analysisId || existing.analysisId || null,
    };
    return { ok: true, cropProfile: structuredClone(this.state.cropProfiles[cropId]) };
  }

  getCropProfile(cropId) {
    const found = this.state.cropProfiles[cropId];
    return found ? structuredClone(found) : null;
  }

  getTitleProgress() {
    const count = this.state.attendance.totalCheckIns || 0;
    const unlocked = TITLE_LEVELS.filter((title) => count >= title.requiredCheckIns);
    const current = unlocked.at(-1) || TITLE_LEVELS[0];
    const next = TITLE_LEVELS.find((title) => count < title.requiredCheckIns) || null;
    return {
      current: { ...current },
      selectedKey: this.state.profile.selectedTitleKey || current.key,
      selectedBorderKey: this.state.profile.selectedBorderKey || current.key,
      unlocked: unlocked.map((title) => ({ ...title })),
      next: next ? { ...next, remaining: next.requiredCheckIns - count } : null,
    };
  }

  syncPreventiveTodos(analysis) {
    const status = analysis?.environmentCause?.status;
    if (status !== 'CAUTION' && status !== 'DANGER') {
      return { added: [], notifications: [] };
    }
    const analysisId = analysis.analysisId || 'analysis';
    const cropId = String(analysis?.inputSummary?.crop || '').toLowerCase();
    const analysisDay = String(analysis?.createdAt || '').slice(0, 10) || toDateKey(new Date());
    const actions = preventiveActionItems(analysis);
    const todos = this.state.todos;
    const added = [];
    for (const [index, action] of actions.entries()) {
      const { text, evidence } = action;
      // 같은 날 같은 작물에 같은 예방 행동이 다시 분석되어도 중복 생성하지 않습니다.
      const signalDate = evidence?.dateKey || analysisDay;
      const sourceKey = `environment:${signalDate}:${cropId || 'crop'}:${text}`;
      const semanticKey = `${signalDate}:${cropId || 'crop'}:${String(text).trim().replace(/\s+/gu, ' ')}`;
      if (todos.some((todo) => preventiveTodoSemanticKey(todo) === semanticKey)) continue;
      const todo = {
        id: `a${Date.now()}${index}${Math.floor(Math.random() * 1000)}`,
        text,
        done: false,
        createdKey: toDateKey(new Date()),
        source: 'ENVIRONMENT_ANALYSIS',
        sourceKey,
        cropId: cropId || null,
        priority: status === 'DANGER' ? 'DANGER' : 'CAUTION',
        analysisId,
        evidence,
      };
      todos.push(todo);
      added.push(todo);
    }
    const notifications = [];
    if (added.length) {
      const item = {
        id: `n${Date.now()}${Math.floor(Math.random() * 1000)}`,
        title: status === 'DANGER' ? '지금 확인할 농장 위험이 있어요' : '예방할 농장 주의사항이 있어요',
        message: `${added.length}개의 예방 할 일을 준비했어요.`,
        createdAt: new Date().toISOString(),
        analysisId,
        read: false,
      };
      this.state.notifications.push(item);
      notifications.push(item);
    }
    this.state.notifications = this.state.notifications.slice(-40);
    return { added: structuredClone(added), notifications: structuredClone(notifications) };
  }

  /** 선택 가능한 캐릭터(작물) 5종 목록. 로그인/유저와 무관한 정적 데이터. */
  static getCharacters() {
    return CROP_IDS.map((id) => ({
      id,
      name: CROPS[id].name,
      emoji: CROPS[id].emoji,
      stages: CROPS[id].stages.map((stage) => ({
        key: stage.key,
        name: stage.name,
        daysRequired: stage.daysRequired,
      })),
    }));
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
  selectCrop(cropId, when = new Date(), context = {}) {
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
    const stageIndex = crop.stages.findIndex((stage) => stage.key === context.stageKey);
    if (stageIndex >= 0) {
      cropState.growth = crop.stages[stageIndex].daysRequired;
      cropState.stageIndex = stageIndex;
      cropState.matured = stageIndex === crop.stages.length - 1;
    }
    cropState.startedKey = context.startedKey || (typeof when === 'string' ? when : toDateKey(when));
    this.state.crops.push(cropState);
    this.configureCrop(cropId, {
      ...context,
      stageKey: crop.stages[cropState.stageIndex].key,
      startedKey: cropState.startedKey,
    });

    const setupMessage = context.usageMode === 'LAND_SEARCH'
      ? `${crop.emoji} ${crop.name} 재배 준비를 시작했어요.`
      : `${crop.emoji} ${crop.name} 재배 기록을 시작했어요.`;
    return {
      ok: true,
      message: setupMessage,
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
