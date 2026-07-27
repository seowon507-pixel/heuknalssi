// 기상청 "우리나라 기후평년값(월별) 1991-2020" 엑셀을 어댑터가 읽는 JSON으로 변환한다.
//
// 이 저장소는 런타임 의존성이 0개다. xlsx 파서를 새로 설치하는 대신
// xlsx가 곧 ZIP + XML이라는 점을 이용해 zlib(내장)만으로 직접 읽는다.
// 빌드 타임 도구이므로 대상 파일 하나만 확실히 처리하면 충분하다.
import { inflateRawSync } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_XLSX = join(projectDirectory, "우리나라기후평년(월별)_1991.xlsx");
const OUTPUT_JSON = join(
  projectDirectory,
  "backend-v3",
  "runtime",
  "climate-normal-1991-2020.json",
);

const NORMAL_PERIOD = "1991-2020";
const MONTH_COUNT = 12;

// 상단 4행은 제목/영문/안내, 5행이 헤더, 6행부터 데이터다.
const HEADER_ROW = 5;
const FIRST_DATA_ROW = 6;

// 시트명 → 메트릭 키. 시트명은 워크북에 적힌 문자열과 정확히 일치해야 한다
// (예: "6. 일최저기온"의 공백, "30.지중온도(1.5m ~5.0m)"의 공백).
const SINGLE_BLOCK_SHEETS = Object.freeze([
  { sheet: "3.평균기온", metric: "meanTemperature", unit: "degC" },
  { sheet: "5.일최고기온", metric: "dailyMaxTemperature", unit: "degC" },
  { sheet: "6. 일최저기온", metric: "dailyMinTemperature", unit: "degC" },
  { sheet: "11.상대습도", metric: "relativeHumidity", unit: "percent" },
  { sheet: "12.강수량", metric: "precipitation", unit: "mm" },
  { sheet: "14.평균풍속", metric: "meanWindSpeed", unit: "mPerSec" },
  { sheet: "23.지면온도", metric: "groundSurfaceTemperature", unit: "degC" },
  { sheet: "24.지중온도(0.05m)", metric: "soilTemperature0_05m", unit: "degC" },
  { sheet: "25.지중온도(0.1m)", metric: "soilTemperature0_1m", unit: "degC" },
  { sheet: "26.지중온도(0.2m)", metric: "soilTemperature0_2m", unit: "degC" },
  { sheet: "27.지중온도(0.3m)", metric: "soilTemperature0_3m", unit: "degC" },
  { sheet: "28.지중온도(0.5m)", metric: "soilTemperature0_5m", unit: "degC" },
  { sheet: "29.지중온도(1.0m)", metric: "soilTemperature1_0m", unit: "degC" },
]);

// 이 시트만 깊이별 블록이 세로로 쌓여 있다. 블록 라벨 행 다음 행이 헤더다.
const MULTI_BLOCK_SHEET = Object.freeze({
  sheet: "30.지중온도(1.5m ~5.0m)",
  unit: "degC",
  blocks: Object.freeze({
    "1.5m": "soilTemperature1_5m",
    "3.0m": "soilTemperature3_0m",
    "5.0m": "soilTemperature5_0m",
  }),
});

const workbook = await openXlsx(SOURCE_XLSX);
const stations = new Map();
const metricUnits = {};

for (const definition of SINGLE_BLOCK_SHEETS) {
  const rows = workbook.sheet(definition.sheet);
  const header = rows.get(HEADER_ROW) ?? [];
  assertMonthlyHeader(header, definition.sheet);
  metricUnits[definition.metric] = definition.unit;
  let rowNumber = FIRST_DATA_ROW;
  while (rows.has(rowNumber)) {
    ingestRow(rows.get(rowNumber), definition.metric, definition.sheet);
    rowNumber += 1;
  }
}

ingestMultiBlockSheet();

const stationList = [...stations.values()].sort(
  (left, right) => Number(left.stationId) - Number(right.stationId),
);
const dataset = {
  normalPeriod: NORMAL_PERIOD,
  sourceName: "기상청 기후평년 1991~2020",
  sourceFile: "우리나라기후평년(월별)_1991.xlsx",
  sourceUrl: "https://data.kma.go.kr/climate/average30Years/selectAverage30YearsMonthList.do",
  metricUnits,
  stations: Object.fromEntries(
    stationList.map((station) => [station.stationId, station]),
  ),
};

await writeFile(OUTPUT_JSON, `${JSON.stringify(dataset, null, 1)}\n`, "utf8");

