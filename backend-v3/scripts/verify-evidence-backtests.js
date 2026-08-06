import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  evaluateFarmOutcomeGroundTruth,
  evaluateHistoricalSoilCoverage,
} from "../src/application/index.js";

const DEFAULT_INPUT_DIRECTORY = path.resolve(
  process.cwd(),
  "../product_upgrade_validation/backtest_1y/input_templates",
);
const OUTPUT_DIRECTORY = path.resolve(
  process.cwd(),
  "../product_upgrade_validation/backtest_1y",
);
const inputDirectory = resolveInputDirectory(process.argv.slice(2));

const outcomes = await readCsv("farm-outcomes.csv", [
  "farm_id", "crop_id", "season_id", "first_harvest_date",
  "last_harvest_date", "evidence_source",
], (row) => ({
  farmId: row.farm_id,
  cropId: row.crop_id,
  seasonId: row.season_id,
  firstHarvestDate: blankToNull(row.first_harvest_date),
  lastHarvestDate: blankToNull(row.last_harvest_date),
  evidenceSource: blankToNull(row.evidence_source),
}));
const damageEvents = await readCsv("damage-events.csv", [
  "farm_id", "crop_id", "season_id", "risk_type", "observed_date",
  "evidence_source",
], (row) => ({
  farmId: row.farm_id,
  cropId: row.crop_id,
  seasonId: row.season_id,
  riskType: row.risk_type,
  observedDate: row.observed_date,
  evidenceSource: blankToNull(row.evidence_source),
}));
const harvestPredictions = await readCsv("harvest-predictions.csv", [
  "farm_id", "crop_id", "season_id", "issued_at", "window_start", "window_end",
], (row) => ({
  farmId: row.farm_id,
  cropId: row.crop_id,
  seasonId: row.season_id,
  issuedAt: row.issued_at,
  windowStart: row.window_start,
  windowEnd: row.window_end,
}));
const alerts = await readCsv("risk-alerts.csv", [
  "farm_id", "crop_id", "season_id", "risk_type", "issued_at", "valid_from",
  "valid_to",
], (row) => ({
  farmId: row.farm_id,
  cropId: row.crop_id,
  seasonId: row.season_id,
  riskType: row.risk_type,
  issuedAt: row.issued_at,
  validFrom: row.valid_from,
  validTo: row.valid_to,
}));
const soilSnapshots = await readCsv("soil-snapshots.csv", [
  "farm_id", "parcel_id", "sampled_on", "source_type", "ph", "ec",
  "organic_matter", "available_phosphorus", "soil_texture", "drainage_class",
], (row) => ({
  farmId: row.farm_id,
  parcelId: row.parcel_id,
  sampledOn: row.sampled_on,
  sourceType: row.source_type,
  ph: numericOrNull(row.ph, "ph"),
  ec: numericOrNull(row.ec, "ec"),
  organicMatter: numericOrNull(row.organic_matter, "organic_matter"),
  availablePhosphorus: numericOrNull(
    row.available_phosphorus,
    "available_phosphorus",
  ),
  soilTexture: blankToNull(row.soil_texture),
  drainageClass: blankToNull(row.drainage_class),
}));
const soilAnalysisDates = await readCsv("soil-analysis-dates.csv", [
  "farm_id", "parcel_id", "date",
], (row) => ({
  farmId: row.farm_id,
  parcelId: row.parcel_id,
  date: row.date,
}));

const farmOutcomeAccuracy = evaluateFarmOutcomeGroundTruth({
  outcomes,
  damageEvents,
  harvestPredictions,
  alerts,
});
const historicalSoilCoverage = evaluateHistoricalSoilCoverage({
  analysisDates: soilAnalysisDates,
  snapshots: soilSnapshots,
});
const result = {
  auditKind: "FARM_OUTCOME_AND_HISTORICAL_SOIL_EVIDENCE_BACKTEST",
  generatedAt: new Date().toISOString(),
  state:
    farmOutcomeAccuracy.state === "READY" && historicalSoilCoverage.state === "READY"
      ? "READY"
      : "COLLECTION_PIPELINE_READY",
  inputDirectory: repositoryRelativePath(inputDirectory),
  farmOutcomeAccuracy,
  historicalSoilCoverage,
  guarantees: {
    missingValuesImputed: false,
    unlabeledDaysTreatedAsHealthy: false,
    futureSoilSnapshotUsed: false,
    currentSoilSubstitutedForHistoricalSoil: false,
    rawAddressExported: false,
    callerResponsibleForOpaqueIdentifiers: true,
  },
};
await mkdir(OUTPUT_DIRECTORY, { recursive: true });
const outputPath = path.join(OUTPUT_DIRECTORY, "evidence-backtest-state.json");
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(
  `${JSON.stringify({ ...result, outputPath: repositoryRelativePath(outputPath) }, null, 2)}\n`,
);

async function readCsv(filename, expectedHeaders, mapper) {
  const filePath = path.join(inputDirectory, filename);
  const text = await readFile(filePath, "utf8");
  const rows = parseCsv(text);
  if (rows.length === 0) throw new TypeError(`${filename} is missing its header.`);
  const [headers, ...records] = rows;
  if (JSON.stringify(headers) !== JSON.stringify(expectedHeaders)) {
    throw new TypeError(`${filename} header does not match the frozen template.`);
  }
  return records
    .filter((record) => record.some((value) => value !== ""))
    .map((record, index) => {
      if (record.length !== headers.length) {
        throw new TypeError(`${filename} row ${index + 2} has the wrong column count.`);
      }
      return mapper(
        Object.fromEntries(
          headers.map((header, column) => [header, record[column]]),
        ),
      );
    });
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const normalized = String(text).replace(/^\uFEFF/u, "");
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '"') {
      if (quoted && normalized[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && normalized[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw new TypeError("CSV contains an open quote.");
  if (cell !== "" || row.length > 0) {
    row.push(cell.trim());
    if (row.some((value) => value !== "")) rows.push(row);
  }
  return rows;
}

function blankToNull(value) {
  return value === "" ? null : value;
}

function numericOrNull(value, field) {
  if (value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be numeric.`);
  return parsed;
}

function resolveInputDirectory(values) {
  const argument = values.find((value) => value.startsWith("--input-dir="));
  return argument
    ? path.resolve(process.cwd(), argument.slice("--input-dir=".length))
    : DEFAULT_INPUT_DIRECTORY;
}

function repositoryRelativePath(targetPath) {
  return path.relative(path.resolve(process.cwd(), ".."), targetPath);
}
