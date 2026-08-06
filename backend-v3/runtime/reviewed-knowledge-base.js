import { readFileSync } from "node:fs";

import { REVIEWED_CROP_SOURCES } from "./reviewed-crop-rules.js";

// 흙톡 RAG 코퍼스.
//
// 이 파일은 분석 결과가 아니라 "재배 참고 지식"만 담는다. 분석 근거는
// src/application/assistant.js의 buildAssistantCatalog가 실제 분석 응답에서
// 뽑으며, 여기 있는 문단은 그 근거를 사용자가 이해하도록 돕는 배경 설명이다.
//
// 작성 규칙 (검수자와 공유하는 계약):
//   1. 농약·약제의 제품명·희석배수·살포량을 쓰지 않는다.
//   2. 비료 종류와 사용량을 숫자로 쓰지 않는다. 토양검정으로 안내한다.
//   3. 병명을 확정하거나 사진으로 진단하는 문장을 쓰지 않는다.
//      관찰 지점과 기록 방법만 쓴다.
//   4. 수치 임계값은 reviewed-crop-rules.js가 이미 검수한 값만 인용한다.
//   5. reviewState가 "REVIEWED"인 문단만 운영에서 노출된다.
//
// reviewState:
//   DRAFT    — 초안. 농업기술센터·지도사 검수를 받기 전 상태.
//              ALLOW_DRAFT_KNOWLEDGE=true일 때만 노출되고 화면에 배지가 붙는다.
//   REVIEWED — 검수 완료. reviewedBy와 reviewedAt을 반드시 채운다.

export const KNOWLEDGE_BASE_VERSION = "kb-v1-2026-08-04";

const DRAFTED_AT = "2026-08-04";

// 이미지는 문단에 경로나 URL을 직접 박지 않고 이 레지스트리의 imageId로만
// 참조한다. 브라우저는 /api/knowledge-images/{imageId}만 호출하므로 사용자
// 입력이 fetch나 파일 읽기 대상이 될 수 없다.
//
// 이미지 출처는 두 가지다.
//
//   asset — knowledge-images/ 폴더의 자체 제작 SVG 도해. 기동 시 한 번 읽어
//           메모리에 두므로 네트워크도 요청별 파일 I/O도 없다. 라이선스가
//           프로젝트 소유라 상업적 배포에도 제약이 없다.
//   url   — 외부 기관의 공개 이미지. KNOWLEDGE_IMAGE_HOST_ALLOWLIST에 있는
//           호스트만 허용하고 백엔드가 대신 받아 전달한다. NCPMS 도감정보
//           OpenAPI는 CC BY-NC 2.0(상업적 이용금지)이므로 상업적 배포에는
//           쓸 수 없다. 공개 URL을 추측해 채우지 않고, 사람이 확인한 값만
//           적은 뒤 npm run verify:knowledge-images로 검증한다.
//
// 둘 다 비어 있으면 화면은 "이미지 자료 미연결"로 표시하고 설명만 보여준다.
export { KNOWLEDGE_IMAGE_HOST_ALLOWLIST } from "../src/application/knowledge-images.js";

const DIAGRAM_CREDIT = "흙날씨 자체 제작 도해";
const DIAGRAM_LICENCE = "프로젝트 소유 (자체 제작)";

function diagram({ imageId, asset, alt, caption }) {
  return Object.freeze({
    imageId,
    // 도해는 11개·각 2~3 KiB이므로 기동 시 모두 읽어 두는 편이 단순하고, 요청
    // 경로에서 파일 시스템을 건드리지 않으므로 경로 이탈 위험도 없다.
    body: readFileSync(new URL(`./knowledge-images/${asset}`, import.meta.url)),
    contentType: "image/svg+xml",
    url: null,
    alt,
    caption,
    credit: DIAGRAM_CREDIT,
    licence: DIAGRAM_LICENCE,
  });
}

