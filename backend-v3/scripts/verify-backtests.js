import {
  VERIFIED_KMA_ASOS_CONTRACT_VERSION,
  VERIFIED_KMA_SHORT_CONTRACT_VERSION,
  createKmaAsosObservationAdapter,
  createKmaShortForecastAdapter,
} from '../src/adapters/index.js';
import {
  calculateIssuedForecastMetrics,
  replayAsosRiskRules,
  toKmaGrid,
} from '../src/application/index.js';
import { REVIEWED_CROP_RULES } from '../runtime/reviewed-crop-rules.js';

const SERVICE_KEY = process.env.DATA_GO_KR_SERVICE_KEY?.trim() || null;
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
const deadlineAt = HISTORICAL_CLOCK().getTime() + 20_000;
const grid = toKmaGrid(TARGET.latitude, TARGET.longitude);

const common = {
  enabled: Boolean(SERVICE_KEY),
  apiKey: SERVICE_KEY,
  fetchImpl: globalThis.fetch,
  timeoutMs: 10_000,
  cacheFreshForMs: 0,
  now: HISTORICAL_CLOCK,
};
const observationsAdapter = createKmaAsosObservationAdapter({
  ...common,
  contractVersion: VERIFIED_KMA_ASOS_CONTRACT_VERSION,
});
const forecastAdapter = createKmaShortForecastAdapter({
  ...common,
  contractVersion: VERIFIED_KMA_SHORT_CONTRACT_VERSION,
});

const [observationEnvelope, forecastEnvelope] = await Promise.all([
  observationsAdapter.getRecent(
    { stationId: TARGET.stationId, completedDays: 7 },
    { deadlineAt },
  ),
  forecastAdapter.getForecast(
    {
      ...grid,
      baseDate: TARGET.issuedBaseDate,
      baseTime: TARGET.issuedBaseTime,
    },
    { deadlineAt },
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
    historicalAsos: observationEnvelope.adapterState,
    historicalIssuedForecast: forecastEnvelope.adapterState,
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
