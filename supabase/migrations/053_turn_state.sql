-- 053: Turn-state data layer.
--
-- Introduces the state-primary axis that drives the new sidebar. Turn state is
-- DERIVED from (direction, sent_at) on the latest message + person.status +
-- person.done_at — no new state columns on messages needed.
--
-- States (mutually exclusive, priority order):
--   gate        — persons.status = 'pending' (awaiting screener approval)
--   done        — persons.done_at IS NOT NULL (user marked explicitly)
--   my_turn     — last message inbound, <2d old
--   dropped     — last message inbound, >=2d old (I've been ignoring them)
--   their_turn  — last message outbound, <3d old
--   stalled     — last message outbound, >=3d old (they've been ghosting)
--
-- Thresholds are constants for now; later moved to per-circle settings.

-- ─── 1. persons.done_at ──────────────────────────────────────────────────────
ALTER TABLE persons ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_persons_done_at
  ON persons(user_id, done_at)
  WHERE done_at IS NOT NULL;

-- ─── 2. Auto-clear done_at when a new inbound message arrives ────────────────
-- "Done" means "handled, don't show it again until they re-engage."
-- As soon as they send a new message, the person is not done anymore.

CREATE OR REPLACE FUNCTION public.clear_done_on_inbound()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.direction = 'inbound' AND NEW.person_id IS NOT NULL THEN
    UPDATE persons
       SET done_at = NULL
     WHERE id = NEW.person_id
       AND done_at IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clear_done_on_inbound ON messages;
CREATE TRIGGER trg_clear_done_on_inbound
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION public.clear_done_on_inbound();

-- ─── 3. mark_person_done / unmark_person_done RPCs ───────────────────────────
CREATE OR REPLACE FUNCTION public.mark_person_done(p_person_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id TEXT;
BEGIN
  SELECT user_id INTO v_user_id FROM persons WHERE id = p_person_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Person not found';
  END IF;
  IF v_user_id <> coalesce(auth.uid()::text, '') THEN
    RAISE EXCEPTION 'Forbidden: user_id mismatch';
  END IF;
  UPDATE persons SET done_at = now() WHERE id = p_person_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.unmark_person_done(p_person_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id TEXT;
BEGIN
  SELECT user_id INTO v_user_id FROM persons WHERE id = p_person_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Person not found';
  END IF;
  IF v_user_id <> coalesce(auth.uid()::text, '') THEN
    RAISE EXCEPTION 'Forbidden: user_id mismatch';
  END IF;
  UPDATE persons SET done_at = NULL WHERE id = p_person_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_person_done(uuid)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.unmark_person_done(uuid) TO authenticated;

-- ─── 4. Extend get_conversations with p_state filter + turn_state column ─────
-- Replaces the 3-arg version from migration 050.

DROP FUNCTION IF EXISTS public.get_conversations(text, text, uuid);
DROP FUNCTION IF EXISTS public.get_conversations(text, text, uuid, text);

CREATE OR REPLACE FUNCTION public.get_conversations(
  p_user_id text,
  p_status text DEFAULT 'approved',
  p_circle_id uuid DEFAULT NULL,
  p_state text DEFAULT NULL
)
RETURNS TABLE (
  person_id uuid,
  display_name text,
  avatar_url text,
  notes text,
  ai_summary text,
  channels text[],
  last_message_id uuid,
  last_channel text,
  last_direction text,
  last_message_type text,
  last_body_text text,
  last_subject text,
  last_attachments jsonb,
  last_sender_name text,
  last_sent_at timestamptz,
  last_triage text,
  last_thread_id text,
  last_external_id text,
  last_seen boolean,
  last_delivered boolean,
  prev_inbound_body text,
  prev_inbound_sender text,
  unread_count bigint,
  marked_unread boolean,
  pinned_at timestamptz,
  turn_state text,
  done_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (m.person_id)
      m.person_id,
      m.id AS last_message_id,
      m.channel AS last_channel,
      m.direction AS last_direction,
      m.message_type AS last_message_type,
      m.body_text AS last_body_text,
      m.subject AS last_subject,
      m.attachments AS last_attachments,
      m.sender_name AS last_sender_name,
      m.sent_at AS last_sent_at,
      m.triage AS last_triage,
      m.thread_id AS last_thread_id,
      m.external_id AS last_external_id,
      m.seen AS last_seen,
      m.delivered AS last_delivered
    FROM messages m
    WHERE m.user_id = p_user_id
      AND m.user_id = coalesce(auth.uid()::text, '')
      AND m.person_id IS NOT NULL
      AND m.hidden IS NOT TRUE
      AND m.deleted IS NOT TRUE
    ORDER BY m.person_id, m.sent_at DESC
  ),
  counts AS (
    SELECT m.person_id, COUNT(*) AS unread_count
    FROM messages m
    WHERE m.user_id = p_user_id
      AND m.direction = 'inbound'
      AND m.read_at IS NULL
      AND m.hidden IS NOT TRUE
      AND m.deleted IS NOT TRUE
      AND m.person_id IS NOT NULL
    GROUP BY m.person_id
  ),
  rows AS (
    SELECT
      p.id AS person_id,
      p.display_name,
      p.avatar_url,
      p.notes,
      p.ai_summary,
      (SELECT array_agg(DISTINCT i.channel) FROM identities i WHERE i.person_id = p.id) AS channels,
      l.last_message_id,
      l.last_channel,
      l.last_direction,
      l.last_message_type,
      l.last_body_text,
      l.last_subject,
      l.last_attachments,
      l.last_sender_name,
      l.last_sent_at,
      l.last_triage,
      l.last_thread_id,
      l.last_external_id,
      l.last_seen,
      l.last_delivered,
      NULL::text AS prev_inbound_body,
      NULL::text AS prev_inbound_sender,
      COALESCE(c.unread_count, 0) AS unread_count,
      COALESCE(p.marked_unread, false) AS marked_unread,
      p.pinned_at,
      CASE
        WHEN p.status = 'pending' THEN 'gate'
        WHEN p.done_at IS NOT NULL THEN 'done'
        WHEN l.last_direction = 'inbound' AND l.last_sent_at >= now() - interval '2 days' THEN 'my_turn'
        WHEN l.last_direction = 'inbound' THEN 'dropped'
        WHEN l.last_direction = 'outbound' AND l.last_sent_at >= now() - interval '3 days' THEN 'their_turn'
        WHEN l.last_direction = 'outbound' THEN 'stalled'
        ELSE 'their_turn'
      END AS turn_state,
      p.done_at,
      p.status AS person_status
    FROM persons p
    LEFT JOIN latest l ON l.person_id = p.id
    LEFT JOIN counts c ON c.person_id = p.id
  )
  SELECT
    r.person_id, r.display_name, r.avatar_url, r.notes, r.ai_summary,
    r.channels, r.last_message_id, r.last_channel, r.last_direction,
    r.last_message_type, r.last_body_text, r.last_subject, r.last_attachments,
    r.last_sender_name, r.last_sent_at, r.last_triage, r.last_thread_id,
    r.last_external_id, r.last_seen, r.last_delivered,
    r.prev_inbound_body, r.prev_inbound_sender,
    r.unread_count, r.marked_unread, r.pinned_at,
    r.turn_state, r.done_at
  FROM rows r
  WHERE r.last_message_id IS NOT NULL
    AND (
      (p_state = 'gate'     AND r.person_status = 'pending')
      OR (p_state IS NULL           AND r.person_status = p_status)
      OR (p_state IS NOT NULL AND p_state <> 'gate' AND r.person_status = p_status AND r.turn_state = p_state)
    )
    AND (p_circle_id IS NULL OR EXISTS (
      SELECT 1 FROM circle_members cm
      WHERE cm.person_id = r.person_id AND cm.circle_id = p_circle_id
    ))
  ORDER BY r.pinned_at IS NULL, r.pinned_at DESC, r.last_sent_at DESC;
$$;
