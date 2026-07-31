/**
 * 동기 저장소 인터페이스를 유지하면서 요청 사이에 값을 남기는 다리.
 *
 * 도메인·응용 계층은 `TtlMemoryStore`를 동기로 쓴다. 전부 async로 바꾸면
 * 손댈 곳이 너무 많고, 그만큼 회귀 위험도 커진다. 대신 서버리스가 실제로
 * 동작하는 방식에 맞춘다.
 *
 *   요청 시작 → 필요한 키만 공유 저장소에서 읽어 메모리에 채운다(hydrate)
 *   요청 처리 → 기존 동기 코드가 그대로 돈다
 *   요청 종료 → 이번 요청에서 바뀐 키만 공유 저장소에 쓴다(flush)
 *
 * 읽지도 쓰지도 않은 키는 건드리지 않는다. 매 요청 전체를 실어 나르면
 * 느려지고, 동시에 처리된 다른 요청의 변경을 덮어쓴다.
 *
 * 공유 저장소가 없거나 실패하면 메모리 저장소로 그대로 동작한다. 알림·이관
 * 같은 보조 기능이 꺼질 뿐 분석은 계속되어야 한다.
 */

import { TtlMemoryStore } from "./ttl-memory-store.js";

export function createPersistentStore({
  kv = null,
  // 세션·후보·분석이 하나의 공유 표를 쓰므로 종류별 접두어로 나눈다.
  // 메모리 쪽 키는 그대로 두고 공유 저장소로 나갈 때만 붙인다.
  namespace,
  clock = Date.now,
  capacityPolicy = "evict-soonest",
  maxEntries,
  onError = null,
} = {}) {
  const memory = new TtlMemoryStore({
    clock,
    capacityPolicy,
    ...(Number.isFinite(maxEntries) ? { maxEntries } : {}),
  });
  if (typeof namespace !== "string" || namespace === "") {
    throw new TypeError("persistent store requires a namespace");
  }
  const enabled = Boolean(kv?.configured);
  // 이번 요청에서 바뀐 키. 값이 null이면 삭제를 뜻한다.
  const dirty = new Map();
  const hydrated = new Set();

  const scoped = (key) => `${namespace}:${key}`;

  function reportError(error) {
    if (typeof onError === "function") onError(error);
  }

  const store = {
    set(key, value, ttlMs) {
      const stored = memory.set(key, value, ttlMs);
      if (enabled) dirty.set(key, { value, ttlMs });
      return stored;
    },
    get(key) {
      return memory.get(key);
    },
    has(key) {
      return memory.has(key);
    },
    delete(key) {
      const removed = memory.delete(key);
      if (enabled) dirty.set(key, null);
      return removed;
    },
    clear() {
      memory.clear();
      dirty.clear();
      hydrated.clear();
    },
    sweep() {
      return memory.sweep();
    },
    get size() {
      return memory.size;
    },
  };

  return Object.freeze({
    store,
    enabled,

    /**
     * 이번 요청이 건드릴 키를 공유 저장소에서 채운다.
     * 이미 채웠거나 메모리에 살아 있는 키는 다시 받지 않는다.
     */
    async hydrate(keys, { ttlMs }) {
      if (!enabled) return;
      const wanted = [...new Set((keys ?? []).filter(Boolean))].filter(
        (key) => !hydrated.has(key) && !memory.has(key),
      );
      if (wanted.length === 0) return;
      try {
        const found = await kv.getMany(wanted.map(scoped));
        for (const key of wanted) {
          hydrated.add(key);
          if (!found.has(scoped(key))) continue;
          // 되살린 값은 아직 '바뀐 것'이 아니다. dirty에 넣지 않는다.
          memory.set(key, found.get(scoped(key)), ttlMs);
        }
      } catch (error) {
        // 공유 저장소가 답이 없어도 요청은 진행한다. 이 요청에서는 결과가
        // 이 인스턴스에만 남는다는 뜻이며, 그 사실은 응답에 드러난다.
        reportError(error);
      }
    },

    /** 이번 요청에서 바뀐 키만 공유 저장소에 반영한다. */
    async flush() {
      if (!enabled || dirty.size === 0) return;
      const pending = [...dirty.entries()];
      dirty.clear();
      await Promise.all(
        pending.map(async ([key, change]) => {
          try {
            if (change === null) {
              await kv.delete(scoped(key));
              return;
            }
            await kv.set(scoped(key), change.value, change.ttlMs);
          } catch (error) {
            reportError(error);
          }
        }),
      );
    },
  });
}
