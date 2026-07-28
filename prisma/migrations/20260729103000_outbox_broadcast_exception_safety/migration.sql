-- The trigger this function backs (`outbox_broadcast`, installed only when a
-- `realtime` schema exists — see 20260728200022) fires AFTER INSERT, in the
-- SAME transaction as the mutation that inserted the outbox row. Without an
-- exception handler, any error `realtime.send` raises — a permissions
-- problem, a `realtime.messages` constraint, a quota or backlog error —
-- propagates out of the trigger and aborts the ENTIRE outer transaction, not
-- just the broadcast. That rolls back the outbox insert *and* the original
-- mutation that caused it (e.g. a nurse's legitimate shift claim), for a
-- failure that is otherwise fully recoverable: a client that misses a
-- broadcast catches up via `GET /api/events/since`, but a rolled-back claim
-- is simply lost. A lost broadcast must never be allowed to cost a lost
-- claim, so a broadcast failure is caught here and only logged.
--
-- This replaces the function body only (`CREATE OR REPLACE FUNCTION`); the
-- already-applied 20260728200022 migration is left untouched so anyone who
-- has already run it stays in sync via this follow-up rather than via an
-- edit to migration history. The function is (re)defined unconditionally —
-- exactly like the original migration — because a plpgsql function body is
-- opaque text at CREATE time; `realtime.send` inside it is only resolved
-- when the trigger actually fires, which happens only where the `realtime`
-- schema (and therefore the trigger itself) exists. That's what lets this
-- migration apply cleanly to plain Postgres (Testcontainers, CI, `docker
-- compose up`) with no `realtime` schema at all.
CREATE OR REPLACE FUNCTION public.broadcast_outbox_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  BEGIN
    PERFORM realtime.send(
      jsonb_build_object(
        'id',         NEW.id::text,
        'type',       NEW.type,
        'payload',    NEW.payload,
        'mutationId', NEW."mutationId"
      ),
      NEW.type,
      NEW.topic,
      false               -- public channel; membership is already gated by app auth
    );
  EXCEPTION WHEN OTHERS THEN
    -- Swallow: the outbox row (and the mutation that produced it) must
    -- commit regardless. The client-facing replay path (`GET
    -- /api/events/since`) is unaffected by a broadcast failure since it
    -- reads `EventOutbox` directly, not the broadcast channel.
    RAISE WARNING 'outbox broadcast failed for event %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;