// alt와 caption은 "무엇이 보이는 사진"이 아니라 "어디를 어떤 순서로 보라"로
// 쓴다. 도해는 증상을 사실적으로 그리지 않으므로, 사용자가 자기 작물을 그림과
// 맞춰 병을 확정하도록 유도해서는 안 된다.
export const KNOWLEDGE_IMAGES = Object.freeze(
  Object.fromEntries(
    [
      diagram({
        imageId: "APPLE_BLOSSOM_FROST",
        asset: "blossom-frost-check.svg",
        alt: "꽃 중심의 암술머리가 연한 녹색인 경우와 갈색인 경우를 나란히 비교한 도해",
        caption: "꽃을 열어 중심(암술머리) 색을 비교하는 지점입니다.",
      }),
      diagram({
        imageId: "APPLE_SUNBURN",
        asset: "fruit-sunburn-side.svg",
        alt: "과실에서 직사광선을 받는 면과 그늘 면을 구분해 표시한 도해",
        caption: "직사광선을 받는 면부터 확인하고 그늘 면과 비교합니다.",
      }),
      diagram({
        imageId: "PEAR_LEAF_WET_SPOT",
        asset: "leaf-spot-compare.svg",
        alt: "같은 잎을 어제와 오늘 같은 각도로 비교해 반점 범위 변화를 보는 도해",
        caption: "같은 잎을 같은 각도로 다시 보고 범위가 넓어졌는지 비교합니다.",
      }),
      diagram({
        imageId: "CUCUMBER_LEAF_UNDERSIDE",
        asset: "leaf-underside-check.svg",
        alt: "잎을 뒤집어 앞면과 뒷면을 확인하는 순서를 표시한 도해",
        caption: "앞면만 보면 놓치므로 잎을 뒤집어 뒷면까지 확인합니다.",
      }),
      diagram({
        imageId: "POTATO_LOWER_LEAF_SPOT",
        asset: "lower-leaf-first.svg",
        alt: "포기의 아랫잎에서 위잎으로 올라가며 확인하는 순서를 번호로 표시한 도해",
        caption: "아랫잎부터 위로 올라가며 확인하고 구역 쏠림을 함께 봅니다.",
      }),
      diagram({
        imageId: "LETTUCE_TIPBURN",
        asset: "leaf-tip-check.svg",
        alt: "포기를 위에서 본 모습에 겉잎 끝, 중간잎, 포기 중심의 확인 순서를 표시한 도해",
        caption: "겉잎 끝부터 보고 중간잎과 포기 중심까지 순서대로 확인합니다.",
      }),
      diagram({
        imageId: "SOIL_DRAINAGE_PUDDLE",
        asset: "drainage-check.svg",
        alt: "밭 단면에서 물이 남는 낮은 구역과 막힌 배수로를 표시한 도해",
        caption: "비가 그친 뒤 물이 남아 있는 위치가 배수 점검 지점입니다.",
      }),
      diagram({
        imageId: "SOIL_TEST_SAMPLING",
        asset: "soil-sampling-points.svg",
        alt: "밭을 위에서 본 모습에 여섯 곳의 채취 지점과 한 봉지로 섞는 과정을 표시한 도해",
        caption: "한 지점만 파지 않고 밭 전체에서 골고루 채취해 섞습니다.",
      }),
      diagram({
        imageId: "FACILITY_VENTILATION",
        asset: "facility-ventilation.svg",
        alt: "하우스 단면에서 천창과 측창을 함께 열었을 때의 공기 흐름을 표시한 도해",
        caption: "측창과 천창을 함께 열어 공기가 한 방향으로 흐르게 합니다.",
      }),
      diagram({
        imageId: "OBSERVATION_PHOTO_SET",
        asset: "photo-record-method.svg",
        alt: "포기 전체, 증상 부위, 잎 뒷면 세 장과 촬영 날짜를 함께 남기는 방법을 표시한 도해",
        caption: "전체·증상 부위·잎 뒷면 세 장을 날짜와 함께 남깁니다.",
      }),
      diagram({
        imageId: "COLD_AIR_POOLING",
        asset: "cold-air-pooling.svg",
        alt: "지형 단면에서 찬 공기가 낮은 구역에 고여 예보보다 더 낮아질 수 있음을 표시한 도해",
        caption: "찬 공기가 고이는 낮은 구역이 저온 피해 확인 지점입니다.",
      }),
    ].map((entry) => [entry.imageId, entry]),
  ),
);

function passage({
  id,
  title,
  text,
  crops = [],
  topics,
  keywords,
  imageId = null,
  source,
  sourcePageOrTable,
  reviewState = "DRAFT",
}) {
  return Object.freeze({
    id,
    title,
    text,
    crops: Object.freeze(crops),
    topics: Object.freeze(topics),
    keywords: Object.freeze(keywords),
    imageId,
    reviewState,
    reviewedBy: null,
    source: Object.freeze({
      ...source,
      sourcePageOrTable,
      reviewedAt: reviewState === "REVIEWED" ? DRAFTED_AT : null,
      draftedAt: DRAFTED_AT,
    }),
  });
}

const SOIL_SOURCE = Object.freeze({
  sourceTitle: "농사로 흙토람 토양검정 안내",
  sourceUrl: "https://soil.rda.go.kr/soil/soilTesting/soilTesting.jsp",
});

const RDA_SOURCE = Object.freeze({
  sourceTitle: "농촌진흥청 농업기술포털",
  sourceUrl: "https://www.nongsaro.go.kr/portal/ps/psb/psbk/kidofcomdtyPrdlstList.ps?menuId=PS00067",
});

