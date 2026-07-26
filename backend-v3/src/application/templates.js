const DECISION_MESSAGES = Object.freeze({
  'LAND_SEARCH|OPEN_FIELD|DATA_NEEDED':
    '장기 조건자료를 더 확보한 뒤 후보지를 판단하세요.',
  'ACTIVE_GROWING|OPEN_FIELD|DATA_NEEDED':
    '장기 조건자료가 부족합니다. 가까운 위험은 별도 근거에서 확인하세요.',
  'LAND_SEARCH|OPEN_FIELD|CHECK_FIRST':
    '확인된 주의 항목을 먼저 검토한 뒤 후보지를 비교하세요.',
  'ACTIVE_GROWING|OPEN_FIELD|CHECK_FIRST':
    '현재 재배지에서 확인된 주의 항목을 먼저 점검하세요.',
  'LAND_SEARCH|OPEN_FIELD|FIELD_TEST_NEXT':
    '공개자료에서 큰 이탈이 확인되지 않았습니다. 필지 현장검정을 진행하세요.',
  'ACTIVE_GROWING|OPEN_FIELD|FIELD_TEST_NEXT':
    '공개자료에서 큰 이탈이 확인되지 않았습니다. 현장 측정으로 다시 확인하세요.',
  'LAND_SEARCH|FACILITY_SOIL|FACILITY_DATA_NEEDED':
    '외기자료와 시설 운영계획을 함께 확인하세요.',
  'LAND_SEARCH|FACILITY_HYDRO|FACILITY_DATA_NEEDED':
    '외기자료와 시설 운영계획을 함께 확인하세요.',
  'ACTIVE_GROWING|FACILITY_SOIL|FACILITY_DATA_NEEDED':
    '외기자료가 부족합니다. 시설 내부 센서를 직접 확인하세요.',
  'ACTIVE_GROWING|FACILITY_HYDRO|FACILITY_DATA_NEEDED':
    '외기자료가 부족합니다. 시설 내부 센서를 직접 확인하세요.',
  'LAND_SEARCH|FACILITY_SOIL|FACILITY_CHECK_FIRST':
    '확인된 외기 운영위험을 시설 설계와 운영계획에 반영하세요.',
  'LAND_SEARCH|FACILITY_HYDRO|FACILITY_CHECK_FIRST':
    '확인된 외기 운영위험을 시설 설계와 운영계획에 반영하세요.',
  'ACTIVE_GROWING|FACILITY_SOIL|FACILITY_CHECK_FIRST':
    '확인된 시설 운영위험부터 점검하세요.',
  'ACTIVE_GROWING|FACILITY_HYDRO|FACILITY_CHECK_FIRST':
    '확인된 시설 운영위험부터 점검하세요.',
  'LAND_SEARCH|FACILITY_SOIL|FACILITY_SENSOR_NEXT':
    '외기상 큰 위험은 확인되지 않았습니다. 내부 센서 점검계획을 확인하세요.',
  'LAND_SEARCH|FACILITY_HYDRO|FACILITY_SENSOR_NEXT':
    '외기상 큰 위험은 확인되지 않았습니다. 내부 센서 점검계획을 확인하세요.',
  'ACTIVE_GROWING|FACILITY_SOIL|FACILITY_SENSOR_NEXT':
    '외기상 큰 위험은 확인되지 않았습니다. 내부 센서 상태를 확인하세요.',
  'ACTIVE_GROWING|FACILITY_HYDRO|FACILITY_SENSOR_NEXT':
    '외기상 큰 위험은 확인되지 않았습니다. 내부 센서 상태를 확인하세요.',
});

const ACTION_TITLES = Object.freeze({
  COLLECT_REQUIRED_DATA: '판단에 필요한 자료 확보',
  CONFIRM_SEASON: '작기 확인 후 다시 분석',
  REVIEW_CONDITION_EVIDENCE: '주의 근거 우선 확인',
  REQUEST_FIELD_SOIL_TEST: '필지 토양검정 진행',
  CHECK_CURRENT_FORECAST_RISK: '가까운 기상위험 확인',
  CHECK_FACILITY_WEATHER: '시설 외기와 내부 온도·환기 상태 확인',
  CHECK_INTERNAL_SENSORS: '시설 내부 온도 센서와 환기 상태 확인',
});

export function renderDecisionMessage(request, decisionCode) {
  const key = `${request.usageMode}|${request.cultivationMode}|${decisionCode}`;
  const message = DECISION_MESSAGES[key];
  if (!message) {
    const error = new Error(`decision template contract is missing for ${key}`);
    error.code = 'INTERNAL_ERROR';
    error.status = 500;
    throw error;
  }
  return message;
}

export function renderActionTitle(actionId) {
  return ACTION_TITLES[actionId] ?? '근거 확인';
}

