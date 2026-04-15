-- 046: Harden new RPCs added in 044/045.
--
-- reassign_thread_person (045): SECURITY DEFINER, no auth.uid() check, no REVOKE.
--   Only called from the Edge Function (service role). Frontend must not execute it.
--
-- sync_person_pin (044): SECURITY DEFINER, no auth.uid() check, no REVOKE.
--   Only called from Rust startup_sync (service role).
--
-- get_flagged_messages (044): Missing hidden/deleted filter, inconsistent with
--   get_conversations which excludes hidden and deleted messages.

-- ─── Security: revoke client access to service-role-only RPCs ───────────────

REVOKE EXECUTE ON FUNCTION public.reassign_thread_person(text, text, uuid, uuid, uuid)
  FROM authenticated, anon, public;

REVOKE EXECUTE ON FUNCTION public.sync_person_pin(text, uuid, boolean)
  FROM authenticated, anon, public;

-- ─── Fix get_flagged_messages: exclude hidden/deleted messages ───────────────

CREATE OR REPLACE FUNCTION public.get_flagged_messages(p_user_id text)
RETURNS TABLE (
  message_id uuid,
  person_id uuid,
  display_name text,
  avatar_url text,
  channel text,
  direction text,
  body_text text,
  subject text,
  body_html text,
  attachments jsonb,
  sender_name text,
  sent_at timestamptz,
  flagged_at timestamptz,
  external_id text,
  thread_id text,
  deleted boolean
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    m.id AS message_id,
    m.person_id,
    p.display_name,
    p.avatar_url,
    m.channel,
    m.direction,
    m.body_text,
    m.subject,
    m.body_html,
    m.attachments,
    m.sender_name,
    m.sent_at,
    m.flagged_at,
    m.external_id,
    m.thread_id,
    m.deleted
  FROM messages m
  JOIN persons p ON p.id = m.person_id
  WHERE m.user_id = p_user_id
    AND m.flagged_at IS NOT NULL
    AND m.hidden IS NOT TRUE
    AND m.deleted IS NOT TRUE
  ORDER BY m.flagged_at DESC;
$$;