// ── 공통: 토양 ──────────────────────────────────────────────
const SOIL_PASSAGES = [
  passage({
    id: "KB_SOIL_PH_MEANING",
    title: "토양 산도(pH)가 무엇을 뜻하나요",
    text:
      "토양 pH는 흙이 산성인지 알칼리성인지 나타내는 값입니다. 작물마다 뿌리가 양분을 잘 흡수하는 pH 구간이 달라서, 같은 양분이 흙에 있어도 pH가 맞지 않으면 작물이 쓰지 못할 수 있습니다. 이 서비스가 보여주는 지역 pH는 공개 통계이므로 내 밭의 실제 값은 필지 토양검정으로 확인해야 합니다.",
    topics: ["SOIL", "SOURCE"],
    keywords: ["ph", "산도", "토양", "흙", "산성", "알칼리", "양분", "흡수"],
    source: SOIL_SOURCE,
    sourcePageOrTable: "토양검정 항목 안내 — 산도",
  }),
  passage({
    id: "KB_SOIL_EC_MEANING",
    title: "토양 전기전도도(EC)가 무엇을 뜻하나요",
    text:
      "EC는 흙에 녹아 있는 염류의 양을 전기가 통하는 정도로 나타낸 값입니다. EC가 높으면 뿌리가 물을 빨아들이기 어려워져 잎이 시들거나 생육이 멈출 수 있고, 시설재배처럼 비가 씻어내지 못하는 곳에서 특히 올라갑니다. 적정 구간과 낮추는 방법은 필지 토양검정 결과에 따라 달라집니다.",
    topics: ["SOIL"],
    keywords: ["ec", "전기전도도", "염류", "염류집적", "토양", "시설", "시들"],
    source: SOIL_SOURCE,
    sourcePageOrTable: "토양검정 항목 안내 — 전기전도도",
  }),
  passage({
    id: "KB_SOIL_TEST_HOW",
    title: "토양검정은 어떻게 받나요",
    text:
      "토양검정은 시·군 농업기술센터에서 무료 또는 저렴하게 받을 수 있습니다. 흙은 한 지점만 파지 않고 밭 전체에서 대여섯 군데 이상 표토를 걷어내고 뿌리가 자라는 깊이에서 채취해 한데 섞은 뒤 한 봉지로 제출합니다. 결과가 나오면 이 앱의 토양검정 입력란에 등록해 분석에 반영할 수 있습니다.",
    topics: ["SOIL", "ACTION", "SOURCE"],
    keywords: ["토양검정", "검정", "농업기술센터", "채취", "시료", "흙", "신청"],
    imageId: "SOIL_TEST_SAMPLING",
    source: SOIL_SOURCE,
    sourcePageOrTable: "토양검정 신청 절차와 시료 채취 방법",
  }),
  passage({
    id: "KB_SOIL_DRAINAGE_CHECK",
    title: "물 빠짐(배수)은 어떻게 확인하나요",
    text:
      "배수는 비가 그친 뒤에 확인하는 것이 가장 정확합니다. 비가 멈춘 다음에도 물이 고여 있는 위치, 배수로가 흙이나 잔재로 막힌 구간, 뿌리 주변이 계속 젖어 있는 곳을 표시해 두세요. 같은 자리가 반복해서 젖으면 그 구간의 물 흐름을 먼저 확보한 뒤 다음 비 예보에 다시 확인합니다.",
    topics: ["SOIL", "ACTION", "RECHECK"],
    keywords: ["배수", "물빠짐", "물 빠짐", "고인물", "과습", "배수로", "침수"],
    imageId: "SOIL_DRAINAGE_PUDDLE",
    source: RDA_SOURCE,
    sourcePageOrTable: "농경지 배수 관리 일반 지침",
  }),
  passage({
    id: "KB_SOIL_ORGANIC_MATTER",
    title: "유기물 함량은 왜 중요한가요",
    text:
      "유기물은 흙이 물과 양분을 붙잡아 두는 힘과 뿌리가 뻗을 공간을 함께 좌우합니다. 유기물이 적으면 비가 오면 금방 물이 빠지고 마르면 금방 굳어서, 같은 관수·같은 시비를 해도 작물 반응이 일정하지 않게 됩니다. 다만 넣어야 할 퇴비의 종류와 양은 토양검정 결과 없이 정하지 않습니다.",
    topics: ["SOIL"],
    keywords: ["유기물", "퇴비", "부식", "보수력", "토성", "굳", "단단"],
    source: SOIL_SOURCE,
    sourcePageOrTable: "토양검정 항목 안내 — 유기물",
  }),
  passage({
    id: "KB_SOIL_REGIONAL_VS_FIELD",
    title: "지역 토양 통계와 내 밭 값은 어떻게 다른가요",
    text:
      "이 앱이 기본으로 보여주는 토양 값은 시·군 단위 공개 통계의 대표값이라 내 밭에서 직접 측정한 값이 아닙니다. 같은 읍·면 안에서도 밭마다 pH와 유기물이 크게 다를 수 있어서, 통계만으로 시비나 개량을 결정하면 과부족이 생길 수 있습니다. 그래서 이 서비스는 통계값을 참고 범위로만 표시하고 필지 토양검정을 별도로 안내합니다.",
    topics: ["SOIL", "SOURCE"],
    keywords: ["지역", "통계", "대표값", "필지", "내밭", "내 밭", "실측", "차이"],
    source: SOIL_SOURCE,
    sourcePageOrTable: "토양환경정보 활용 범위",
  }),
];