report();

function ingestRow(row, metric, sheetName) {
  const stationId = String(row?.[0] ?? "").trim();
  if (!/^\d{1,4}$/u.test(stationId)) return;
  const stationName = String(row?.[1] ?? "").trim();
  const values = [];
  for (let offset = 0; offset < MONTH_COUNT; offset += 1) {
    values.push(roundValue(row?.[2 + offset]));
  }
  if (values.every((value) => value === null)) return;

  let station = stations.get(stationId);
  if (station === undefined) {
    station = { stationId, stationName, metrics: {} };
    stations.set(stationId, station);
  }
  if (station.stationName === "" && stationName !== "") {
    station.stationName = stationName;
  }
  if (station.metrics[metric] !== undefined) {
    throw new Error(
      `${sheetName}: 지점 ${stationId}의 ${metric}이 중복으로 나타났습니다.`,
    );
  }
  station.metrics[metric] = values;
}

function ingestMultiBlockSheet() {
  const rows = workbook.sheet(MULTI_BLOCK_SHEET.sheet);
  const rowNumbers = [...rows.keys()].sort((left, right) => left - right);
  let activeMetric = null;

  for (const rowNumber of rowNumbers) {
    const row = rows.get(rowNumber);
    const first = String(row?.[0] ?? "").trim();
    const blockMetric = MULTI_BLOCK_SHEET.blocks[first];
    if (blockMetric !== undefined) {
      activeMetric = blockMetric;
      metricUnits[blockMetric] = MULTI_BLOCK_SHEET.unit;
      continue;
    }
    if (first === "지점번호" || activeMetric === null) continue;
    ingestRow(row, activeMetric, MULTI_BLOCK_SHEET.sheet);
  }

  const found = Object.values(MULTI_BLOCK_SHEET.blocks).filter(
    (metric) => metricUnits[metric] !== undefined,
  );
  if (found.length !== Object.keys(MULTI_BLOCK_SHEET.blocks).length) {
    throw new Error(
      `${MULTI_BLOCK_SHEET.sheet}: 깊이 블록을 모두 찾지 못했습니다 (${found.length}개).`,
    );
  }
}

function assertMonthlyHeader(header, sheetName) {
  const expected = [
    "지점번호",
    "지점명",
    ...Array.from({ length: MONTH_COUNT }, (_, index) => `${index + 1}월`),
  ];
  const actual = header
    .slice(0, expected.length)
    .map((value) => String(value ?? "").trim());
  for (const [index, label] of expected.entries()) {
    if (actual[index] !== label) {
      throw new Error(
        `${sheetName}: 헤더가 예상과 다릅니다. ${index}번 열이 "${actual[index]}" (기대: "${label}")`,
      );
    }
  }
}

// 엑셀 부동소수 잡음(예: 20.100000000000001)을 원본 표기 정밀도로 되돌린다.
function roundValue(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(2));
}

function report() {
  const stationCount = stationList.length;
  const metricNames = Object.keys(metricUnits);
  console.log(`입력  : ${SOURCE_XLSX.replace(`${projectDirectory}/`, "")}`);
  console.log(`출력  : ${OUTPUT_JSON.replace(`${projectDirectory}/`, "")}`);
  console.log(`지점  : ${stationCount}개`);
  console.log(`메트릭: ${metricNames.length}개 — ${metricNames.join(", ")}`);

  const withFullMean = stationList.filter(
    (station) =>
      Array.isArray(station.metrics.meanTemperature) &&
      station.metrics.meanTemperature.every((value) => value !== null),
  ).length;
  console.log(`평균기온 12개월 완전한 지점: ${withFullMean}개`);

  console.log("\n엑셀 대조용 표본 (7월 = 배열 인덱스 6)");
  console.log("지점  이름      7월평균기온  7월강수량  7월상대습도");
  for (const stationId of ["90", "108", "119", "136", "184"]) {
    const station = stations.get(stationId);
    if (station === undefined) {
      console.log(`${stationId.padEnd(5)} (데이터 없음)`);
      continue;
    }
    const cell = (metric) => {
      const values = station.metrics[metric];
      return values?.[6] ?? "—";
    };
    console.log(
      `${stationId.padEnd(5)} ${station.stationName.padEnd(8)} ` +
        `${String(cell("meanTemperature")).padStart(9)}  ` +
        `${String(cell("precipitation")).padStart(9)}  ` +
        `${String(cell("relativeHumidity")).padStart(9)}`,
    );
  }
}

