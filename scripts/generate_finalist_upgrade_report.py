#!/usr/bin/env python3
"""Generate the finalist product-upgrade presentation PDF."""

from pathlib import Path
from textwrap import shorten

from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "흙날씨_본선_제품업그레이드_최종보고서.pdf"
FONT_PATH = Path("/System/Library/Fonts/Supplemental/AppleGothic.ttf")
PAGE_W, PAGE_H = landscape(A4)

GREEN_950 = HexColor("#10251B")
GREEN_800 = HexColor("#174A31")
GREEN_650 = HexColor("#24714A")
GREEN_100 = HexColor("#E8F3ED")
MINT = HexColor("#CFEBDD")
INK = HexColor("#17231D")
SLATE = HexColor("#5C6B63")
LINE = HexColor("#D8E2DC")
PAPER = HexColor("#F8FAF8")
SAND = HexColor("#F7F0E3")
AMBER = HexColor("#B56E12")
RED = HexColor("#A53A32")
BLUE = HexColor("#3B6D82")


def register_fonts():
    pdfmetrics.registerFont(TTFont("AppleGothic", str(FONT_PATH)))
    pdfmetrics.registerFont(TTFont("AppleGothicBold", str(FONT_PATH)))


def rounded(c, x, y, w, h, fill, stroke=None, radius=14, width=1):
    c.setFillColor(fill)
    c.setStrokeColor(stroke or fill)
    c.setLineWidth(width)
    c.roundRect(x, y, w, h, radius, fill=1, stroke=1 if stroke else 0)


def text(c, value, x, y, size=12, color=INK, font="AppleGothic", anchor="left"):
    c.setFont(font, size)
    c.setFillColor(color)
    if anchor == "center":
        c.drawCentredString(x, y, value)
    elif anchor == "right":
        c.drawRightString(x, y, value)
    else:
        c.drawString(x, y, value)


def wrap_lines(value, font, size, max_width):
    lines = []
    for paragraph in str(value).split("\n"):
        if not paragraph:
            lines.append("")
            continue
        current = ""
        for char in paragraph:
            candidate = current + char
            if current and pdfmetrics.stringWidth(candidate, font, size) > max_width:
                lines.append(current)
                current = char
            else:
                current = candidate
        if current:
            lines.append(current)
    return lines


def paragraph(c, value, x, y, width, size=12, leading=None, color=SLATE,
              font="AppleGothic", max_lines=None):
    leading = leading or size * 1.55
    lines = wrap_lines(value, font, size, width)
    if max_lines and len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = shorten(lines[-1], width=max(8, len(lines[-1]) - 1), placeholder="…")
    for idx, line in enumerate(lines):
        text(c, line, x, y - idx * leading, size=size, color=color, font=font)
    return y - len(lines) * leading


def title(c, kicker, heading, sub=None, dark=False):
    fg = white if dark else INK
    muted = MINT if dark else SLATE
    text(c, kicker, 42, PAGE_H - 48, 10, GREEN_650 if not dark else MINT, "AppleGothicBold")
    text(c, heading, 42, PAGE_H - 84, 25, fg, "AppleGothicBold")
    if sub:
        paragraph(c, sub, 42, PAGE_H - 108, PAGE_W - 84, 10.5, 15, muted)


def footer(c, page_num, label="흙날씨 · 본선 제품 업그레이드"):
    c.setStrokeColor(LINE)
    c.line(42, 28, PAGE_W - 42, 28)
    text(c, label, 42, 13, 8, SLATE)
    text(c, f"{page_num:02d}", PAGE_W - 42, 13, 8, SLATE, anchor="right")


