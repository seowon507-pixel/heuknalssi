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

const [observationEnvelope, forecastSnapshots] = await Promise.all([
  observationsAdapter.getRecent(
    { stationId: TARGET.stationId, completedDays: 7 },
    { deadlineAt: HISTORICAL_CLOCK().getTime() + 20_000 },
  ),
  fetchIssuedDailyForecast({
    adapter: forecastAdapter,
    point: { id: TARGET.stationId, ...grid },
    baseDate: TARGET.issuedBaseDate,
    baseTime: TARGET.issuedBaseTime,
    validDate: TARGET.observationWindow.from.replaceAll('-', ''),
  }),
]);

const observationRows =
  observationEnvelope.adapterState === 'SUCCESS'
    ? observationEnvelope.data?.readings ?? []
    : [];
const forecastEnvelopeState = summarizeSnapshotState(forecastSnapshots);
const issuedForecastRows = dailyForecastRow(forecastSnapshots);
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
const temperatureReady =
  accuracy.temperature?.minTemperature?.sampleCount > 0 &&
  accuracy.temperature?.maxTemperature?.sampleCount > 0;
const ready =
  replay.state === 'READY' &&
  forecastEnvelopeState === 'SUCCESS' &&
  temperatureReady;
const result = {
  auditKind: 'HISTORICAL_ASOS_AND_ISSUED_FORECAST_BACKTEST',
  state: ready ? 'TEMPERATURE_READY' : 'CHANGES_REQUESTED',
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
      state: forecastEnvelopeState,
      qualityFlags: [
        ...new Set(forecastSnapshots.flatMap(({ qualityFlags = [] }) => qualityFlags)),
      ],
      requiredCapability:
        forecastEnvelopeState === 'SUCCESS'
          ? null
          : 'KMA_API_HUB_HISTORICAL_SHORT_GRID',
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

async function fetchIssuedDailyForecast({
  adapter,
  point,
  baseDate,
  baseTime,
  validDate,
}) {
  return Promise.all([
    adapter.getGridSnapshot(
      {
        baseDate,
        baseTime,
        validDate,
        validTime: '0600',
        variable: 'TMN',
        points: [point],
      },
      { deadlineAt: Date.now() + 30_000 },
    ),
    adapter.getGridSnapshot(
      {
        baseDate,
        baseTime,
        validDate,
        validTime: '1500',
        variable: 'TMX',
        points: [point],
      },
      { deadlineAt: Date.now() + 30_000 },
    ),
  ]);
}

function summarizeSnapshotState(snapshots) {
  const states = snapshots.map(({ adapterState }) => adapterState);
  if (states.every((state) => state === 'SUCCESS')) return 'SUCCESS';
  if (states.some((state) => state === 'SUCCESS')) return 'PARTIAL';
  return states[0] ?? 'UNAVAILABLE';
}

function dailyForecastRow(snapshots) {
  const byVariable = new Map(
    snapshots.map((snapshot) => [snapshot.data?.variable, snapshot]),
  );
  const tmin = byVariable.get('TMN');
  const tmax = byVariable.get('TMX');
  if (![tmin, tmax].every((snapshot) => snapshot?.adapterState === 'SUCCESS')) {
    return [];
  }
  return [{
    issuedAt: tmax.issuedAt,
    validAt: tmax.validFrom,
    validDate: TARGET.observationWindow.from,
    minTemperature: tmin.data.points[0].value,
    maxTemperature: tmax.data.points[0].value,
    precipitationProbability: null,
  }];
}
