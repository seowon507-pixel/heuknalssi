const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY?.trim();

if (!serviceKey) {
  throw new Error("DATA_GO_KR_SERVICE_KEY is not configured");
}

const stationId = "136";
const startDate = "20250720";
const endDate = "20250726";
const encodedKey = /%[0-9A-F]{2}/iu.test(serviceKey)
  ? serviceKey
  : encodeURIComponent(serviceKey);
const url =
  "https://apis.data.go.kr/1360000/AsosDalyInfoService/getWthrDataList" +
  `?serviceKey=${encodedKey}` +
  "&pageNo=1&numOfRows=20&dataType=JSON&dataCd=ASOS&dateCd=DAY" +
  `&startDt=${startDate}&endDt=${endDate}&stnIds=${stationId}`;

const response = await fetch(url, {
  headers: { accept: "application/json" },
  signal: AbortSignal.timeout(10_000),
});
const body = await response.text();

if (!response.ok) {
  const safeCode =
    body.match(/<(?:returnReasonCode|resultCode)>([^<]{1,40})</iu)?.[1] ??
    "UNKNOWN";
  const safeMessage =
    body.match(/<(?:errMsg|returnAuthMsg|resultMsg)>([^<]{1,120})</iu)?.[1] ??
    "no provider message";
  throw new Error(
    `ASOS HTTP ${response.status} (${safeCode}: ${safeMessage})`,
  );
}

let payload;
try {
  payload = JSON.parse(body);
} catch {
  throw new Error("ASOS did not return JSON");
}

const header = payload?.response?.header;
if (header?.resultCode !== "00") {
  throw new Error(
    `ASOS provider error ${header?.resultCode ?? "UNKNOWN"}: ` +
      `${header?.resultMsg ?? "no message"}`,
  );
}

const items = payload?.response?.body?.items?.item;
if (!Array.isArray(items) || items.length === 0) {
  throw new Error("ASOS returned no observations");
}

const finiteOrNull = (value) => {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const rows = items.map((item) => {
  const maxTemperature = finiteOrNull(item.maxTa);
  const minTemperature = finiteOrNull(item.minTa);
  const precipitation = finiteOrNull(item.sumRn);
  return {
    date: item.tm,
    station: item.stnNm,
    maxTemperature,
    minTemperature,
    precipitation,
    appleHeatRuleTriggered:
      maxTemperature !== null && maxTemperature >= 30,
    potatoBulkingHeatRuleTriggered:
      maxTemperature !== null && maxTemperature >= 27,
  };
});

const summary = {
  auditKind: "REALIZED_WEATHER_RULE_REPLAY",
  source: "기상청 지상(종관, ASOS) 일자료 조회서비스",
  sourceUrl: "https://www.data.go.kr/data/15059093/openapi.do",
  stationId,
  stationName: rows[0]?.station ?? null,
  period: { startDate, endDate },
  rowCount: rows.length,
  appleHeatTriggerDays: rows.filter((row) => row.appleHeatRuleTriggered)
    .length,
  potatoBulkingHeatTriggerDays: rows.filter(
    (row) => row.potatoBulkingHeatRuleTriggered,
  ).length,
  rows,
  limitation:
    "관측값으로 현재 임계값의 발동 여부만 재현한다. 과거 예보 시점 자료를 사용한 예보 정확도 백테스트가 아니다.",
};

console.log(JSON.stringify(summary, null, 2));