def image_box(c, path, x, y, w, h, contain=False, radius=12, bg=white,
              focus_y=0.5):
    path = Path(path)
    rounded(c, x, y, w, h, bg, LINE, radius=radius)
    if not path.exists():
        text(c, "이미지 없음", x + w / 2, y + h / 2, 11, SLATE, anchor="center")
        return
    with Image.open(path) as im:
        iw, ih = im.size
    scale = min(w / iw, h / ih) if contain else max(w / iw, h / ih)
    dw, dh = iw * scale, ih * scale
    dx = x + (w - dw) / 2
    dy = y + h / 2 - dh * focus_y
    dy = min(y, max(y + h - dh, dy))
    c.saveState()
    p = c.beginPath()
    p.roundRect(x, y, w, h, radius)
    c.clipPath(p, stroke=0, fill=0)
    c.drawImage(ImageReader(str(path)), dx, dy, dw, dh, preserveAspectRatio=True, mask="auto")
    c.restoreState()


def pill(c, label, x, y, fill=GREEN_100, fg=GREEN_800, width=None):
    width = width or pdfmetrics.stringWidth(label, "AppleGothicBold", 9) + 24
    rounded(c, x, y, width, 24, fill, radius=12)
    text(c, label, x + width / 2, y + 7, 9, fg, "AppleGothicBold", anchor="center")
    return width


def metric_card(c, x, y, w, h, label, value, note, accent=GREEN_650):
    rounded(c, x, y, w, h, white, LINE)
    c.setFillColor(accent)
    c.roundRect(x, y, 6, h, 3, fill=1, stroke=0)
    text(c, label, x + 20, y + h - 26, 9, SLATE, "AppleGothicBold")
    text(c, value, x + 20, y + h - 58, 24, INK, "AppleGothicBold")
    paragraph(c, note, x + 20, y + h - 82, w - 36, 8.5, 12, SLATE, max_lines=2)


def slide_cover(c):
    c.setFillColor(GREEN_950)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(GREEN_800)
    c.circle(PAGE_W - 90, PAGE_H - 60, 165, fill=1, stroke=0)
    c.setFillColor(GREEN_650)
    c.circle(PAGE_W - 12, 60, 115, fill=1, stroke=0)
    pill(c, "FINALIST PRODUCT UPGRADE", 48, PAGE_H - 86, fill=MINT, fg=GREEN_950, width=178)
    text(c, "흙날씨", 48, PAGE_H - 150, 34, white, "AppleGothicBold")
    text(c, "공공데이터를 오늘의 농장 행동으로", 48, PAGE_H - 194, 26, white, "AppleGothicBold")
    paragraph(c, "기능 추가보다 신뢰 가능한 판단, 실행 가능한 행동, 실제 사용자 흐름을 우선한 본선 제품 개선 결과", 48, PAGE_H - 228, 510, 12, 18, MINT)
    rounded(c, 48, 80, 370, 126, HexColor("#153C29"), HexColor("#316C4C"))
    text(c, "독립 심사", 72, 174, 10, MINT, "AppleGothicBold")
    text(c, "84 / 100", 72, 120, 38, white, "AppleGothicBold")
    pill(c, "CONDITIONAL GO", 248, 111, fill=HexColor("#E8D9B7"), fg=GREEN_950, width=140)
    text(c, "로컬 본선 데모 GO · 운영 배포 HOLD", 72, 92, 10, MINT)
    text(c, "검증 커밋 d598890 · 2026.07.31", PAGE_W - 48, 38, 9, MINT, anchor="right")
    c.showPage()


def slide_audit(c):
    c.setFillColor(PAPER); c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    title(c, "01 · WHY CHANGE", "57점 프로토타입에서 84점 본선 제품으로", "테스트 수보다 사용자 신뢰를 깨뜨리는 제품 결함부터 제거했습니다.")
    metric_card(c, 42, 343, 230, 124, "초기 독립 감사", "57 / 100", "합산점수·미확인 작기·배포 상태 단절", RED)
    metric_card(c, 290, 343, 230, 124, "현재 독립 심사", "84 / 100", "로컬 핵심 데모 GO · 운영은 HOLD", GREEN_650)
    metric_card(c, 538, 343, 260, 124, "검증 범위", "425 TESTS", "UI 93 + Backend 332 · Console 0", BLUE)
    issues = [
        ("01", "날씨+토양 60:40 합산", "자료 공간·결측을 숨기는 단일 점수 제거"),
        ("02", "미확인 작기 자동 확정", "UNKNOWN을 그대로 보존하고 기후 판단 HOLD"),
        ("03", "기술 상태가 행동보다 앞섬", "오늘 행동·이유·기한·재확인 중심으로 전환"),
        ("04", "챗봇의 쓰기 의도 혼동", "제안 후 사용자 확인 전에는 저장 금지"),
    ]
    y = 298
    for num, before, after in issues:
        text(c, num, 50, y + 6, 11, GREEN_650, "AppleGothicBold")
        text(c, before, 88, y + 6, 11, INK, "AppleGothicBold")
        text(c, "→", 338, y + 6, 13, AMBER, "AppleGothicBold")
        text(c, after, 378, y + 6, 10.5, SLATE)
        c.setStrokeColor(LINE); c.line(50, y - 12, 790, y - 12)
        y -= 52
    footer(c, 2); c.showPage()


