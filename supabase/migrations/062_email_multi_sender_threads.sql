-- =============================================================================
-- Migration 062: Allow multiple senders per Gmail thread
--
-- The DM thread ownership trigger (migration 034) enforces "one person per
-- thread" which is correct for IM channels (WhatsApp, LinkedIn, etc.) — a
-- DM chat has one counterparty.
--
-- It is WRONG for email: Gmail threads legitimately contain messages from
-- multiple distinct senders (forwarded mail, reply-all, mixed correspondence
-- under a shared subject). Under the old rule, the first sender on a thread
-- claimed it, and subsequent senders had their messages either forced onto
-- the wrong person (backfill) or silently rejected (webhook). This caused
-- unrelated contacts — e.g. Emirates Airlines and Emirates NBD — to collapse
-- into a single person record whenever Gmail threaded them together.
--
-- Fix: exempt channel='email' from the DM thread ownership check. Email is
-- grouped by person (actual sender), not by thread. Thread_id remains the
-- Gmail thread id for reference/display.
-- =============================================================================

CREATE OR REPLACE FUNCTION check_dm_thread_ownership()
RETURNS TRIGGER AS $$
DECLARE
  existing_person_id uuid;
BEGIN
  IF NEW.message_type <> 'dm' THEN
    RETURN NEW;
  END IF;

  IF NEW.channel = 'email' THEN
    RETURN NEW;
  END IF;

  SELECT DISTINCT m.person_id INTO existing_person_id
  FROM messages m
  WHERE m.thread_id = NEW.thread_id
    AND m.message_type = 'dm'
    AND m.channel <> 'email'
    AND m.person_id <> NEW.person_id
  LIMIT 1;

  IF existing_person_id IS NOT NULL THEN
    RAISE EXCEPTION
      'DM thread % already belongs to person %, cannot assign to person %',
      NEW.thread_id, existing_person_id, NEW.person_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
