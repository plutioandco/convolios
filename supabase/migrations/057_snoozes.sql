-- 057: Snoozes — "hide this until X" or "hide until they reply".
--
-- Two modes:
--   snooze_until TIMESTAMPTZ  — show again at this time
--   on_their_reply BOOLEAN    — show again when they send an inbound message
--
-- Snoozed persons fall into a 'snoozed' turn-state; they are excluded from
-- all other state views (my_turn / their_turn / stalled / dropped).

-- ─── 1. snoozes table ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS snoozes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  snooze_until TIMESTAMPTZ,
  on_their_reply BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT snooze_mode_nonempty CHECK (snooze_until IS NOT NULL OR on_their_reply = TRUE),
  CONSTRAINT snooze_one_per_person UNIQUE (person_id)
);

CREATE INDEX IF NOT EXISTS idx_snoozes_user ON snoozes(user_id);
CREATE INDEX IF NOT EXISTS idx_snoozes_until ON snoozes(snooze_until) WHERE snooze_until IS NOT NULL;

ALTER TABLE snoozes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS snoozes_select ON snoozes;
CREATE POLICY snoozes_select ON snoozes
  FOR SELECT USING (user_id = coalesce(auth.uid()::text, ''));

DROP POLICY IF EXISTS snoozes_insert ON snoozes;
CREATE POLICY snoozes_insert ON snoozes
  FOR INSERT WITH CHECK (user_id = coalesce(auth.uid()::text, ''));

DROP POLICY IF EXISTS snoozes_update ON snoozes;
CREATE POLICY snoozes_update ON snoozes
  FOR UPDATE USING (user_id = coalesce(auth.uid()::text, ''));

DROP POLICY IF EXISTS snoozes_delete ON snoozes;
CREATE POLICY snoozes_delete ON snoozes
  FOR DELETE USING (user_id = coalesce(auth.uid()::text, ''));

-- ─── 2. Auto-unsnooze on inbound reply (for on_their_reply mode) ────────────
CREATE OR REPLACE FUNCTION public.unsnooze_on_inbound()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.direction = 'inbound' AND NEW.person_id IS NOT NULL THEN
    DELETE FROM snoozes
     WHERE person_id = NEW.person_id
       AND on_their_reply = TRUE;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_unsnooze_on_inbound ON messages;
CREATE TRIGGER trg_unsnooze_on_inbound
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION public.unsnooze_on_inbound();

