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
-- Shift times come from the live Shift row where it still exists. For a DELETED
-- shift they are recovered from that shift's own event history, which is what
-- the old render-time code did; NULL when neither source has them, which the UI
-- already handles.
INSERT INTO "DropNotice" ("userId", "shiftId", kind, reason, "shiftStartsAt", "shiftEndsAt", "createdAt")
SELECT
  (d->>'userId')::int,
  (e.payload->>'shiftId')::int,
  'dropped',
  COALESCE(d->>'reason', 'You were removed from this shift.'),
  s."startsAt",
  s."endsAt",
  e."createdAt"
FROM "EventOutbox" e
CROSS JOIN LATERAL jsonb_array_elements(e.payload->'dropped') AS d
LEFT JOIN "Shift" s ON s.id = (e.payload->>'shiftId')::int
WHERE e.type = 'shift.claims_dropped'
  AND (d->>'userId') IS NOT NULL
  AND EXISTS (SELECT 1 FROM "User" u WHERE u.id = (d->>'userId')::int);

INSERT INTO "DropNotice" ("userId", "shiftId", kind, reason, "shiftStartsAt", "shiftEndsAt", "createdAt")
SELECT
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
    WHERE h.type = 'shift.edited'
      AND (h.payload->>'shiftId')::int = (e.payload->>'shiftId')::int
    ORDER BY h.id DESC LIMIT 1),
  e."createdAt"
FROM "EventOutbox" e
CROSS JOIN LATERAL jsonb_array_elements_text(e.payload->'affectedUserIds') AS aff
WHERE e.type = 'shift.deleted'
  AND EXISTS (SELECT 1 FROM "User" u WHERE u.id = aff::int);