// ── 공통: 날씨 ──────────────────────────────────────────────
const WEATHER_PASSAGES = [
  passage({
    id: "KB_WEATHER_FROST_PRINCIPLE",
    title: "서리와 저온 피해는 어떤 조건에서 생기나요",
    text:
      "맑고 바람이 없는 밤에 지면의 열이 빠져나가면 예보 최저기온보다 지면 근처가 더 차가워집니다. 그래서 예보가 영상이어도 낮은 지형이나 찬 공기가 모이는 골짜기 쪽 밭은 서리가 내릴 수 있습니다. 밭 안에서도 가장 낮은 구역과 바람이 막힌 구역을 저온 피해 확인 지점으로 정해 두세요.",
    topics: ["WEATHER", "ACTION"],
    keywords: ["서리", "저온", "동해", "냉해", "최저기온", "영하", "찬공기", "골짜기"],
    imageId: "COLD_AIR_POOLING",
    source: RDA_SOURCE,
    sourcePageOrTable: "저온·서리 피해 예방 일반 지침",
  }),
  passage({
    id: "KB_WEATHER_HEAT_PRINCIPLE",
    title: "고온이 이어지면 작물에 어떤 일이 생기나요",
    text:
      "기온이 높으면 잎에서 빠져나가는 수분이 뿌리가 흡수하는 양보다 많아져 한낮에 시들거나 생육이 멈출 수 있습니다. 흙이 마른 상태에서 고온이 겹치면 피해가 커지므로, 고온 예보 전에 토양 수분을 확인하는 것이 순서상 먼저입니다. 물을 주는 시간은 한낮보다 이른 아침이나 해가 진 뒤가 유리합니다.",
    topics: ["WEATHER", "ACTION"],
    keywords: ["고온", "폭염", "더위", "시들", "관수", "물주기", "수분", "일소"],
    source: REVIEWED_CROP_SOURCES.APPLE_HEAT_GUIDE,
    sourcePageOrTable: "고온기 농작물 관리요령 — 관수와 차광",
  }),
  passage({
    id: "KB_WEATHER_WET_LEAF_DURATION",
    title: "잎이 젖어 있는 시간은 왜 중요한가요",
    text:
      "잎 표면이 물기에 젖은 채로 오래 있으면 병이 자리 잡기 쉬운 환경이 됩니다. 강수 자체보다 비가 그친 뒤에도 잎이 마르지 않는 시간, 아침 이슬이 늦게까지 남는 조건, 통풍이 막혀 습기가 갇히는 구간이 더 중요합니다. 그래서 비 예보가 있으면 물 흐름과 통풍을 먼저 확보하고, 비가 그친 다음 날 잎 상태를 다시 확인합니다.",
    topics: ["WEATHER", "ACTION", "RECHECK"],
    keywords: ["강수", "비", "습도", "과습", "이슬", "통풍", "환기", "젖", "병"],
    source: RDA_SOURCE,
    sourcePageOrTable: "강우기 작물 관리 일반 지침",
  }),
  passage({
    id: "KB_WEATHER_WIND",
    title: "강풍 예보에는 무엇을 확인하나요",
    text:
      "강풍은 잎과 줄기를 찢고 지주·피복재를 흔들어 작물이 아니라 시설에서 먼저 피해가 나타나는 경우가 많습니다. 예보 전에는 지주와 유인끈이 헐거워진 곳, 피복재가 뜬 곳, 바람이 통로처럼 지나가는 구간을 확인하세요. 바람이 지난 뒤에는 상처가 난 잎과 줄기가 젖은 상태로 오래 있지 않도록 통풍을 함께 확인합니다.",
    topics: ["WEATHER", "ACTION"],
    keywords: ["강풍", "바람", "태풍", "지주", "유인", "피복", "찢", "쓰러"],
    source: RDA_SOURCE,
    sourcePageOrTable: "강풍·태풍 대비 일반 지침",
  }),
  passage({
    id: "KB_WEATHER_FORECAST_VS_FIELD",
    title: "예보와 내 밭 실제 날씨가 다른 이유",
    text:
      "예보는 격자 단위 평균이라 밭 하나 크기의 지형 차이를 담지 못합니다. 경사 방향, 주변 산과 건물, 물가와의 거리에 따라 같은 격자 안에서도 기온이 몇 도씩 벌어질 수 있습니다. 예보는 언제 확인할지를 정하는 신호로 쓰고, 실제 값은 밭에 둔 온도계나 현장 관찰로 보완하는 것이 정확합니다.",
    topics: ["WEATHER", "SOURCE"],
    keywords: ["예보", "격자", "정확", "다르", "차이", "기상청", "온도계"],
    source: RDA_SOURCE,
    sourcePageOrTable: "기상정보 활용 범위",
  }),
  passage({
    id: "KB_WEATHER_FACILITY_LIMIT",
    title: "시설재배에서 실외 예보를 어떻게 봐야 하나요",
    text:
      "실외 예보는 하우스 안의 기온·습도를 그대로 알려주지 않습니다. 맑은 날 시설 내부는 실외보다 훨씬 더워지고, 밤에는 보온 상태에 따라 실외와 비슷하게 떨어질 수도 있습니다. 그래서 실외 예보는 환기·보온을 언제 할지 판단하는 신호로만 쓰고, 내부 값은 센서나 온습도계로 확인해야 합니다.",
    topics: ["WEATHER", "SOURCE"],
    keywords: ["시설", "하우스", "내부", "환기", "보온", "센서", "실외", "예보"],
    imageId: "FACILITY_VENTILATION",
    source: REVIEWED_CROP_SOURCES.CUCUMBER_FACILITY_RISK,
    sourcePageOrTable: "시설 내부 환경 확인 필요성",
  }),
];

// ── 공통: 관찰과 기록 ────────────────────────────────────────
const OBSERVATION_PASSAGES = [
  passage({
    id: "KB_OBS_PHOTO_METHOD",
    title: "이상 증상은 어떻게 기록해야 도움이 되나요",
    text:
      "증상은 같은 자리를 같은 각도와 같은 거리에서 반복 촬영해야 번지는지 판단할 수 있습니다. 전체 포기가 보이는 사진 한 장, 증상 부위를 가까이 찍은 사진 한 장, 잎 뒷면 사진 한 장을 함께 남기고 날짜를 적어 두세요. 이 기록은 농업기술센터에 문의할 때 그대로 쓸 수 있습니다.",
    topics: ["ACTION", "SOURCE"],
    keywords: ["사진", "기록", "촬영", "증상", "관찰", "일지", "각도"],
    imageId: "OBSERVATION_PHOTO_SET",
    source: RDA_SOURCE,
    sourcePageOrTable: "현장 관찰 기록 방법",
  }),
  passage({
    id: "KB_OBS_SPREAD_PATTERN",
    title: "번지는 모양으로 무엇을 구분할 수 있나요",
    text:
      "증상이 밭 한쪽에 몰려 있는지 고르게 퍼져 있는지가 확인 순서를 정하는 데 도움이 됩니다. 한 구역에 몰려 있으면 그 구역의 물 흐름·통풍·바람 방향 같은 환경 조건을 먼저 확인하고, 밭 전체에 고르면 관수나 재배 관리 전반을 확인합니다. 어느 쪽이든 병명 확정은 현장 진단이 필요하므로 농업기술센터에 기록과 함께 문의하세요.",
    topics: ["ACTION", "STATUS"],
    keywords: ["번지", "확산", "한쪽", "구역", "전체", "패턴", "원인"],
    source: RDA_SOURCE,
    sourcePageOrTable: "현장 관찰 기록 방법",
  }),
  passage({
    id: "KB_OBS_WHEN_TO_ASK_CENTER",
    title: "농업기술센터에는 언제 문의해야 하나요",
    text:
      "증상 범위가 어제보다 넓어졌을 때, 여러 포기에서 같은 증상이 동시에 보일 때, 원인을 짐작할 수 없을 때는 스스로 판단하기보다 문의하는 편이 빠릅니다. 문의할 때는 작물·품종, 심은 날짜, 최근 관수와 작업 내용, 증상 사진과 발생 날짜를 함께 준비하세요. 농약과 비료는 이 단계에서 처방을 받는 것이 안전합니다.",
    topics: ["ACTION", "SOURCE"],
    keywords: ["문의", "농업기술센터", "상담", "진단", "처방", "전문가"],
    source: RDA_SOURCE,
    sourcePageOrTable: "현장기술지원 문의 절차",
  }),
];

