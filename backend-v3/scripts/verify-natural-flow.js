const baseUrl =
  process.env.BACKEND_BASE_URL?.trim() || "http://127.0.0.1:3100";
const origin = process.env.FRONTEND_ORIGIN?.trim() || "http://localhost:3000";
const query =
  process.env.VERIFICATION_ADDRESS?.trim() ||
  "경상북도 안동시 퇴계로 115";

const sessionResponse = await fetch(`${baseUrl}/api/session`, {
  headers: { Origin: origin },
});
const session = await readJson(sessionResponse);
if (!sessionResponse.ok) {
  fail("SESSION_FAILED", sessionResponse.status, session);
}
const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
if (!cookie || typeof session.csrfToken !== "string") {
  fail("SESSION_CONTRACT_CHANGED", sessionResponse.status, session);
}

const locationResponse = await fetch(
  `${baseUrl}/api/locations?q=${encodeURIComponent(query)}`,
  {
    headers: {
      Cookie: cookie,
      Origin: origin,
    },
  },
);
const location = await readJson(locationResponse);
if (!locationResponse.ok) {
  fail("LOCATION_SEARCH_FAILED", locationResponse.status, location);
}

const candidates = Array.isArray(location.candidates)
  ? location.candidates
  : [];
const selected =
  candidates.find(
    (candidate) =>
      candidate?.resolutionMode === "ADDRESS_RESOLVED" &&
      typeof candidate?.displayName === "string" &&
      candidate.displayName.includes("안동"),
  ) ?? candidates[0];
if (!selected?.candidateToken) {
  fail("NO_LOCATION_CANDIDATE", locationResponse.status, {
    candidateCount: candidates.length,
  });
}

const analysisResponse = await fetch(`${baseUrl}/api/analyses`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Cookie: cookie,
    "Idempotency-Key": `audit-natural-flow-${Date.now()}`,
    Origin: origin,
    "X-CSRF-Token": session.csrfToken,
  },
  body: JSON.stringify({
    usageMode: "LAND_SEARCH",
    location: {
      candidateToken: selected.candidateToken,
      userConfirmed: true,
    },
    crop: "APPLE",
    cultivationMode: "OPEN_FIELD",
    season: {
      kind: "VERIFIED_PROFILE",
      profileId: "APPLE_OPEN_FIELD_ANNUAL",
      userConfirmed: true,
    },
    options: {
      includeSmartfarmBenchmark: false,
      includeSatelliteObservation: false,
      saveConsent: false,
    },
  }),
});
const analysis = await readJson(analysisResponse);
if (!analysisResponse.ok) {
  fail("ANALYSIS_FAILED", analysisResponse.status, analysis);
}

const assistantResponse = await fetch(
  `${baseUrl}/api/analyses/${encodeURIComponent(analysis.analysisId)}/assistant`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: origin,
      "X-CSRF-Token": session.csrfToken,
    },
    body: JSON.stringify({
      question: "현재 상태의 이유와 먼저 할 일을 알려줘",
    }),
  },
);
const assistant = await readJson(assistantResponse);
if (!assistantResponse.ok) {
  fail("ASSISTANT_FAILED", assistantResponse.status, assistant);
}

console.log(
  JSON.stringify(
    {
      flow: "LAND_SEARCH",
      httpStatus: analysisResponse.status,
      location: {
        candidateCount: candidates.length,
        selectedDisplayName: selected.displayName ?? null,
        resolutionMode: selected.resolutionMode ?? null,
      },
      analysis: {
        state: analysis.state ?? null,
        conditionState: analysis.conditionState ?? null,
        riskState: analysis.riskState ?? null,
        decisionCode: analysis.decision?.code ?? null,
        lifecycleState: analysis.lifecycle?.currentState ?? null,
        primaryActionId: analysis.primaryAction?.actionId ?? null,
        actionCount: Array.isArray(analysis.actions)
          ? analysis.actions.length
          : 0,
        moduleStates: {
          climate: analysis.climate?.state ?? null,
          soil: analysis.soil?.state ?? null,
          observations: analysis.observations?.state ?? null,
          forecast: analysis.forecast?.state ?? null,
        },
      },
      assistant: {
        httpStatus: assistantResponse.status,
        mode: assistant.mode ?? null,
        fallbackReason: assistant.fallbackReason ?? null,
        grounded: assistant.grounded === true,
        answerSections:
          typeof assistant.answer === "string"
            ? assistant.answer
                .split("\n")
                .filter(Boolean)
                .filter((line) =>
                  [
                    "확인된 내용",
                    "필요한 행동",
                    "다시 확인할 때",
                    "자료 확인",
                  ].includes(line),
                )
            : [],
      },
      sources: (analysis.dataSources ?? []).map((source) => ({
        sourceId: source.sourceId,
        sourceName: source.sourceName,
        deliveryState: source.deliveryState,
        adapterState: source.adapterState,
        spatialLevel: source.spatialLevel,
        distanceKm: source.distanceKm,
        qualityFlags: source.qualityFlags,
      })),
      limitations: analysis.limitations ?? [],
    },
    null,
    2,
  ),
);

function fail(code, httpStatus, payload) {
  const error = payload?.error;
  console.error(
    JSON.stringify(
      {
        flow: "LAND_SEARCH",
        result: "FAILED",
        code,
        httpStatus,
        apiError: error
          ? {
              code: error.code ?? null,
              message: error.message ?? null,
            }
          : null,
        candidateCount: payload?.candidateCount ?? null,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