// ── 최소 xlsx 리더 (ZIP 중앙 디렉터리 + inflateRaw + 시트 XML) ──────────

async function openXlsx(path) {
  const entries = readZipEntries(await readFile(path));
  const text = (name) => {
    const buffer = entries.get(name);
    if (buffer === undefined) throw new Error(`xlsx에 ${name}이 없습니다.`);
    return buffer.toString("utf8");
  };

  const sharedStrings = parseSharedStrings(
    entries.has("xl/sharedStrings.xml") ? text("xl/sharedStrings.xml") : "",
  );
  const relationships = new Map(
    [
      ...text("xl/_rels/workbook.xml.rels").matchAll(
        /Id="([^"]+)"[^>]*Target="([^"]+)"/gu,
      ),
    ].map((match) => [match[1], match[2].replace(/^\/?xl\//u, "").replace(/^\//u, "")]),
  );
  const sheetPaths = new Map(
    [
      ...text("xl/workbook.xml").matchAll(
        /<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/gu,
      ),
    ].map((match) => [decodeXml(match[1]), relationships.get(match[2])]),
  );

  return {
    sheetNames: () => [...sheetPaths.keys()],
    sheet(name) {
      const target = sheetPaths.get(name);
      if (target === undefined) {
        throw new Error(
          `시트 "${name}"을 찾을 수 없습니다. 사용 가능: ${[...sheetPaths.keys()].join(" / ")}`,
        );
      }
      return parseSheet(text(`xl/${target}`), sharedStrings);
    },
  };
}

function parseSharedStrings(xml) {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/gu)].map((match) =>
    decodeXml(match[1].replace(/<[^>]+>/gu, "")),
  );
}

/** 행 번호 → 열 인덱스 정렬된 값 배열. 빈 셀은 배열 구멍이 아니라 ""로 채운다. */
function parseSheet(xml, sharedStrings) {
  const rows = new Map();
  for (const rowMatch of xml.matchAll(
    /<row[^>]*\sr="(\d+)"[^>]*>([\s\S]*?)<\/row>/gu,
  )) {
    const rowNumber = Number(rowMatch[1]);
    const cells = [];
    for (const cellMatch of rowMatch[2].matchAll(
      /<c\s+r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/gu,
    )) {
      const columnIndex = columnToIndex(cellMatch[1]);
      cells[columnIndex] = readCell(cellMatch[2], cellMatch[3], sharedStrings);
    }
    for (let index = 0; index < cells.length; index += 1) {
      if (cells[index] === undefined) cells[index] = "";
    }
    if (cells.length > 0) rows.set(rowNumber, cells);
  }
  return rows;
}

function readCell(attributes, inner, sharedStrings) {
  const type = /\st="([^"]+)"/u.exec(attributes)?.[1] ?? "n";
  if (type === "inlineStr") {
    return decodeXml(inner.replace(/<[^>]+>/gu, ""));
  }
  const value = /<v>([\s\S]*?)<\/v>/u.exec(inner)?.[1];
  if (value === undefined) return "";
  if (type === "s") return sharedStrings[Number(value)] ?? "";
  return decodeXml(value);
}

function columnToIndex(letters) {
  let index = 0;
  for (const character of letters) {
    index = index * 26 + (character.charCodeAt(0) - 64);
  }
  return index - 1;
}

function decodeXml(text) {
  return text
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gu, "&");
}

/**
 * ZIP 중앙 디렉터리를 읽어 엔트리명 → 원본 버퍼 맵을 만든다.
 * 대상 파일이 2MB대라 ZIP64는 고려하지 않는다(발견 시 명시적으로 실패).
 */
function readZipEntries(buffer) {
  const endOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  let offset = buffer.readUInt32LE(endOffset + 16);
  if (offset === 0xffffffff) {
    throw new Error("ZIP64 아카이브는 지원하지 않습니다.");
  }

  const entries = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("ZIP 중앙 디렉터리 시그니처가 올바르지 않습니다.");
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");

    entries.set(name, readLocalEntry(buffer, localOffset, method, compressedSize));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readLocalEntry(buffer, localOffset, method, compressedSize) {
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error("ZIP 로컬 헤더 시그니처가 올바르지 않습니다.");
  }
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + compressedSize);
  if (method === 0) return raw;
  if (method === 8) return inflateRawSync(raw);
  throw new Error(`지원하지 않는 ZIP 압축 방식: ${method}`);
}

function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("ZIP 종료 레코드를 찾지 못했습니다. xlsx 파일이 맞습니까?");
}