// ── 사과 ────────────────────────────────────────────────────
const APPLE_PASSAGES = [
  passage({
    id: "KB_APPLE_BLOSSOM_FROST",
    title: "사과 개화기 저온은 어디를 보나요",
    text:
      "개화기에 저온을 겪으면 꽃 중심의 암술머리가 갈색으로 변해 열매가 달리지 않을 수 있습니다. 저온 예보가 지난 다음 날 아침에 꽃을 열어 중심부 색을 확인하고, 밭에서 가장 낮은 구역과 바람이 막힌 구역을 먼저 보세요. 갈변한 꽃의 비율을 구역별로 적어 두면 이후 결실 판단에 쓸 수 있습니다.",
    crops: ["APPLE"],
    topics: ["WEATHER", "ACTION", "RECHECK"],
    keywords: ["사과", "개화", "꽃", "저온", "서리", "암술", "갈변", "결실"],
    imageId: "APPLE_BLOSSOM_FROST",
    source: REVIEWED_CROP_SOURCES.APPLE,
    sourcePageOrTable: "생육단계 — 개화기 저온 피해",
  }),
  passage({
    id: "KB_APPLE_SUNBURN",
    title: "사과 햇볕 데임은 어떻게 구분하나요",
    text:
      "최고기온이 30℃ 이상으로 올라가면 직사광선을 받는 과실 표면이 데어 색이 바래고 나중에 딱딱하게 굳습니다. 병으로 생긴 반점과 달리 해가 강하게 닿는 남서쪽 면에 몰려 나타나고 경계가 비교적 뚜렷합니다. 고온 예보 전에 토양 수분을 확인하고, 미세살수나 간이 차광시설이 있으면 작동 상태를 점검하세요.",
    crops: ["APPLE"],
    topics: ["WEATHER", "ACTION"],
    keywords: ["사과", "일소", "햇볕", "데임", "고온", "30", "차광", "과실"],
    imageId: "APPLE_SUNBURN",
    source: REVIEWED_CROP_SOURCES.APPLE_HEAT_GUIDE,
    sourcePageOrTable: "고온기 과수 관리 — 일소 피해",
  }),
  passage({
    id: "KB_APPLE_CLIMATE_RANGE",
    title: "사과는 어떤 기후에서 잘 자라나요",
    text:
      "사과는 연평균기온 8~11℃ 구간을 생육 적온으로 보고, 6~14℃까지를 재배 가능 범위로 봅니다. 이 서비스가 기후 항목에서 보여주는 편차는 이 검수된 범위와 우리 지역 기후평년값을 비교한 결과입니다. 다만 연평균값이 맞아도 개화기 저온이나 여름 고온 같은 특정 시기 위험은 따로 확인해야 합니다.",
    crops: ["APPLE"],
    topics: ["WEATHER", "STATUS"],
    keywords: ["사과", "기후", "연평균", "적온", "8", "11", "기온", "평년"],
    source: REVIEWED_CROP_SOURCES.APPLE,
    sourcePageOrTable: "기상생태 — 연평균 8~11℃, 재배 가능 6~14℃",
  }),
  passage({
    id: "KB_APPLE_SOIL_PH",
    title: "사과에 맞는 토양 산도는 얼마인가요",
    text:
      "사과는 토양 pH 5.8~6.3 구간을 적정 범위로 봅니다. 이보다 낮으면 뿌리 생육과 양분 흡수가 나빠지고, 높으면 미량원소가 잘 흡수되지 않을 수 있습니다. 다만 석회 같은 개량 자재의 종류와 양은 필지 토양검정 결과 없이 정하지 않으므로, 검정을 먼저 받은 뒤 처방에 따르세요.",
    crops: ["APPLE"],
    topics: ["SOIL", "STATUS"],
    keywords: ["사과", "ph", "산도", "5.8", "6.3", "토양", "석회", "개량"],
    source: REVIEWED_CROP_SOURCES.APPLE,
    sourcePageOrTable: "토양 산도 범위 — pH 5.8~6.3",
  }),
  passage({
    id: "KB_APPLE_HARVEST_SIGNS",
    title: "사과 수확 시기는 무엇으로 판단하나요",
    text:
      "수확 판단은 날짜 하나로 정하지 않고 바탕색 변화, 꼭지 부분이 쉽게 떨어지는 정도, 씨의 색을 함께 봅니다. 같은 나무에서도 해가 잘 드는 쪽이 먼저 익으므로 몇 개를 나눠 확인하는 편이 정확합니다. 수확기 비 예보가 있으면 열매가 갈라지거나 저장성이 떨어질 수 있어 예보를 함께 확인하세요.",
    crops: ["APPLE"],
    topics: ["ACTION", "RECHECK"],
    keywords: ["사과", "수확", "수확기", "착색", "익", "저장", "판단"],
    source: REVIEWED_CROP_SOURCES.APPLE,
    sourcePageOrTable: "생육단계 — 수확기",
  }),
];

