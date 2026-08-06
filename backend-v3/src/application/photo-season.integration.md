# Photo/season integration contract

`photo-season.js` is transport- and vendor-neutral. The HTTP integrator supplies
the following server-side ports to `createPhotoSeasonService`.

## Persistence ports

- `photoRepository.insertPhoto(metadata)`: stores only private object paths and
  user metadata. It does not embed a comparison result.
- `photoRepository.findPhoto({ farmId, photoId })`: applies account ownership in
  the adapter and returns the stored metadata only when it belongs to `farmId`.
- `photoRepository.insertComparison(comparison)`: stores the separate,
  structured comparison row.
- `photoRepository.listPhotosBySeason(scope)` and
  `listComparisonsBySeason(scope)`: query by the complete
  `farmId + cropId + seasonId` scope.
- `photoRepository.deletePhotoBundle({ farmId, photoId, deletedAt })`: in one
  database transaction, removes the metadata and every comparison that
  references the photo. It must be safe to retry.
- `seasonRepository.findSeason(scope)`: returns the exact scoped season.
- `seasonRepository.completeSeason({ scope, expectedStatus, endedAt, summary })`:
  atomically changes `ACTIVE` to `COMPLETED` and stores the supplied summary.
  A concurrent or repeated transition must fail its `expectedStatus` check.
- `actionRepository.listActionsBySeason(scope)` and
  `riskRepository.listRisksBySeason(scope)`: return persisted events for the
  complete scope. The domain rejects cross-scope rows instead of filtering them
  silently.

All persistence adapters are shared, durable sources of truth. Process memory is
not an implementation of these production ports.

## Private object storage port

- `objectStorage.commitUpload({ uploadToken, photoId, farmId, cropId, seasonId })`
  validates a short-lived opaque token on the server and returns
  `{ objectPath, thumbnailPath }`. Neither path is sent to the browser.
- `objectStorage.deleteObjects({ objectPaths })` deletes the original and
  thumbnail and must be idempotent. The service deletes objects before the
  database bundle so a retry cannot leave private image bytes behind.

Consent is checked before `commitUpload`. If metadata validation or persistence
fails after the commit, the service attempts to delete the committed objects.

## HTTP and UI integration steps

1. Assemble these adapters in the server composition root. Keep service-role
   credentials and private object paths server-only.
2. On `POST /api/farms/:farmId/photos`, enforce session ownership, CSRF, upload
   size/type limits, and idempotency, then call `addPhoto`. The request supplies
   an opaque upload token, explicit `GRANTED` consent, `cropId`, `seasonId`, and
   user `observedAt`; the server creates `createdAt`.
3. Add a confirmed delete route that calls `deletePhoto({ confirmed: true })`.
   Do not expose deletion through an unconfirmed assistant proposal.
4. Feed only reviewed `COLOR`, `AREA`, or `SHAPE` observations to
   `comparePhotos`. Never forward free-form model conclusions as observations.
5. Wire `GET /api/farms/:farmId/seasons/:seasonId/timeline` to
   `getSeasonTimeline` and the confirmed completion route to `completeSeason`.
   Resolve `cropId` from the owned season or require it and verify the match.
6. Pass the returned public records to `ui-integration/photo-season.mjs`.
   Mount its markup in the existing shell and add the shell's standard focus,
   loading, error, and confirmation behavior. A missing photo history is shown
   as optional `UNAVAILABLE`; it does not change the product's climate, soil,
   observation, or forecast states to `HOLD`.
