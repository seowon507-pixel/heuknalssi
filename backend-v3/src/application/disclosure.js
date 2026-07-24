const PUBLIC_SOURCE_FIELDS = Object.freeze([
  'sourceId',
  'sourceName',
  'sourceUrl',
  'retrievedAt',
  'observedAt',
  'issuedAt',
  'validFrom',
  'validTo',
  'spatialLevel',
  'spatialLabel',
  'distanceKm',
  'deliveryState',
  'adapterState',
  'qualityFlags',
]);

export function toSourceDisclosure(envelope) {
  const disclosure = {};
  for (const field of PUBLIC_SOURCE_FIELDS) {
    disclosure[field] =
      field === 'qualityFlags' ? [...(envelope.qualityFlags ?? [])] : (envelope[field] ?? null);
  }
  return Object.freeze(disclosure);
}

export function collectSourceDisclosures(envelopes) {
  return envelopes.filter(Boolean).map(toSourceDisclosure);
}

export function envelopeHasCurrentData(envelope) {
  return (
    envelope?.adapterState === 'SUCCESS' &&
    envelope.deliveryState !== 'UNAVAILABLE' &&
    envelope.freshness === 'CURRENT' &&
    envelope.data != null
  );
}

export function envelopeHasUsableData(envelope) {
  return (
    envelope?.adapterState === 'SUCCESS' &&
    envelope.deliveryState !== 'UNAVAILABLE' &&
    envelope.data != null
  );
}

export function unavailableModule(reason, state = 'UNAVAILABLE') {
  return Object.freeze({
    state,
    coverage: null,
    blockingReasons: [reason],
    missingInputs: [],
    qualityFlags: [],
    result: null,
    evidence: [],
  });
}

export function notApplicableModule() {
  return Object.freeze({
    state: 'NOT_APPLICABLE',
    coverage: null,
    blockingReasons: [],
    missingInputs: [],
    qualityFlags: [],
    result: null,
    evidence: [],
  });
}