-- ─── 3. RPCs ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.snooze_person(
  p_person_id UUID,
  p_snooze_until TIMESTAMPTZ DEFAULT NULL,
  p_on_their_reply BOOLEAN DEFAULT FALSE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id TEXT;
BEGIN
  IF p_snooze_until IS NULL AND p_on_their_reply = FALSE THEN
    RAISE EXCEPTION 'Must provide snooze_until or on_their_reply';
  END IF;
  SELECT user_id INTO v_user_id FROM persons WHERE id = p_person_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Person not found';
  END IF;
  IF v_user_id <> coalesce(auth.uid()::text, '') THEN
    RAISE EXCEPTION 'Forbidden: user_id mismatch';
  END IF;
  INSERT INTO snoozes (user_id, person_id, snooze_until, on_their_reply)
    VALUES (v_user_id, p_person_id, p_snooze_until, p_on_their_reply)
  ON CONFLICT (person_id) DO UPDATE
    SET snooze_until = EXCLUDED.snooze_until,
        on_their_reply = EXCLUDED.on_their_reply,
        created_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.unsnooze_person(p_person_id UUID)
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
  DELETE FROM snoozes WHERE person_id = p_person_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.snooze_person(uuid, timestamptz, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unsnooze_person(uuid) TO authenticated;

-- ─── 4. Rebuild get_conversations with 'snoozed' state ──────────────────────
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
  done_at timestamptz,
  snooze_until timestamptz,
  snooze_on_their_reply boolean
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
  active_snoozes AS (
    -- A snooze is "active" if on_their_reply = true OR snooze_until > now().
    -- Expired snooze_until rows are ignored (surfaces as regular state) and
    -- can be cleaned up async; we don't race-condition on them here.
    SELECT s.person_id, s.snooze_until, s.on_their_reply
    FROM snoozes s
    WHERE s.user_id = p_user_id
      AND (s.on_their_reply = TRUE OR s.snooze_until > now())
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
        WHEN s.person_id IS NOT NULL THEN 'snoozed'
        WHEN p.done_at IS NOT NULL THEN 'done'
        WHEN l.last_direction = 'inbound' AND l.last_sent_at >= now() - interval '2 days' THEN 'my_turn'
        WHEN l.last_direction = 'inbound' THEN 'dropped'
        WHEN l.last_direction = 'outbound' AND l.last_sent_at >= now() - interval '3 days' THEN 'their_turn'
        WHEN l.last_direction = 'outbound' THEN 'stalled'
        ELSE 'their_turn'
      END AS turn_state,
      p.done_at,
      s.snooze_until,
      s.on_their_reply AS snooze_on_their_reply,
      p.status AS person_status
    FROM persons p
    LEFT JOIN latest l ON l.person_id = p.id
    LEFT JOIN counts c ON c.person_id = p.id
    LEFT JOIN active_snoozes s ON s.person_id = p.id
  )
  SELECT
    r.person_id, r.display_name, r.avatar_url, r.notes, r.ai_summary,
    r.channels, r.last_message_id, r.last_channel, r.last_direction,
    r.last_message_type, r.last_body_text, r.last_subject, r.last_attachments,
    r.last_sender_name, r.last_sent_at, r.last_triage, r.last_thread_id,
    r.last_external_id, r.last_seen, r.last_delivered,
    r.prev_inbound_body, r.prev_inbound_sender,
    r.unread_count, r.marked_unread, r.pinned_at,
    r.turn_state, r.done_at,
    r.snooze_until, r.snooze_on_their_reply
  FROM rows r
  WHERE r.last_message_id IS NOT NULL
    AND (
      (p_state = 'gate'     AND r.person_status = 'pending')
      OR (p_state IS NULL           AND r.person_status = p_status AND r.turn_state <> 'snoozed')
      OR (p_state IS NOT NULL AND p_state <> 'gate' AND r.person_status = p_status AND r.turn_state = p_state)
    )
    AND (p_circle_id IS NULL OR EXISTS (
      SELECT 1 FROM circle_members cm
      WHERE cm.person_id = r.person_id AND cm.circle_id = p_circle_id
    ))
  ORDER BY r.pinned_at IS NULL, r.pinned_at DESC, r.last_sent_at DESC;
$$;

-- ─── 5. Rebuild get_state_counts to include 'snoozed' ───────────────────────
CREATE OR REPLACE FUNCTION public.get_state_counts(p_user_id TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (m.person_id)
      m.person_id, m.direction AS last_direction, m.sent_at AS last_sent_at
    FROM messages m
    WHERE m.user_id = p_user_id
      AND m.person_id IS NOT NULL
      AND m.hidden IS NOT TRUE
      AND m.deleted IS NOT TRUE
    ORDER BY m.person_id, m.sent_at DESC
  ),
  active_snoozes AS (
    SELECT s.person_id FROM snoozes s
    WHERE s.user_id = p_user_id
      AND (s.on_their_reply = TRUE OR s.snooze_until > now())
  ),
  rows AS (
    SELECT
      CASE
        WHEN p.status = 'pending' THEN 'gate'
        WHEN s.person_id IS NOT NULL THEN 'snoozed'
        WHEN p.done_at IS NOT NULL THEN 'done'
        WHEN l.last_direction = 'inbound' AND l.last_sent_at >= now() - interval '2 days' THEN 'my_turn'
        WHEN l.last_direction = 'inbound' THEN 'dropped'
        WHEN l.last_direction = 'outbound' AND l.last_sent_at >= now() - interval '3 days' THEN 'their_turn'
        WHEN l.last_direction = 'outbound' THEN 'stalled'
        ELSE 'their_turn'
      END AS state,
      p.status AS person_status,
      l.person_id AS latest_person_id
    FROM persons p
    LEFT JOIN latest l ON l.person_id = p.id
    LEFT JOIN active_snoozes s ON s.person_id = p.id
    WHERE p.user_id = p_user_id
  )
  SELECT jsonb_build_object(
    'my_turn',     COUNT(*) FILTER (WHERE state = 'my_turn'    AND person_status = 'approved' AND latest_person_id IS NOT NULL),
    'their_turn',  COUNT(*) FILTER (WHERE state = 'their_turn' AND person_status = 'approved' AND latest_person_id IS NOT NULL),
    'stalled',     COUNT(*) FILTER (WHERE state = 'stalled'    AND person_status = 'approved' AND latest_person_id IS NOT NULL),
    'dropped',     COUNT(*) FILTER (WHERE state = 'dropped'    AND person_status = 'approved' AND latest_person_id IS NOT NULL),
    'done',        COUNT(*) FILTER (WHERE state = 'done'       AND person_status = 'approved' AND latest_person_id IS NOT NULL),
    'snoozed',     COUNT(*) FILTER (WHERE state = 'snoozed'    AND person_status = 'approved' AND latest_person_id IS NOT NULL),
    'gate',        COUNT(*) FILTER (WHERE person_status = 'pending' AND latest_person_id IS NOT NULL)
  )
  FROM rows;
$$;

GRANT EXECUTE ON FUNCTION public.get_state_counts(text) TO authenticated;
