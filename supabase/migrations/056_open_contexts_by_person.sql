-- 056: Aggregate open questions/commitments per person.
--
-- Used by the inbox list to badge rows without N+1 per-row subqueries.
-- Single round-trip → cached client-side for 30s → synchronous lookups per row.

CREATE OR REPLACE FUNCTION public.get_open_contexts_by_person(p_user_id TEXT)
RETURNS TABLE (
  person_id UUID,
  open_questions BIGINT,
  open_my_commitments BIGINT,
  open_their_commitments BIGINT
)
LANGUAGE sql
STABLE
AS $$
  WITH q AS (
    SELECT person_id, COUNT(*) AS n
    FROM unanswered_questions
    WHERE user_id = p_user_id AND resolved_at IS NULL
    GROUP BY person_id
  ),
  cm AS (
    SELECT person_id, COUNT(*) AS n
    FROM commitments
    WHERE user_id = p_user_id AND resolved_at IS NULL AND direction = 'mine'
    GROUP BY person_id
  ),
  ct AS (
    SELECT person_id, COUNT(*) AS n
    FROM commitments
    WHERE user_id = p_user_id AND resolved_at IS NULL AND direction = 'theirs'
    GROUP BY person_id
  )
  SELECT
    p.id AS person_id,
    COALESCE(q.n, 0)  AS open_questions,
    COALESCE(cm.n, 0) AS open_my_commitments,
    COALESCE(ct.n, 0) AS open_their_commitments
  FROM persons p
  LEFT JOIN q  ON q.person_id  = p.id
  LEFT JOIN cm ON cm.person_id = p.id
  LEFT JOIN ct ON ct.person_id = p.id
  WHERE p.user_id = p_user_id
    AND (COALESCE(q.n, 0) + COALESCE(cm.n, 0) + COALESCE(ct.n, 0)) > 0;
$$;

GRANT EXECUTE ON FUNCTION public.get_open_contexts_by_person(text) TO authenticated;
