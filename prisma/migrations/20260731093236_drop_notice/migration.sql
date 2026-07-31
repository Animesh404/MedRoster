-- CreateTable
CREATE TABLE "DropNotice" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "shiftId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "shiftStartsAt" TIMESTAMPTZ(3),
    "shiftEndsAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedAt" TIMESTAMPTZ(3),

    CONSTRAINT "DropNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DropNotice_userId_dismissedAt_idx" ON "DropNotice"("userId", "dismissedAt");

-- AddForeignKey
ALTER TABLE "DropNotice" ADD CONSTRAINT "DropNotice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill from EventOutbox.
--
-- Without this, anyone dropped shortly before this deploy silently loses their
-- notice the moment it ships — the exact harm that stopped the outbox being
-- pruned in the first place. The events are all still there today, so this is
-- the one moment the backfill is free.
--
-- Bounded to the last 48 hours, matching NOTICE_GRACE_MS in lib/rules/drop-notice.ts.
-- That is precisely the set of notices that would still be live if this table had
-- always existed. Backfilling the full outbox instead would resurrect months-old
-- drops as fresh banners on the day of deploy — every member who ever lost a shift
-- to an edit greeted by a wall of things they dealt with in April.
--
-- No replay guard is needed: this file CREATEs the table immediately above, so a
-- second run fails at the CREATE and never reaches these INSERTs.

-- Shift times: the live Shift row when it still exists, else that shift's own
-- event history. A shift that was retimed and LATER deleted has no Shift row,
-- and without the fallback its notice would carry no times at all — leaving the
-- member a bare shift number and no way to know which shift they lost.
INSERT INTO "DropNotice" ("userId", "shiftId", kind, reason, "shiftStartsAt", "shiftEndsAt", "createdAt")
SELECT DISTINCT ON (d."userId", d."shiftId", d."createdAt")
  d."userId",
  d."shiftId",
  'dropped',
  d.reason,
  COALESCE(
    s."startsAt",
    (SELECT (h.payload->>'startsAt')::timestamptz FROM "EventOutbox" h
      WHERE h.type IN ('shift.edited','shift.created')
        AND (h.payload->>'shiftId')::int = d."shiftId"
      ORDER BY h.id DESC LIMIT 1)
  ),
  COALESCE(
    s."endsAt",
    (SELECT (h.payload->>'endsAt')::timestamptz FROM "EventOutbox" h
      WHERE h.type IN ('shift.edited','shift.created')
        AND (h.payload->>'shiftId')::int = d."shiftId"
      ORDER BY h.id DESC LIMIT 1)
  ),
  d."createdAt"
FROM (
  -- DISTINCT ON collapses the duplicate a cross-week retime produces: moving a
  -- shift from one week to another emits shift.claims_dropped on BOTH topics,
  -- with identical payloads. Two events, one drop — the member lost the shift
  -- once and must be told once.
  SELECT
    (dr->>'userId')::int              AS "userId",
    (e.payload->>'shiftId')::int      AS "shiftId",
    COALESCE(dr->>'reason', 'You were removed from this shift.') AS reason,
    e."createdAt"                     AS "createdAt"
  FROM "EventOutbox" e
  CROSS JOIN LATERAL jsonb_array_elements(e.payload->'dropped') AS dr
  WHERE e.type = 'shift.claims_dropped'
    AND e."createdAt" > now() - interval '48 hours'
    AND (dr->>'userId') IS NOT NULL
) d
LEFT JOIN "Shift" s ON s.id = d."shiftId"
WHERE EXISTS (SELECT 1 FROM "User" u WHERE u.id = d."userId");

INSERT INTO "DropNotice" ("userId", "shiftId", kind, reason, "shiftStartsAt", "shiftEndsAt", "createdAt")
SELECT DISTINCT ON (aff::int, (e.payload->>'shiftId')::int, e."createdAt")
  aff::int,
  (e.payload->>'shiftId')::int,
  'deleted',
  'A manager deleted this shift.',
  -- The Shift row is gone by definition, so fall back to the most recent
  -- edit/creation event for that shift, exactly as the render-time code did.
  (SELECT (h.payload->>'startsAt')::timestamptz FROM "EventOutbox" h
    WHERE h.type IN ('shift.edited','shift.created')
      AND (h.payload->>'shiftId')::int = (e.payload->>'shiftId')::int
    ORDER BY h.id DESC LIMIT 1),
  (SELECT (h.payload->>'endsAt')::timestamptz FROM "EventOutbox" h
    WHERE h.type IN ('shift.edited','shift.created')
      AND (h.payload->>'shiftId')::int = (e.payload->>'shiftId')::int
    ORDER BY h.id DESC LIMIT 1),
  e."createdAt"
FROM "EventOutbox" e
CROSS JOIN LATERAL jsonb_array_elements_text(e.payload->'affectedUserIds') AS aff
WHERE e.type = 'shift.deleted'
  AND e."createdAt" > now() - interval '48 hours'
  AND EXISTS (SELECT 1 FROM "User" u WHERE u.id = aff::int);
