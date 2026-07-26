const REVIEWED_AT = "2026-07-25";
const VALID_FROM = "2026-07-01";
const VALID_TO = "2026-12-31";
const ADMIN_CODE_SOURCE = Object.freeze({
  sourceTitle: "행정표준코드관리시스템 법정동코드목록조회",
  sourceUrl: "https://www.code.go.kr/stdcode/regCodeL.do",
  version: "2026-07-25 조회",
});
const SOIL_CODE_SOURCE = Object.freeze({
  sourceTitle: "농경지화학성 통계정보 V2 법정동 코드 계약",
  sourceUrl: "https://www.data.go.kr/data/15144685/openapi.do",
  version: "1.0.0 (2025-11-04)",
});
const MID_REGION_SOURCE = Object.freeze({
  sourceTitle: "기상청 중기예보 구역코드",
  sourceUrl: "https://www.data.go.kr/data/15059468/openapi.do",
  version: "2025.12 공식 구역코드표",
});

function stationMapping({
  areaCode,
  displayName,
  stationId,
  stationName,
  stationLatitude,
  stationLongitude,
  temperatureRegId,
  landRegId,
}) {
  return [
    areaCode,
    {
      displayName,
      soil: {
        verified: true,
        code: areaCode,
        provenance: SOIL_CODE_SOURCE,
      },
      midForecast: {
        verified: true,
        temperatureRegId,
        landRegId,
        provenance: MID_REGION_SOURCE,
      },
      normalStation: {
        verified: true,
        id: stationId,
        name: stationName,
      },
      observationStation: {
        verified: true,
        id: stationId,
        name: stationName,
        latitude: stationLatitude,
        longitude: stationLongitude,
        stationMetadataVerified: true,
      },
      provenance: {
        sourceTitle: `기상자료개방포털 관측지점정보 — ${stationName}(${stationId})`,
        sourceUrl: `https://data.kma.go.kr/tmeta/stn/selectStnDetail.do?isSelectStn=Y&pgmNo=82&stdStnNo=${stationId}`,
        version: "기상청 관측지점 메타데이터 (2026-07-25 조회)",
        reviewedAt: REVIEWED_AT,
        validFrom: VALID_FROM,
        validTo: VALID_TO,
      },
      administrativeCodeProvenance: ADMIN_CODE_SOURCE,
      pendingModules: Object.freeze([]),
    },
  ];
}

/**
 * API 호출 없이 공식 정적 문서로 검수한 최소 지역 자산이다.
 * 동일 행정구역의 공식 기후평년·ASOS 지점과 중기예보 구역을 연결한다.
 * ASOS 거리는 이 파일에 저장하지 않고 주소가 확정된 시점에 공식 지점
 * 좌표와 필지 좌표 사이의 대권거리로 계산한다.
 */
export const REVIEWED_LOCATION_MAPPINGS = Object.freeze(
  Object.fromEntries([
    stationMapping({
      areaCode: "4717000000",
      displayName: "경상북도 안동시",
      stationId: "136",
      stationName: "안동",
      stationLatitude: 36.57293,
      stationLongitude: 128.70733,
      temperatureRegId: "11H10501",
      landRegId: "11H10000",
    }),
    stationMapping({
      areaCode: "4150000000",
      displayName: "경기도 이천시",
      stationId: "203",
      stationName: "이천",
      stationLatitude: 37.26399,
      stationLongitude: 127.48421,
      temperatureRegId: "11B20701",
      landRegId: "11B00000",
    }),
    stationMapping({
      areaCode: "4476000000",
      displayName: "충청남도 부여군",
      stationId: "236",
      stationName: "부여",
      stationLatitude: 36.27242,
      stationLongitude: 126.92078,
      temperatureRegId: "11C20501",
      landRegId: "11C20000",
    }),
    stationMapping({
      areaCode: "4721000000",
      displayName: "경상북도 영주시",
      stationId: "272",
      stationName: "영주",
      stationLatitude: 36.87183,
      stationLongitude: 128.51687,
      temperatureRegId: "11H10401",
      landRegId: "11H10000",
    }),
    stationMapping({
      areaCode: "4728000000",
      displayName: "경상북도 문경시",
      stationId: "273",
      stationName: "문경",
      stationLatitude: 36.62727,
      stationLongitude: 128.14879,
      temperatureRegId: "11H10301",
      landRegId: "11H10000",
    }),
    stationMapping({
      areaCode: "4773000000",
      displayName: "경상북도 의성군",
      stationId: "278",
      stationName: "의성",
      stationLatitude: 36.3561,
      stationLongitude: 128.68862,
      temperatureRegId: "11H10502",
      landRegId: "11H10000",
    }),
  ]),
);
