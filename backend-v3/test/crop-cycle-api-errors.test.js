import assert from "node:assert/strict";
import test from "node:test";

import { normalizeApiError } from "../src/api/errors.js";
import { DomainError } from "../src/domain/errors.js";

test("crop-cycle domain errors preserve their public status and retry policy", () => {
  const cases = [
    ["CROP_CYCLE_NOT_FOUND", 404, false],
    ["CROP_CYCLE_UPDATE_CONFLICT", 409, true],
    ["CROP_CYCLE_COMPLETED", 409, false],
    ["CROP_CYCLE_COMPLETE_CONFIRMATION_REQUIRED", 409, false],
    ["CROP_CYCLE_ACTIVE_DATE_INVALID", 400, false],
    ["CROP_CYCLE_SCOPE_INVALID", 400, false],
  ];

  for (const [code, status, retryable] of cases) {
    const normalized = normalizeApiError(new DomainError(code, "internal detail"));
    assert.equal(normalized.code, code);
    assert.equal(normalized.status, status);
    assert.equal(normalized.retryable, retryable);
    assert.doesNotMatch(normalized.message, /internal detail/u);
  }
});
