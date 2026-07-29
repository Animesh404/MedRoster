-- Realtime delivery, fixed in two parts.
--
-- PART 1 — the broadcast carries no data.
--
-- The client never reads the payload: reconciliation is a router.refresh(), so
-- all it needs is "something changed on this topic" plus enough to advance its
-- cursor (id) and drop its own echo (mutationId). Sending the full payload put
-- staff names and user ids on a channel that anyone holding the *publishable*
-- key can subscribe to. Broadcasting a signal instead of data removes that
-- exposure entirely rather than trying to guard it.
--
-- The EventOutbox row keeps the full payload — /api/events/since serves it, and
-- that endpoint is behind withAuth.
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
        'mutationId', NEW."mutationId"
      ),
      NEW.type,
      NEW.topic,
      false
    );
  EXCEPTION WHEN OTHERS THEN
    -- A broadcast failure must never roll back the mutation that caused it.
    -- A lost broadcast is recoverable (the client replays via
    -- /api/events/since); a lost claim is not.
    RAISE WARNING 'outbox broadcast failed for event %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

-- PART 2 — let subscribers actually read the broadcast.
--
-- Supabase ships realtime.messages with RLS ENABLED and no policies, which
-- denies everything: the database emitted correctly and every subscriber was
-- silently blocked. Scoped to this app's own `week:` topics so the policy grants
-- nothing beyond what it needs.
--
-- Guarded because plain Postgres has no realtime schema — the same reason the
-- trigger itself is guarded.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'realtime') THEN
    DROP POLICY IF EXISTS "medroster reads week broadcasts" ON realtime.messages;
    CREATE POLICY "medroster reads week broadcasts"
      ON realtime.messages
      FOR SELECT
      TO anon, authenticated
      USING (topic LIKE 'week:%');
  END IF;
END $$;