export function buildDeterministicReport(analysis) {
  const decisionText =
    analysis.decision?.message ??
    '현재 확보된 자료와 한계를 확인한 뒤 다음 행동을 선택하세요.';
  const actionItems = (analysis.actions ?? []).map((action) => ({
    text: action.title ?? renderActionTitle(action.actionId),
    factIds: resolveEvidenceIds(analysis, action.triggerIds),
    actionIds: [action.actionId],
  }));
  const riskItems = (analysis.forecast?.result?.risks ?? []).flatMap((risk) => {
    const factIds = resolveEvidenceIds(analysis, [risk.riskId]);
    return factIds.length === 0
      ? []
      : [
          {
            text:
              risk.guidance?.reason ??
              risk.renderedText ??
              risk.title ??
              '예보 위험 근거를 확인하세요.',
            factIds,
            actionIds: risk.actionId ? [risk.actionId] : [],
          },
        ];
  });
  const guidedActionItems = (analysis.forecast?.result?.risks ?? []).flatMap(
    (risk) => {
      const factIds = resolveEvidenceIds(analysis, [risk.riskId]);
      if (factIds.length === 0 || !Array.isArray(risk.guidance?.actions)) {
        return [];
      }
      return risk.guidance.actions.map((text) => ({
        text,
        factIds,
        actionIds: risk.actionId ? [risk.actionId] : [],
      }));
    },
  );
  const limitationItems = (analysis.limitations ?? []).map((text) => ({
    text,
    factIds: [],
    actionIds: [],
  }));

  return Object.freeze({
    policyVersion: 'report-template-v1',
    summary: {
      text: decisionText,
      factIds: resolveEvidenceIds(
        analysis,
        analysis.decision?.triggerIds,
      ),
      actionIds: analysis.primaryAction?.actionId
        ? [analysis.primaryAction.actionId]
        : [],
    },
    strengths: [],
    risks: riskItems,
    nextActions: dedupeReportItems([...guidedActionItems, ...actionItems]),
    limitations: limitationItems,
  });
}

function dedupeReportItems(items) {
  return [
    ...new Map(
      items.map((item) => [
        `${item.text}|${item.actionIds.join(",")}`,
        item,
      ]),
    ).values(),
  ];
}

function resolveEvidenceIds(analysis, triggerIds = []) {
  return resolveEligibleEvidence(analysis, triggerIds).evidenceIds;
}

export function resolveEligibleEvidence(source, triggerIds = []) {
  const evidence = analysisEvidence(source).filter(isClaimEvidence);
  const matched = [];
  const unresolvedTriggerIds = [];
  for (const triggerId of triggerIds ?? []) {
    const exact = evidence.filter(
      (item) => item.evidenceId === triggerId,
    );
    const byRule =
      exact.length > 0
        ? []
        : evidence.filter((item) => item.ruleId === triggerId);
    const byState =
      exact.length > 0 || byRule.length > 0
        ? []
        : evidenceForStateTrigger(evidence, triggerId);
    const matches = [...exact, ...byRule, ...byState];
    if (matches.length === 0) {
      unresolvedTriggerIds.push(triggerId);
    } else {
      matched.push(...matches);
    }
  }
  const uniqueEvidence = [
    ...new Map(matched.map((item) => [item.evidenceId, item])).values(),
  ];
  return {
    evidence: uniqueEvidence,
    evidenceIds: uniqueEvidence.map((item) => item.evidenceId),
    unresolvedTriggerIds,
  };
}

function evidenceForStateTrigger(evidence, triggerId) {
  if (triggerId === 'state:condition-ready') {
    return evidence.filter(({ module }) =>
      ['CLIMATE', 'SOIL'].includes(module),
    );
  }
  if (
    triggerId === 'state:risk-ready' ||
    triggerId === 'forecast:no-active-operation-risk'
  ) {
    return evidence.filter(
      ({ module, effect }) =>
        module === 'FORECAST' && effect === 'NO_ACTIVE_RISK',
    );
  }
  return [];
}

function isClaimEvidence(evidence) {
  return (
    evidence.inclusion === 'INCLUDED' &&
    evidence.evidenceStatus !== 'UNCONFIRMED' &&
    evidence.freshness === 'CURRENT' &&
    !evidence.qualityFlags?.some((flag) =>
      ['STALE', 'SAMPLE', 'PARTIAL_PROVIDER_FAILURE'].includes(flag),
    )
  );
}

function analysisEvidence(analysis) {
  return [
    ...(analysis.climate?.evidence ?? []),
    ...(analysis.soil?.evidence ?? []),
    ...(analysis.observations?.evidence ?? []),
    ...(analysis.forecast?.evidence ?? []),
  ];
}
