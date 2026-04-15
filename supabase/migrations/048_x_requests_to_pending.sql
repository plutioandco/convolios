-- 048: Move X contacts to screener when the first message was inbound.
-- X "Message Requests" were synced before the screener existed, so they
-- got status='approved' by default.  Re-evaluate using the same rule the
-- backfill RPC now applies: inbound-first → pending.

UPDATE persons p
SET    status = 'pending',
       updated_at = now()
FROM   identities i
WHERE  i.person_id = p.id
  AND  i.channel   = 'x'
  AND  p.status    = 'approved'
  AND  (
    SELECT m.direction
    FROM   messages m
    WHERE  m.person_id = p.id
    ORDER  BY m.sent_at ASC
    LIMIT  1
  ) = 'inbound';