// ── 배 ──────────────────────────────────────────────────────
const PEAR_PASSAGES = [
  passage({
    id: "KB_PEAR_BLOSSOM_FROST",
    title: "배 개화기 저온은 어디를 보나요",
    text:
      "배는 사과보다 개화가 이른 편이라 늦서리와 겹칠 위험이 있습니다. 저온이 지난 다음 날 꽃 중심부의 갈변과 새순이 물러졌는지를 확인하고, 밭에서 가장 낮은 구역부터 보세요. 인공수분을 계획했다면 저온 피해를 확인한 뒤에 대상 꽃을 다시 정하는 것이 순서입니다.",
    crops: ["PEAR"],
    topics: ["WEATHER", "ACTION", "RECHECK"],
    keywords: ["배", "개화", "꽃", "저온", "늦서리", "인공수분", "갈변"],
    imageId: "APPLE_BLOSSOM_FROST",
    source: REVIEWED_CROP_SOURCES.PEAR,
    sourcePageOrTable: "생육단계 — 개화기",
  }),
  passage({
    id: "KB_PEAR_WET_LEAF",
    title: "배 과원에서 비가 온 뒤 확인할 곳",
    text:
      "배는 잎과 열매가 오래 젖어 있으면 반점이 생기고 번질 수 있어, 비가 그친 뒤 통풍이 막힌 수관 안쪽을 먼저 확인합니다. 잎 가장자리 변색, 새순 마름, 열매 표면의 갈변이 어제보다 넓어졌는지 같은 각도로 비교하세요. 반점의 병명 확정은 현장 진단이 필요하므로 기록과 함께 농업기술센터에 문의합니다.",
    crops: ["PEAR"],
    topics: ["WEATHER", "ACTION", "RECHECK"],
    keywords: ["배", "비", "강수", "반점", "수관", "통풍", "번지", "잎"],
    imageId: "PEAR_LEAF_WET_SPOT",
    source: REVIEWED_CROP_SOURCES.PEAR,
    sourcePageOrTable: "생육단계 — 강우기 관리",
  }),
  passage({
    id: "KB_PEAR_TEMPERATURE_TARGET",
    title: "배의 생육 적온은 어떻게 표시되나요",
    text:
      "배의 생육 적온은 공식 문서에 범위가 아니라 약 20℃라는 단일 목표값으로 제시되어 있습니다. 그래서 이 서비스는 배의 기후 항목을 범위 점수로 계산하지 않고 목표값과의 차이로만 표시합니다. 범위가 없는 값을 임의로 넓혀 점수화하지 않기 때문입니다.",
    crops: ["PEAR"],
    topics: ["WEATHER", "STATUS", "SOURCE"],
    keywords: ["배", "적온", "20", "기온", "기후", "목표", "점수"],
    source: REVIEWED_CROP_SOURCES.PEAR,
    sourcePageOrTable: "기상생태 — 생육 적온 약 20℃",
  }),
  passage({
    id: "KB_PEAR_HEAT",
    title: "배 과원의 여름 고온·집중호우 점검",
    text:
      "여름에는 고온과 집중호우가 이어지면서 열매 표면 피해와 뿌리 과습이 함께 올 수 있습니다. 폭염 예보 전에는 토양이 마르지 않았는지, 집중호우 예보 전에는 배수로가 막히지 않았는지를 각각 확인하세요. 비가 그친 뒤에는 물이 고인 구간의 뿌리 주변이 계속 젖어 있지 않은지 다시 봅니다.",
    crops: ["PEAR"],
    topics: ["WEATHER", "ACTION", "RECHECK"],
    keywords: ["배", "고온", "폭염", "집중호우", "배수", "과습", "여름"],
    source: REVIEWED_CROP_SOURCES.PEAR_HEAT_GUIDE,
    sourcePageOrTable: "여름철 과수원 관리 — 폭염·집중호우",
  }),
];

