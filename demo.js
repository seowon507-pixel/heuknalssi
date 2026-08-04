// demo.js
// 로직 검증용 시나리오. `node demo.js` 로 실행합니다.
// (프론트엔드가 아니라, 엔진이 의도대로 동작하는지 확인하는 스크립트)

import { FarmGame } from './src/farmGame.js';
import { createCatalogStock } from './src/redemption.js';

const log = (...a) => console.log(...a);
const line = () => log('─'.repeat(50));

// 날짜를 하루씩 넘기며 시뮬레이션하기 위한 도우미
function addDays(dateKey, n) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

const stock = createCatalogStock();      // 전역 재고 (모든 사용자 공유)
const game = new FarmGame(null, stock);  // 게임에 재고 연결
let day = '2026-08-04';

line();
log('🌱 시나리오 시작: 상추 키우기');
line();

// 1) 상추 선택
log(game.selectCrop('lettuce', new Date(day)).message);

// 2) 연속 출석 (완벽 연속 시 7일차에 다 자람)
for (let i = 0; i < 9; i++) {
  const r = game.checkIn(day);
  if (r.ok) {
    const stage = r.growth ? r.growth.stage.name : '(작물 없음)';
    log(
      `[${r.dayKey}] ${r.message} | 단계: ${stage}` +
        (r.growth ? ` (성장 ${r.growth.growth})` : '') +
        (r.cropMatured ? '  ✅ 다 자랐어요!' : '')
    );
  }
  day = addDays(day, 1);
}

line();
let st = game.getStatus();
log(`보유 포인트: ${st.points}P | 연속: ${st.streak}일 | 총출석: ${st.totalCheckIns}회`);
log(`새 작물 선택 필요? ${st.needsNewCrop} | 완료한 작물 수: ${st.completedCount}`);
line();

// 3) 다 자란 상추 → 다음 작물(오이) 선택
log('👉 이미 키우는 중인데 또 고르면? →', game.selectCrop('cucumber').message);
log('   실제로 상추가 다 자랐으니 needsNewCrop=true 여야 정상.');

// 4) 실물 비료 교환 (성장과 무관, 포인트만 사용)
line();
log('🎁 실물 비료 교환 테스트');
log(game.selectCrop('cucumber', new Date(day)).message);

log(`현재 포인트: ${game.points}P`);
log('교환 카탈로그:', game.getRewardCatalog().map((r) => `${r.name} ${r.pointCost}P(재고${r.remainingStock}·${r.affordable ? '가능' : '부족'})`).join(' / '));

// 포인트가 부족하면 교환 실패
log('신청(부족 시):', game.redeemFertilizer('organic_small', day).message);

// 오이를 키우며 포인트를 넉넉히(1200P+) 확보
while (game.points < 1200) {
  game.checkIn(day);
  day = addDays(day, 1);
}
log(`출석으로 포인트 적립 → 현재 ${game.points}P (이달 남은 교환: ${game.remainingMonthlyRedemptions(day)}회)`);

// 유기질 비료(소포장) 교환 신청
const redeemRes = game.redeemFertilizer('organic_small', day);
log('신청1:', redeemRes.message, `| 재고 ${game.getRewardCatalog()[0].remainingStock}`);
log('상태변경:', game.setRedemptionStatus(redeemRes.order.orderId, 'shipped').message);

// 월 교환 제한 테스트 (한도 2회) → 2번째 성공, 3번째는 한도 초과
line();
log('📅 월 교환 한도 테스트 (한도 2회/월)');
const redeemRes2 = game.redeemFertilizer('organic_small', day); // R2 (신청 상태 유지)
log('신청2:', redeemRes2.message, `| 이달 남은 교환: ${game.remainingMonthlyRedemptions(day)}회`);
log('신청3:', game.redeemFertilizer('organic_small', day).message, '← 한도 초과로 거부되어야 정상');

// 재고 소진(품절) 테스트: 재고를 1로 줄여 두 사용자가 경쟁 (재고 공유)
line();
log('📦 재고 품절 테스트 (재고 공유)');
stock.compound_mid = 1; // 남은 재고 1개로 설정
const userB = new FarmGame(null, stock);
const userC = new FarmGame(null, stock);
userB.state.points = 1200; // 포인트만 세팅해 바로 교환
userC.state.points = 1200;
log('userB 신청:', userB.redeemFertilizer('compound_mid', '2026-09-01').message, `| 남은 재고 ${stock.compound_mid}`);
log('userC 신청:', userC.redeemFertilizer('compound_mid', '2026-09-01').message, '← 품절이면 거부되어야 정상');

