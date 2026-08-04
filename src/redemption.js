// redemption.js
// 모은 포인트를 "실물 비료"로 교환하는 로직 (캐릭터 성장과 무관).
// 교환 = 포인트 차감 + 주문 기록 생성. 배송/승인 등 상태를 관리합니다.
// ※ 배송지 등 개인정보는 여기서 보관하지 않습니다. 실제 신청 단계(프론트/백엔드)에서 처리하세요.

import { REWARDS, REDEMPTION_RULES } from './config.js';
import { toDateKey } from './dateUtil.js';

// 주문 상태 흐름: 신청 → 승인 → 발송 → 완료 (또는 취소)
export const ORDER_STATUS = {
  REQUESTED: 'requested', // 신청됨(포인트 차감 완료)
  APPROVED: 'approved',   // 관리자 승인
  SHIPPED: 'shipped',     // 발송
  DONE: 'done',           // 수령 완료
  CANCELED: 'canceled',   // 취소(포인트 환불 대상)
};

/** 교환 주문 기록 초기값 (사용자별) */
export function createRedemptionLog() {
  return [];
}

/**
 * 전체 재고 상태를 만듭니다. (전역 = 모든 사용자가 함께 소진)
 * 실제 서비스에선 이 값을 서버 DB에 두고 공유합니다.
 */
export function createCatalogStock() {
  const stock = {};
  for (const id of Object.keys(REWARDS)) stock[id] = REWARDS[id].stock ?? Infinity;
  return stock;
}

/** 'YYYY-MM-DD' → 'YYYY-MM' (월 단위 비교용) */
function monthKey(dateKey) {
  return dateKey.slice(0, 7);
}

/** 해당 월에 사용자가 이미 교환한 횟수 (취소 건 제외) */
export function countRedemptionsInMonth(log, dateKey) {
  const mk = monthKey(dateKey);
  return log.filter((o) => o.status !== ORDER_STATUS.CANCELED && monthKey(o.requestedKey) === mk).length;
}

/**
 * 포인트로 실물 비료를 교환 신청합니다.
 * @param {number} points - 현재 보유 포인트
 * @param {Array} log - createRedemptionLog()로 만든 사용자별 주문 목록
 * @param {string} rewardId - 'organic_small' | 'compound_mid' | 'bulk_large'
 * @param {Date|string} when - 신청 시각(또는 'YYYY-MM-DD')
 * @param {object|null} stock - createCatalogStock()로 만든 전역 재고 (없으면 재고 무제한)
 * @returns {{ ok:boolean, spent:number, remainingPoints:number, order?:object, message:string }}
 */
export function redeem(points, log, rewardId, when = new Date(), stock = null) {
  const item = REWARDS[rewardId];
  if (!item) {
    return { ok: false, spent: 0, remainingPoints: points, message: `없는 교환 상품입니다: ${rewardId}` };
  }

  const dayKey = typeof when === 'string' ? when : toDateKey(when);

  // (1) 월 교환 횟수 제한
  const usedThisMonth = countRedemptionsInMonth(log, dayKey);
  if (usedThisMonth >= REDEMPTION_RULES.monthlyLimitPerUser) {
    return {
      ok: false,
      spent: 0,
      remainingPoints: points,
      message: `이번 달 교환 한도(${REDEMPTION_RULES.monthlyLimitPerUser}회)를 모두 사용했어요.`,
    };
  }

  // (2) 재고 확인
  if (stock && (stock[rewardId] ?? Infinity) < 1) {
    return { ok: false, spent: 0, remainingPoints: points, message: `${item.name}가 품절됐어요.` };
  }

  // (3) 포인트 확인
  if (points < item.pointCost) {
    return {
      ok: false,
      spent: 0,
      remainingPoints: points,
      message: `포인트가 부족해요. (필요 ${item.pointCost}P / 보유 ${points}P)`,
    };
  }

  // 재고 차감 (전역)
  if (stock && Number.isFinite(stock[rewardId])) stock[rewardId] -= 1;

  const order = {
    orderId: `R${log.length + 1}`,
    rewardId: item.id,
    name: item.name,
    realItem: item.realItem,
    pointCost: item.pointCost,
    requestedKey: dayKey,
    status: ORDER_STATUS.REQUESTED,
  };
  log.push(order);

  return {
    ok: true,
    spent: item.pointCost,
    remainingPoints: points - item.pointCost,
    order,
    message: `${item.emoji} ${item.name} 교환 신청 완료! (-${item.pointCost}P) · 주문번호 ${order.orderId}`,
  };
}

/**
 * 주문 상태를 변경합니다. (관리자 승인/발송 처리 등)
 * 취소 시: 차감 포인트를 환불 대상으로 알려주고, 재고를 되돌립니다.
 * @param {object|null} stock - createCatalogStock()로 만든 전역 재고 (취소 시 재고 복원용)
 * @returns {{ ok:boolean, refundPoints:number, order?:object, message:string }}
 */
export function updateOrderStatus(log, orderId, status, stock = null) {
  if (!Object.values(ORDER_STATUS).includes(status)) {
    return { ok: false, refundPoints: 0, message: `알 수 없는 상태: ${status}` };
  }
  const order = log.find((o) => o.orderId === orderId);
  if (!order) {
    return { ok: false, refundPoints: 0, message: `주문을 찾을 수 없어요: ${orderId}` };
  }
  if (order.status === ORDER_STATUS.CANCELED) {
    return { ok: false, refundPoints: 0, order, message: '이미 취소된 주문이에요.' };
  }

  // 취소는 "발송 전"(신청/승인)에만 허용 — 이미 실물이 나간 주문은 환불 불가
  if (status === ORDER_STATUS.CANCELED) {
    const cancelable = order.status === ORDER_STATUS.REQUESTED || order.status === ORDER_STATUS.APPROVED;
    if (!cancelable) {
      return {
        ok: false,
        refundPoints: 0,
        order,
        message: `이미 '${order.status}' 상태라 취소할 수 없어요. (발송 전에만 취소 가능)`,
      };
    }
  }

  order.status = status;
  // 취소 시: 포인트 환불 대상 + 재고 복원 (실제 포인트 반영은 호출부에서)
  let refundPoints = 0;
  if (status === ORDER_STATUS.CANCELED) {
    refundPoints = order.pointCost;
    if (stock && Number.isFinite(stock[order.rewardId])) stock[order.rewardId] += 1;
  }
  return { ok: true, refundPoints, order, message: `주문 ${orderId} 상태 → ${status}` };
}