// ── 오이 ────────────────────────────────────────────────────
const CUCUMBER_PASSAGES = [
  passage({
    id: "KB_CUCUMBER_FACILITY_HUMIDITY",
    title: "시설 오이의 과습은 어떻게 관리하나요",
    text:
      "시설 오이는 잎이 젖어 있는 시간이 길어지면 잎과 줄기에서 문제가 먼저 나타납니다. 아침에 온도를 올려 이슬을 말리고, 측창과 천창을 함께 열어 공기가 한 방향으로 흐르게 하며, 잎이 겹쳐 습기가 갇히는 구간을 정리하세요. 실외 예보가 습할 때는 관수 시각을 늦은 오후보다 이른 시간으로 옮기는 편이 유리합니다.",
    crops: ["CUCUMBER"],
    topics: ["WEATHER", "ACTION"],
    keywords: ["오이", "시설", "하우스", "과습", "습도", "환기", "이슬", "관수"],
    imageId: "FACILITY_VENTILATION",
    source: REVIEWED_CROP_SOURCES.CUCUMBER_FACILITY_RISK,
    sourcePageOrTable: "시설 오이 생육 부진 — 환경 관리",
  }),
  passage({
    id: "KB_CUCUMBER_LEAF_UNDERSIDE",
    title: "오이는 잎 뒷면을 왜 봐야 하나요",
    text:
      "오이에서 작은 해충과 초기 변색은 잎 앞면보다 뒷면에서 먼저 보이는 경우가 많습니다. 포기마다 아래·중간·위 잎을 하나씩 골라 뒤집어 확인하고, 끈적임이나 흰 가루 모양 흔적, 작은 벌레가 있는지 보세요. 같은 잎을 며칠 간격으로 다시 확인하면 늘어나는지 판단할 수 있습니다.",
    crops: ["CUCUMBER"],
    topics: ["ACTION", "RECHECK"],
    keywords: ["오이", "잎", "뒷면", "해충", "벌레", "변색", "끈적", "관찰"],
    imageId: "CUCUMBER_LEAF_UNDERSIDE",
    source: REVIEWED_CROP_SOURCES.CUCUMBER,
    sourcePageOrTable: "생육단계 — 관찰 지점",
  }),
  passage({
    id: "KB_CUCUMBER_ROOT_STRESS",
    title: "오이 생육이 갑자기 나빠질 때 보는 순서",
    text:
      "오이의 지상부 생육이 나빠질 때는 잎보다 뿌리 쪽 조건을 먼저 확인하는 편이 빠릅니다. 물을 너무 자주 줘서 뿌리 주변이 계속 젖어 있는지, 시설에서 염류가 쌓여 EC가 올라갔는지, 지온이 낮아 뿌리가 활동하지 못하는지를 순서대로 봅니다. 세 가지 중 무엇인지는 관수 기록과 토양검정 결과로 좁힐 수 있습니다.",
    crops: ["CUCUMBER"],
    topics: ["SOIL", "ACTION"],
    keywords: ["오이", "생육", "부진", "뿌리", "과습", "ec", "염류", "지온"],
    source: REVIEWED_CROP_SOURCES.CUCUMBER_OPEN_FIELD_RISK,
    sourcePageOrTable: "노지·시설 오이 생육 부진 — 원인 확인 순서",
  }),
  passage({
    id: "KB_CUCUMBER_HARVEST_INTERVAL",
    title: "오이는 왜 자주 수확해야 하나요",
    text:
      "오이는 열매가 커진 채로 오래 달려 있으면 포기가 그 열매에 힘을 쏟아 뒤에 달릴 열매가 부실해집니다. 수확 적기에 자주 따 주는 것이 전체 수량과 품질에 유리하고, 기형과나 색이 옅은 열매는 먼저 정리합니다. 고온기에는 자라는 속도가 빨라져 수확 간격을 더 짧게 봐야 합니다.",
    crops: ["CUCUMBER"],
    topics: ["ACTION"],
    keywords: ["오이", "수확", "간격", "기형과", "수량", "적기"],
    source: REVIEWED_CROP_SOURCES.CUCUMBER,
    sourcePageOrTable: "생육단계 — 수확",
  }),
];

// ── 감자 ────────────────────────────────────────────────────
const POTATO_PASSAGES = [
  passage({
    id: "KB_POTATO_LATE_FROST",
    title: "감자 싹이 난 뒤 늦서리가 오면",
    text:
      "감자는 싹이 땅 위로 올라온 뒤 서리를 맞으면 잎과 줄기가 물러지며 검게 변할 수 있습니다. 늦서리 예보가 있으면 밭에서 가장 낮은 구역을 표시해 두고, 서리가 지난 다음 날 아침에 그 구역부터 확인하세요. 지상부가 상해도 씨감자가 살아 있으면 다시 싹이 나므로 성급하게 갈아엎기 전에 며칠 더 지켜봅니다.",
    crops: ["POTATO"],
    topics: ["WEATHER", "ACTION", "RECHECK"],
    keywords: ["감자", "서리", "늦서리", "저온", "싹", "줄기", "검게"],
    source: REVIEWED_CROP_SOURCES.POTATO,
    sourcePageOrTable: "생육단계 — 출현기 저온",
  }),
  passage({
    id: "KB_POTATO_WET_SOIL",
    title: "감자밭 과습은 왜 위험한가요",
    text:
      "감자는 덩이줄기가 흙 속에서 자라기 때문에 물이 고인 구간에서는 숨을 쉬지 못해 썩기 쉽습니다. 비 예보 전에 배수로가 막히지 않았는지 확인하고, 비가 그친 뒤에도 물이 남아 있는 구간을 표시해 두세요. 과습이 이어진 뒤에는 아랫잎부터 물 먹은 듯한 반점이 넓어지는지 확인합니다.",
    crops: ["POTATO"],
    topics: ["SOIL", "WEATHER", "ACTION"],
    keywords: ["감자", "과습", "배수", "물", "썩", "아랫잎", "반점", "비"],
    imageId: "POTATO_LOWER_LEAF_SPOT",
    source: REVIEWED_CROP_SOURCES.POTATO_HEAT_GUIDE,
    sourcePageOrTable: "노지감자 생육불량 — 토양 수분",
  }),
  passage({
    id: "KB_POTATO_GROWTH_POOR",
    title: "감자 생육이 고르지 않을 때 보는 순서",
    text:
      "감자 생육이 구역마다 다를 때는 씨감자 상태, 심은 깊이, 물 흐름을 순서대로 확인합니다. 한쪽에만 몰려 나타나면 그 구역의 배수와 다져진 정도를 먼저 보고, 밭 전체에 고르면 씨감자와 심는 작업 조건을 확인합니다. 원인을 좁히지 못하면 심은 날짜와 작업 기록을 정리해 농업기술센터에 문의하세요.",
    crops: ["POTATO"],
    topics: ["SOIL", "ACTION", "STATUS"],
    keywords: ["감자", "생육", "불량", "고르지", "씨감자", "깊이", "구역"],
    source: REVIEWED_CROP_SOURCES.POTATO_HEAT_GUIDE,
    sourcePageOrTable: "노지감자 생육불량 원인규명",
  }),
  passage({
    id: "KB_POTATO_HARVEST_TIMING",
    title: "감자 수확 전에는 무엇을 확인하나요",
    text:
      "감자는 잎과 줄기가 자연스럽게 누렇게 마르기 시작할 때가 수확 준비 신호입니다. 수확은 흙이 젖어 있을 때보다 마른 날에 하는 편이 상처와 썩음을 줄이고, 캔 감자를 햇볕에 오래 두면 껍질이 초록으로 변할 수 있으니 그늘로 옮깁니다. 수확 며칠 전 비 예보가 있으면 일정을 앞뒤로 조정할지 함께 확인하세요.",
    crops: ["POTATO"],
    topics: ["ACTION", "RECHECK"],
    keywords: ["감자", "수확", "누렇", "마르", "저장", "초록", "비"],
    source: REVIEWED_CROP_SOURCES.POTATO,
    sourcePageOrTable: "생육단계 — 수확기",
  }),
];

