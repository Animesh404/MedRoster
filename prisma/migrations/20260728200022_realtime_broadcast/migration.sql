-- Turn every outbox insert into a Supabase Realtime broadcast (§7.1).
-- Emitting from a trigger rather than from application code is what ties the
-- event to the transaction: a rolled-back mutation never broadcasts, and a
-- committed one always does.
CREATE OR REPLACE FUNCTION public.broadcast_outbox_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
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
  RETURN NEW;
END;
$$;

-- Only install the trigger where Supabase Realtime is present. Plain
-- Postgres (Testcontainers, CI, `docker compose up`) has no `realtime`
-- schema, so an unguarded CREATE TRIGGER would make every migration fail
-- there. The EventOutbox row is written either way, so GET /api/events/since
-- — and therefore replay and the polling fallback — works identically
-- without Supabase.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'realtime') THEN
    CREATE TRIGGER outbox_broadcast
      AFTER INSERT ON "EventOutbox"
      FOR EACH ROW EXECUTE FUNCTION public.broadcast_outbox_event();
  END IF;
END $$;
