# Backend v3 Project Instructions

## Scope

- Backend API and deterministic domain logic only. Do not add frontend files.
- The authoritative product logic is `../09_흙날씨진단_서비스로직_명세서.md`.
- The legacy v2 reference outside this repository is evidence only and must not be copied.

## Safety invariants

- Never combine climate, soil, observations, forecasts, smartfarm, or satellite into one score.
- Missing values stay `null`; never coerce an empty value to zero.
- Unverified adapters and rules return `HOLD`, `UNAVAILABLE`, or `UNSUPPORTED`.
- LLM output cannot create facts, numbers, causes, diagnoses, pesticide/fertilizer instructions, or actions.
- Do not read, copy, log, or commit secret-bearing `.env` files.

## Commands

- Tests: `npm test`
- Static project check: `npm run check`
- Local server: `npm start`

## Code boundaries

- `src/domain`: pure deterministic functions only.
- `src/adapters`: provider normalization and `DataEnvelope`.
- `src/application`: orchestration.
- `src/infrastructure`: sessions, stores, rate limits, idempotency.
- `src/api` and `server`: HTTP transport only.

## Collaboration

- Multiple developers share this tree. Edit only assigned files.
- Do not revert or overwrite another developer's changes.
- Add deterministic tests for every non-trivial behavior.