// ── 상추 ────────────────────────────────────────────────────
const LETTUCE_PASSAGES = [
  passage({
    id: "KB_LETTUCE_HEAT_STRESS",
    title: "상추가 여름에 힘들어하는 이유",
    text:
      "상추는 서늘한 기후를 좋아해서 고온이 이어지면 잎이 웃자라고 쓴맛이 강해지며 꽃대가 올라올 수 있습니다. 여름 시설재배에서는 차광과 환기로 낮 온도를 낮추고, 물이 마르지 않게 관리하되 잎이 오래 젖어 있지 않도록 관수 시각을 조절합니다. 꽃대가 올라온 포기는 회복되지 않으므로 다음 파종 일정을 조정하는 편이 낫습니다.",
    crops: ["LETTUCE"],
    topics: ["WEATHER", "ACTION"],
    keywords: ["상추", "고온", "여름", "웃자람", "쓴맛", "꽃대", "차광", "환기"],
    source: REVIEWED_CROP_SOURCES.LETTUCE_FACILITY_RISK,
    sourcePageOrTable: "상추 여름 시설재배 — 고온 관리",
  }),
  passage({
    id: "KB_LETTUCE_TIPBURN",
    title: "상추 잎 끝이 마를 때 확인할 것",
    text:
      "잎 끝이 갈색으로 마르는 증상은 물과 양분이 잎 끝까지 고르게 가지 못할 때 나타날 수 있습니다. 갑작스러운 건조와 과습이 번갈아 오는지, 시설에서 염류가 쌓여 뿌리가 물을 빨아들이기 어려운지를 확인하세요. 원인이 양분 문제로 의심되더라도 비료 종류와 양은 토양검정 결과에 따라 처방받아야 합니다.",
    crops: ["LETTUCE"],
    topics: ["SOIL", "ACTION"],
    keywords: ["상추", "잎끝", "잎 끝", "갈변", "마르", "ec", "염류", "건조"],
    imageId: "LETTUCE_TIPBURN",
    source: REVIEWED_CROP_SOURCES.LETTUCE_FACILITY_RISK,
    sourcePageOrTable: "상추 여름 시설재배 — 생육 장해",
  }),
  passage({
    id: "KB_LETTUCE_CENTER_ROT",
    title: "상추 포기 중심을 확인해야 하는 이유",
    text:
      "상추는 잎이 겹쳐 있어서 포기 중심이 젖은 채로 오래 있으면 안쪽부터 물러지고 냄새가 날 수 있습니다. 겉잎만 보고 지나치기 쉬우므로 몇 포기를 골라 잎을 벌려 중심부 색과 냄새를 확인하세요. 잎이 겹쳐 오래 젖는 구간은 통풍을 확보하고 관수량을 조절합니다.",
    crops: ["LETTUCE"],
    topics: ["ACTION"],
    keywords: ["상추", "중심", "무름", "냄새", "겉잎", "통풍", "젖"],
    source: REVIEWED_CROP_SOURCES.LETTUCE_GENERAL_RISK,
    sourcePageOrTable: "상추 재배 관리 — 관찰 지점",
  }),
  passage({
    id: "KB_LETTUCE_HARVEST",
    title: "상추 수확은 어떻게 하나요",
    text:
      "잎상추는 아래쪽 잎부터 필요한 만큼 따 내면 위쪽에서 계속 새 잎이 나옵니다. 한 번에 너무 많이 따면 포기 회복이 느려지므로 남길 잎을 정해 두고 수확하고, 상처 난 잎은 남기지 않는 편이 좋습니다. 더운 시기에는 이른 아침에 수확하면 잎이 덜 시듭니다.",
    crops: ["LETTUCE"],
    topics: ["ACTION"],
    keywords: ["상추", "수확", "잎상추", "따", "아침", "시들"],
    source: REVIEWED_CROP_SOURCES.LETTUCE,
    sourcePageOrTable: "생육단계 — 수확",
  }),
];

export const REVIEWED_KNOWLEDGE_BASE = Object.freeze([
  ...SOIL_PASSAGES,
  ...WEATHER_PASSAGES,
  ...OBSERVATION_PASSAGES,
  ...APPLE_PASSAGES,
  ...PEAR_PASSAGES,
  ...CUCUMBER_PASSAGES,
  ...POTATO_PASSAGES,
  ...LETTUCE_PASSAGES,
]);
