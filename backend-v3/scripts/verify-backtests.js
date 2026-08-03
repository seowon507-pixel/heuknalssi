import {
  VERIFIED_KMA_ASOS_CONTRACT_VERSION,
  VERIFIED_KMA_HISTORICAL_SHORT_CONTRACT_VERSION,
  createKmaAsosObservationAdapter,
  createKmaHistoricalShortForecastAdapter,
} from '../src/adapters/index.js';
import {
  calculateIssuedForecastMetrics,
  replayAsosRiskRules,
  toKmaGrid,
} from '../src/application/index.js';
import { REVIEWED_CROP_RULES } from '../runtime/reviewed-crop-rules.js';

const SERVICE_KEY = process.env.DATA_GO_KR_SERVICE_KEY?.trim() || null;
const API_HUB_KEY = process.env.KMA_API_HUB_AUTH_KEY?.trim() || null;
const TARGET = Object.freeze({
  label: '경상북도 안동시 검수 지점',
  stationId: '136',
  latitude: 36.57293,
  longitude: 128.70733,
  issuedBaseDate: '20250719',
  issuedBaseTime: '1700',
  observationWindow: {
    from: '2025-07-20',
    to: '2025-07-26',
  },
});
const HISTORICAL_CLOCK = () => new Date('2025-07-27T00:00:00.000Z');
const grid = toKmaGrid(TARGET.latitude, TARGET.longitude);

const observationCommon = {
  enabled: Boolean(SERVICE_KEY),
  apiKey: SERVICE_KEY,
  fetchImpl: globalThis.fetch,
  timeoutMs: 10_000,
  cacheFreshForMs: 0,
  now: HISTORICAL_CLOCK,
};
const observationsAdapter = createKmaAsosObservationAdapter({
  ...observationCommon,
  contractVersion: VERIFIED_KMA_ASOS_CONTRACT_VERSION,
});
const forecastAdapter = createKmaHistoricalShortForecastAdapter({
  enabled: Boolean(API_HUB_KEY),
  apiKey: API_HUB_KEY,
  fetchImpl: globalThis.fetch,
  timeoutMs: 10_000,
  cacheFreshForMs: 0,
  contractVersion: VERIFIED_KMA_HISTORICAL_SHORT_CONTRACT_VERSION,
});

const [observationEnvelope, forecastEnvelope] = await Promise.all([
  observationsAdapter.getRecent(
    { stationId: TARGET.stationId, completedDays: 7 },
    { deadlineAt: HISTORICAL_CLOCK().getTime() + 20_000 },
  ),
  forecastAdapter.getIssuedForecast(
    {
      ...grid,
      baseDate: TARGET.issuedBaseDate,
      baseTime: TARGET.issuedBaseTime,
    },
    { deadlineAt: Date.now() + 20_000 },
  ),
]);

const observationRows =
  observationEnvelope.adapterState === 'SUCCESS'
    ? observationEnvelope.data?.readings ?? []
    : [];
const issuedForecastRows =
  forecastEnvelope.adapterState === 'SUCCESS'
    ? (forecastEnvelope.data?.days ?? []).map((day) => ({
        issuedAt: day.issueTime,
        validAt: day.validFrom,
        validDate: day.date,
        minTemperature: day.minTemperature,
        maxTemperature: day.maxTemperature,
        precipitationProbability: day.precipitationProbability,
      }))
    : [];
const riskRules = REVIEWED_CROP_RULES.filter(
  (rule) =>
    rule.module === 'FORECAST' &&
    rule.use === 'FORECAST_RISK' &&
    rule.cultivationMode === 'OPEN_FIELD',
);

const replay =
  observationRows.length > 0
    ? replayAsosRiskRules({
        rules: riskRules,
        observations: observationRows,
      })
    : {
        state: 'BLOCKED',
        reason: `ASOS_${observationEnvelope.adapterState}`,
      };
const accuracy =
  observationRows.length > 0 && issuedForecastRows.length > 0
    ? calculateIssuedForecastMetrics({
        issuedForecasts: issuedForecastRows,
        observations: observationRows,
      })
    : {
        state: 'BLOCKED',
        reasons: [
          ...(observationRows.length === 0
            ? [`ASOS_${observationEnvelope.adapterState}`]
            : []),
          ...(issuedForecastRows.length === 0
            ? [`ISSUED_FORECAST_${forecastEnvelope.adapterState}`]
            : []),
        ],
      };
const ready = replay.state === 'READY' && accuracy.state === 'READY';
const result = {
  auditKind: 'HISTORICAL_ASOS_AND_ISSUED_FORECAST_BACKTEST',
  state: ready ? 'READY' : 'CHANGES_REQUESTED',
  target: {
    label: TARGET.label,
    stationId: TARGET.stationId,
    forecastGrid: grid,
    issuedAtKst: `${TARGET.issuedBaseDate}${TARGET.issuedBaseTime}`,
    observationWindow: TARGET.observationWindow,
  },
  providerStates: {
    historicalAsos: {
      state: observationEnvelope.adapterState,
      qualityFlags: observationEnvelope.qualityFlags,
    },
    historicalIssuedForecast: {
      state: forecastEnvelope.adapterState,
      qualityFlags: forecastEnvelope.qualityFlags,
      requiredCapability:
        forecastEnvelope.adapterState === 'SUCCESS'
          ? null
          : 'KMA_API_HUB_HISTORICAL_SHORT_FORECAST',
    },
  },
  replay,
  accuracy,
  guarantees: {
    missingValuesImputed: false,
    currentForecastSubstitutedForHistoricalIssue: false,
    credentialsDisclosed: false,
  },
};

console.log(JSON.stringify(result, null, 2));
if (!ready) process.exitCode = 2;