def slide_product(c):
    c.setFillColor(PAPER); c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    title(c, "02 · PRODUCT STRATEGY", "AI 네이티브의 정의를 다시 세웠습니다", "사용자가 질문을 잘해야 작동하는 챗봇이 아니라, 자료를 먼저 읽고 필요한 행동을 제시하는 서비스입니다.")
    flow = [
        ("원인", "실제 날씨·토양·예보", BLUE),
        ("위험", "작물별 검수 규칙", AMBER),
        ("행동", "오늘·당분간 투두", GREEN_650),
        ("재확인", "시점·근거·완료 상태", GREEN_800),
    ]
    x = 48
    for idx, (label, desc, color) in enumerate(flow):
        rounded(c, x, 332, 165, 112, white, LINE)
        c.setFillColor(color); c.circle(x + 26, 414, 8, fill=1, stroke=0)
        text(c, label, x + 45, 408, 15, INK, "AppleGothicBold")
        paragraph(c, desc, x + 20, 376, 125, 9.5, 14, SLATE, max_lines=2)
        if idx < len(flow) - 1:
            text(c, "→", x + 176, 382, 18, GREEN_650, "AppleGothicBold")
        x += 194
    rounded(c, 48, 96, 744, 186, GREEN_950)
    text(c, "대표 사용자 순간", 72, 246, 10, MINT, "AppleGothicBold")
    text(c, "내일 33℃인데 사과나무에 무엇을 먼저 해야 하지?", 72, 208, 21, white, "AppleGothicBold")
    paragraph(c, "흙날씨는 사용자가 데이터 이름을 알거나 질문을 잘하기를 요구하지 않습니다. 저장된 농장·작물과 공공데이터를 먼저 확인하고, 가장 가까운 위험과 현장 행동을 첫 화면에 배치합니다.", 72, 168, 620, 11, 18, MINT)
    pill(c, "3초 안에 목적·대상·다음 행동", 572, 114, fill=MINT, fg=GREEN_950, width=188)
    footer(c, 3); c.showPage()


def slide_parallel(c):
    c.setFillColor(PAPER); c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    title(c, "03 · OPERATING MODEL", "공통 신뢰 계약 위에서 병렬 개발했습니다", "기능별 개발자와 독립 평가자의 책임을 분리해, 구현자가 자신의 결과를 승인하지 않도록 했습니다.")
    contracts = [
        "날씨·토양·예보·위성을 하나의 점수로 합치지 않음",
        "결측은 null, 미확인은 HOLD",
        "AI는 검수된 근거와 행동만 설명",
        "사진·위성은 진단이 아닌 관찰 보조",
    ]
    rounded(c, 42, 102, 300, 362, GREEN_950)
    text(c, "COMMON TRUST CONTRACT", 66, 428, 10, MINT, "AppleGothicBold")
    y = 382
    for idx, line in enumerate(contracts, 1):
        c.setFillColor(GREEN_650); c.circle(70, y + 3, 11, fill=1, stroke=0)
        text(c, str(idx), 70, y - 1, 8, white, "AppleGothicBold", anchor="center")
        paragraph(c, line, 94, y + 4, 212, 10, 15, white, max_lines=3)
        y -= 72
    cards = [
        ("ACTION PLAN", "위험일·근거·기한·상태 수명주기", "투두 9.6"),
        ("PHOTO & SEASON", "비공개 기록·품질 게이트·회고", "사진 8.6"),
        ("PARCEL & SATELLITE", "필지 경계·품질 관측·추세 제한", "정직한 DISABLED"),
        ("CHATBOT", "근거 설명·확인형 쓰기·안전 라우팅", "AI 9.0"),
    ]
    positions = [(370, 294), (592, 294), (370, 102), (592, 102)]
    for (label, desc, score), (x, y) in zip(cards, positions):
        rounded(c, x, y, 200, 170, white, LINE)
        text(c, label, x + 18, y + 138, 9, GREEN_650, "AppleGothicBold")
        paragraph(c, desc, x + 18, y + 106, 164, 11, 17, INK, max_lines=3)
        pill(c, score, x + 18, y + 20, width=110)
    footer(c, 4); c.showPage()