// 취소 규칙 테스트: 발송된 건은 취소 불가, 신청 상태 건만 취소(환불+재고복원)
line();
log('↩️ 교환 취소 규칙 테스트');
// (1) R1은 'shipped' 상태 → 취소 거부되어야 정상
const cancelShipped = game.setRedemptionStatus(redeemRes.order.orderId, 'canceled');
log('발송건 취소:', cancelShipped.message, '← 거부되어야 정상');
// (2) R2는 'requested' 상태 → 취소 성공 + 환불 + 재고 복원
const before = game.points;
const stockBefore = game.getRewardCatalog()[0].remainingStock;
const cancel = game.setRedemptionStatus(redeemRes2.order.orderId, 'canceled');
log('신청건 취소:', cancel.message, `| 환불 ${cancel.refundPoints}P (${before}P→${game.points}P) | 재고 ${stockBefore}→${game.getRewardCatalog()[0].remainingStock}`);

line();
st = game.getStatus();
log('현재 작물:', st.currentCrop ? `${st.currentCrop.emoji} ${st.currentCrop.stageName} (${st.currentCrop.growth}/${st.currentCrop.totalRequired})` : '없음');
log('보유 포인트:', st.points);
log('완료한 작물:', st.completedCrops);

// 5) 저장 → 복원 테스트
line();
log('💾 저장/복원 테스트');
const saved = JSON.stringify(game.toJSON());
const restored = FarmGame.fromJSON(JSON.parse(saved));
log('복원 후 포인트 동일?', restored.points === game.points);

// 6) 같은 날 중복 출석 방지 테스트
line();
log('🚫 중복 출석 방지 테스트');
const dup1 = restored.checkIn(day);
const dup2 = restored.checkIn(day);
log('1차:', dup1.message);
log('2차:', dup2.message, '(alreadyCheckedIn:', dup2.alreadyCheckedIn, ')');

// 7) 연속 끊김 테스트
line();
log('🔁 연속 끊김 테스트 (하루 건너뜀)');
const skipGame = new FarmGame();
skipGame.selectCrop('potato');
log(skipGame.checkIn('2026-08-04').message);           // 1일차
log(skipGame.checkIn('2026-08-05').message);           // 2일차
const afterSkip = skipGame.checkIn('2026-08-07');      // 하루 건너뜀 → 1일차로 리셋
log(afterSkip.message, '(streakReset:', afterSkip.streakReset, ')');

// 8) 연속 출석해야만 자란다 + 연속이 길수록 빨리 자란다
line();
log('🌾 연속 성장 규칙 테스트 (감자)');
const g2 = new FarmGame();
g2.selectCrop('potato');
const days = ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-08', '2026-08-09'];
//            1일차          2일차          3일차          (하루 결석)→1일차  2일차
for (const d of days) {
  const r = g2.checkIn(d);
  const p = g2.getStatus().currentCrop;
  log(`[${d}] ${r.streak}일차 | 성장치 +${r.growthAmount} → 누적 ${p.growth} (${p.stageName})`);
}
log('※ 성장치 +1,+2,+3 으로 점점 빨리 자라다가, 하루 결석하니 그날은 +0 (안 자람 + 포인트도 0).');
log('   결석 후 포인트:', g2.getStatus().points, 'P (결석 복귀일엔 적립 안 됨)');

// 9) 과거 날짜 출석 거부 테스트 (상태 손상 방지)
line();
log('⏪ 과거 날짜 출석 거부 테스트');
const g3 = new FarmGame();
g3.selectCrop('lettuce');
g3.checkIn('2026-08-10');
const past = g3.checkIn('2026-08-05'); // 마지막(08-10)보다 과거
log('과거 출석 시도:', past.message, '(ok:', past.ok, ', invalidDate:', past.invalidDate, ')');
const stillOk = g3.getStatus();
log('상태 보존 확인 → 마지막 출석일:', g3.toJSON().attendance.lastCheckInKey, '| 연속:', stillOk.streak, '(08-10, 1일차 그대로여야 정상)');

line();
log('✅ 데모 종료');
