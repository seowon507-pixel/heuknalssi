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
      areaCode: "2820000000",
      displayName: "인천광역시 남동구",
      stationId: "112",
      stationName: "인천",
      stationLatitude: 37.47772,
      stationLongitude: 126.6249,
      temperatureRegId: "11B20201",
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
    // 평창군에는 종관관측소가 대관령(100) 하나뿐이다. 지점명이 같은 평창(526)은
    // 방재(AWS) 지점이라 ASOS 일자료 조회에서 resultCode 03(자료 없음)을 돌려준다.
    // 대관령 관측소 주소가 '강원특별자치도 평창군 대관령면 경강로 5372'로
    // 군 안에 있으므로 이 지점을 쓴다.
    stationMapping({
      areaCode: "5176000000",
      displayName: "강원특별자치도 평창군",
      stationId: "100",
      stationName: "대관령",
      stationLatitude: 37.67713,
      stationLongitude: 128.71834,
      temperatureRegId: "11D10503",
      landRegId: "11D10000",
    }),
    // ── 서울특별시 25개 자치구 ─────────────────────────────────
    // 법정동코드: 카카오 주소 API의 b_code를 25개 구 전부 실제로 조회해
    //   확인했다(2026-07-31). 조회 로직이 10자리 코드의 앞 5자리로
    //   '<5자리>00000' 후보를 만들므로 구 단위 코드를 키로 쓴다.
    // 관측·평년 지점: 서울에 있는 종관관측소는 서울(108) 하나뿐이다.
    //   실제 ASOS 일자료 조회로 정상 응답을 확인했고, 내장 기후평년
    //   1991-2020 데이터셋에도 108이 12개월 전부 들어 있다.
    // 중기예보: 기온 구역은 서울 11B10101, 육상 구역은 서울·인천·경기
    //   공통 11B00000이며 두 코드 모두 실제 호출로 NORMAL_SERVICE를 받았다.
    // 토양: 농경지화학성 통계정보 V2를 25개 구 전부 조회해 논밭·시설·과수
    //   면적이 0이 아닌 것을 확인했다. 도시 지역이라 필지 수가 적으므로
    //   지역 분포일 뿐 내 밭의 실측값이 아니라는 기존 표시가 그대로 적용된다.
    ...[
      ["1111000000", "서울특별시 종로구"],
      ["1114000000", "서울특별시 중구"],
      ["1117000000", "서울특별시 용산구"],
      ["1120000000", "서울특별시 성동구"],
      ["1121500000", "서울특별시 광진구"],
      ["1123000000", "서울특별시 동대문구"],
      ["1126000000", "서울특별시 중랑구"],
      ["1129000000", "서울특별시 성북구"],
      ["1130500000", "서울특별시 강북구"],
      ["1132000000", "서울특별시 도봉구"],
      ["1135000000", "서울특별시 노원구"],
      ["1138000000", "서울특별시 은평구"],
      ["1141000000", "서울특별시 서대문구"],
      ["1144000000", "서울특별시 마포구"],
      ["1147000000", "서울특별시 양천구"],
      ["1150000000", "서울특별시 강서구"],
      ["1153000000", "서울특별시 구로구"],
      ["1154500000", "서울특별시 금천구"],
      ["1156000000", "서울특별시 영등포구"],
      ["1159000000", "서울특별시 동작구"],
      ["1162000000", "서울특별시 관악구"],
      ["1165000000", "서울특별시 서초구"],
      ["1168000000", "서울특별시 강남구"],
      ["1171000000", "서울특별시 송파구"],
      ["1174000000", "서울특별시 강동구"],
    ].map(([areaCode, displayName]) =>
      stationMapping({
        areaCode,
        displayName,
        stationId: "108",
        stationName: "서울",
        stationLatitude: 37.57142,
        stationLongitude: 126.9658,
        temperatureRegId: "11B10101",
        landRegId: "11B00000",
      }),
    ),
  ]),
);