def slide_before_after(c):
    c.setFillColor(PAPER); c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    title(c, "04 · BEFORE / AFTER", "이번 업그레이드 직전과 최종 버전을 비교했습니다", "동일 농장·작물·화면 크기·외부자료 모드에서 직전 팀 버전과 최종 제품을 다시 실행했습니다.")
    image_box(c, ROOT / "output/finalist_upgrade_before_full.png", 42, 126, 366, 342,
              focus_y=0.465)
    image_box(c, ROOT / "output/finalist_upgrade_after_full.png", 434, 126, 366, 342,
              focus_y=0.400)
    pill(c, "BEFORE · 127dfb3", 56, 438, fill=SAND, fg=AMBER, width=126)
    pill(c, "AFTER · d598890", 448, 438, fill=GREEN_100, fg=GREEN_800, width=126)
    paragraph(c, "날씨 60%+토양 40% 합산점수와 일회성 안내", 56, 108, 340, 9, 13, SLATE, max_lines=2)
    paragraph(c, "자료축 분리와 기한·근거·완료 상태를 가진 지속형 행동계획", 448, 108, 340, 9, 13, SLATE, max_lines=2)
    footer(c, 5); c.showPage()


def slide_surfaces(c):
    c.setFillColor(PAPER); c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    title(c, "05 · ACTUAL USER FLOW", "실제 API 화면에서 골든 플로우를 완주했습니다", "저장 농장 복원 → 작물 분석 → 챗봇 제안 → 사용자 확인 → 투두 저장")
    image_box(c, ROOT / "output/finalist_final_dashboard.png", 42, 198, 376, 270)
    image_box(c, ROOT / "output/finalist_final_chatbot.png", 436, 252, 364, 216)
    image_box(c, ROOT / "output/finalist_final_mobile.png", 436, 76, 120, 160, contain=True)
    rounded(c, 574, 76, 226, 160, GREEN_950)
    text(c, "확인형 AI 쓰기", 594, 204, 10, MINT, "AppleGothicBold")
    text(c, "0 → 제안 → 확인 → 1", 594, 168, 18, white, "AppleGothicBold")
    paragraph(c, "‘이대로 추가’를 누르기 전에는 서버에 저장하지 않습니다.", 594, 136, 182, 9.5, 14, MINT)
    pill(c, "Console error 0", 594, 92, fill=MINT, fg=GREEN_950, width=126)
    paragraph(c, "데스크톱은 예보와 행동의 관계를, 모바일은 첫 행동을 먼저 보여줍니다.", 48, 172, 350, 9.5, 14, SLATE)
    footer(c, 6); c.showPage()


def slide_features(c):
    c.setFillColor(PAPER); c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    title(c, "06 · FEATURE QUALITY", "기능은 많아졌지만 판단 범위는 더 엄격해졌습니다", "각 기능의 가치와 한계를 같은 화면에서 설명할 수 있도록 만들었습니다.")
    rows = [
        ("투두리스트", "9.6", "실제 위험 규칙·날짜·근거·재확인·완료 상태", "본선 핵심"),
        ("챗봇", "9.0", "근거 선택·안전 라우팅·확인형 할 일 추가", "본선 핵심"),
        ("사진 시즌", "8.6", "촬영 품질·비공개 기록·같은 범위 비교·회고", "보조 시연"),
        ("필지 위성", "DISABLED", "유효 픽셀 50%·2관측 품질 게이트, 진단 금지", "연결 후"),
    ]
    y = 402
    for idx, (name, score, detail, stage) in enumerate(rows):
        fill = white if idx % 2 == 0 else HexColor("#F1F6F3")
        rounded(c, 42, y - 64, 758, 78, fill, LINE, radius=10)
        text(c, name, 62, y - 20, 14, INK, "AppleGothicBold")
        text(c, score, 220, y - 20, 15, GREEN_650 if score != "DISABLED" else AMBER, "AppleGothicBold")
        paragraph(c, detail, 322, y - 12, 316, 9.5, 14, SLATE, max_lines=2)
        pill(c, stage, 674, y - 36, fill=GREEN_100 if "핵심" in stage else SAND,
             fg=GREEN_800 if "핵심" in stage else AMBER, width=104)
        y -= 92
    footer(c, 7); c.showPage()


def slide_data(c):
    c.setFillColor(PAPER); c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    title(c, "07 · DATA TRUST", "연결 상태와 판단 가능 상태를 구분합니다", "API 성공을 농장 상태 확정으로 바꾸지 않고 출처·시간·공간 범위를 끝까지 보존합니다.")
    left = [
        ("기상청 단기·중기", "연결됨", GREEN_650),
        ("기후평년", "연결됨", GREEN_650),
        ("토양 지역 통계", "연결됨", GREEN_650),
        ("ASOS 최근 관측", "해당 시점 자료 없음", AMBER),
        ("필지 토양검정", "해당 주소 결과 없음", AMBER),
        ("Copernicus", "실행 환경 미설정", SLATE),
    ]
    rounded(c, 42, 104, 410, 362, white, LINE)
    text(c, "실제 실행 상태", 64, 432, 12, INK, "AppleGothicBold")
    y = 394
    for label, status, color in left:
        c.setFillColor(color); c.circle(68, y + 4, 4, fill=1, stroke=0)
        text(c, label, 84, y, 10, INK)
        text(c, status, 430, y, 9.5, color, "AppleGothicBold", anchor="right")
        c.setStrokeColor(LINE); c.line(64, y - 14, 430, y - 14)
        y -= 48
    rounded(c, 474, 282, 326, 184, GREEN_950)
    text(c, "COMPUTE", 498, 430, 9, MINT, "AppleGothicBold")
    text(c, "READY", 498, 392, 28, white, "AppleGothicBold")
    paragraph(c, "5작물 규칙 103개와 검수 매핑 8개로 분석 계산 가능", 498, 356, 266, 10, 16, MINT)
    rounded(c, 474, 104, 326, 154, SAND, HexColor("#E5D2AE"))
    text(c, "DEPLOYMENT", 498, 222, 9, AMBER, "AppleGothicBold")
    text(c, "HOLD", 498, 184, 28, RED, "AppleGothicBold")
    paragraph(c, "Supabase 공유 상태 미검증. 로컬 시연과 운영 배포를 구분", 498, 150, 266, 10, 16, SLATE)
    footer(c, 8); c.showPage()


def slide_verification(c):
    c.setFillColor(PAPER); c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    title(c, "08 · INDEPENDENT REVIEW", "구현자가 아닌 평가자가 최종 판정을 내렸습니다", "자동 테스트, 실제 화면, 농업 의사결정, 챗봇 안전, 배포 상태를 서로 다른 관점으로 검증했습니다.")
    metric_card(c, 42, 330, 236, 132, "해커톤 심사", "84 / 100", "로컬 GO · Hosted NO-GO", GREEN_650)
    metric_card(c, 302, 330, 236, 132, "챗봇·AI", "9.0 / 10", "ACCEPTED · P0/P1 0", BLUE)
    metric_card(c, 562, 330, 236, 132, "농업·계산", "9.0 / 10", "ACCEPTED · P0/P1 0", GREEN_650)
    checks = [
        ("UI", "93 / 93", "PASS"),
        ("Backend", "332 / 332", "PASS"),
        ("Static check", "109 files", "PASS"),
        ("Build", "Vercel assets", "PASS"),
        ("Browser", "console 0", "PASS"),
    ]
    rounded(c, 42, 104, 756, 176, white, LINE)
    text(c, "검증 매트릭스", 64, 246, 12, INK, "AppleGothicBold")
    x = 64
    for label, value, state in checks:
        text(c, label, x, 208, 9, SLATE, "AppleGothicBold")
        text(c, value, x, 178, 14, INK, "AppleGothicBold")
        pill(c, state, x, 128, width=72)
        x += 144
    footer(c, 9); c.showPage()


def slide_demo(c):
    c.setFillColor(GREEN_950); c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    title(c, "09 · FINAL DEMO", "시연은 기능 목록이 아니라 한 사용자의 하루로", "핵심 가치는 ‘더 많은 데이터’가 아니라 ‘데이터의 한계를 보존한 실행 가능한 행동’입니다.", dark=True)
    steps = [
        ("01", "농장 자동 복원", "인천 남동구 · 사과·오이"),
        ("02", "3초 행동 이해", "내일 33℃ · 사과 기준 30℃"),
        ("03", "근거와 행동", "과원 수분·햇볕 데임 확인"),
        ("04", "확인형 AI", "관수시설 확인을 내일 투두로"),
        ("05", "기록과 회고", "사진·완료 상태·시즌 흐름"),
    ]
    y = 394
    for num, heading, desc in steps:
        c.setFillColor(GREEN_650); c.circle(68, y + 3, 16, fill=1, stroke=0)
        text(c, num, 68, y - 1, 8.5, white, "AppleGothicBold", anchor="center")
        text(c, heading, 100, y + 6, 14, white, "AppleGothicBold")
        text(c, desc, 100, y - 16, 9.5, MINT)
        if num != "05":
            c.setStrokeColor(HexColor("#37604B")); c.line(68, y - 30, 68, y - 60)
        y -= 72
    rounded(c, 468, 116, 326, 318, HexColor("#153C29"), HexColor("#316C4C"))
    text(c, "발표에서 반드시 구분", 492, 398, 10, MINT, "AppleGothicBold")
    text(c, "로컬 본선 데모", 492, 354, 20, white, "AppleGothicBold")
    pill(c, "GO", 690, 343, fill=MINT, fg=GREEN_950, width=72)
    text(c, "Hosted / 실사용", 492, 294, 20, white, "AppleGothicBold")
    pill(c, "HOLD", 690, 283, fill=HexColor("#E8D9B7"), fg=RED, width=72)
    paragraph(c, "위성 실제 조회, 서버 영구 보존, 5작물 현장 검증 완료를 아직 주장하지 않습니다.", 492, 238, 266, 10.5, 17, MINT)
    text(c, "다음 게이트", 492, 176, 10, MINT, "AppleGothicBold")
    paragraph(c, "공유 상태 배포 · 전문가 규칙 검증 · 과거 예보 백테스트 · 실제 농업인 과업 평가", 492, 148, 266, 10.5, 17, white)
    text(c, "흙날씨 · 공공데이터를 오늘의 농장 행동으로", 48, 38, 9, MINT)
    c.showPage()


def generate():
    register_fonts()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUTPUT), pagesize=(PAGE_W, PAGE_H), pageCompression=1)
    c.setTitle("흙날씨 본선 제품 업그레이드 최종 보고서")
    c.setAuthor("흙날씨 팀")
    c.setSubject("해커톤 본선 제품 개선 및 독립 감사 결과")
    slide_cover(c)
    slide_audit(c)
    slide_product(c)
    slide_parallel(c)
    slide_before_after(c)
    slide_surfaces(c)
    slide_features(c)
    slide_data(c)
    slide_verification(c)
    slide_demo(c)
    c.save()
    print(OUTPUT)


if __name__ == "__main__":
    generate()
