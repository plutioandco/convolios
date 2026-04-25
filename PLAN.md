# Convolios — Master Plan
_Last updated: April 19, 2026_

**The Single Source of Truth for Every Conversation.**

Convolios merges fragmented communication channels into one AI-enriched inbox, organized by Person, not by App.

For the current implementation reference (commands, hooks, schema, migration history) see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Vision

A founder/operator opens Convolios in the morning. Every conversation — WhatsApp, LinkedIn, email, Instagram, Telegram, X, iMessage — is in one timeline. AI has already triaged noise, surfaced what's urgent, and drafted replies matching their voice. Before a meeting, they get a Context Brief summarizing the entire relationship history across channels. They reply from one compose window; Convolios routes it to the right channel.

---

## Target User

Solo founders, single-person companies, high-level operators managing relationships across multiple channels. People who currently app-switch 10+ times per hour.

---

## Channel Support

### Shipped
| Channel | Method | Notes |
|---------|--------|-------|
| WhatsApp (personal + business) | Unipile — QR code pairing | Inbound + outbound |
| LinkedIn DMs | Unipile — hosted auth | Inbound + outbound |
| Instagram DMs | Unipile — hosted auth | Inbound + outbound |
| Telegram | Unipile — hosted auth | Inbound + outbound |
| Gmail / Outlook / IMAP | Unipile — OAuth or credentials | Inbound + outbound; STARRED/FLAGGED sync |
| Twitter/X DMs | Official X API v2 — OAuth 2.0 PKCE, AES-GCM-encrypted token storage | Inbound + outbound; Message Requests flow |
| iMessage (macOS) | BlueBubbles bridge (user runs their own) | Inbound + outbound |

### Exploring
| Channel | Method | Notes |
|---------|--------|-------|
| Slack | Official Slack Bolt SDK — OAuth | Not started |
| ClickUp Chat | Official ClickUp API — OAuth | Not started |
| Google Chat | Official Google API — OAuth | Not started |

### Not supported (and why)
| Channel | Why |
|---------|-----|
| Facebook Messenger (personal) | No official API, unofficial breaks constantly |
| SMS (existing inbox) | Can't read existing phone SMS via API |
| Discord | Against ToS to use user tokens; bot accounts don't receive DMs |
| Signal | Complex, moves slowly, small overlap with target audience |

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| **Desktop shell** | Tauri 2 (Rust) | Native, fast, low RAM |
| **Frontend** | React 19 + TypeScript + Tailwind v4 | Dark mode, financial terminal aesthetic |
| **UI components** | Custom components + `lucide-react` icons | No external UI kit; design tokens in `src/index.css @theme` |
| **State** | Zustand for UI state, TanStack Query for server state | Lightweight, fits Tauri |
| **Auth** | Supabase Auth (magic-link OTP) | One vendor for DB + auth; deep link callback via `convolios://auth` |
| **Database** | Supabase (Postgres + pgvector) | Messages, persons, embeddings |
| **Messaging API** | Unipile (managed) | Core channels |
| **X DMs** | Official X API v2 | $100/mo flat |
| **iMessage** | BlueBubbles (user-run bridge) | No API; user's own Mac |
| **AI / LLM** | Gemini 2.5 Flash (triage), Gemini 2.5 Pro (reasoning) | Triage, summaries, reply drafting |
| **Embeddings** | Gemini Embedding 2 (3072-dim → `vector(2000)` truncated) | Semantic search via pgvector |

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│               TAURI DESKTOP APP                   │
│                                                   │
│  React 19 Frontend (dark mode, terminal aesthetic)│
│  ├── Inbox (unified timeline, screener, flagged)  │
│  ├── Thread view (per-person, per-channel filter) │
│  ├── Compose (omni-channel reply, drag-drop)      │
│  ├── Circles (tag persons, colored avatar rings)  │
│  ├── Settings (connections, merges, preferences)  │
│  └── Search (planned — semantic)                  │
│                                                   │
│  Rust Backend (Tauri IPC)                         │
│  ├── Unipile REST (chats, messages, attachments)  │
│  ├── X API v2 (DMs, PKCE, encrypted tokens)       │
│  ├── BlueBubbles (iMessage via local bridge)      │
│  ├── Supabase REST (service role, local env only) │
│  └── Drag-drop file reader, attachment cache      │
└──────────────────────┬────────────────────────────┘
                       │
        ┌──────────────┼──────────────────┐
        ▼              ▼                  ▼
┌──────────────┐ ┌──────────┐ ┌────────────────┐
│   Unipile    │ │ X API v2 │ │   Supabase     │
│  (managed)   │ │ (direct) │ │  Edge + Postgres│
│              │ │          │ │  + pg_cron      │
│ WhatsApp     │ │ DMs      │ │  + Realtime     │
│ LinkedIn     │ │          │ │                 │
│ Instagram    │ │          │ └─────┬──────────┘
│ Telegram     │ │          │       │
│ Email (IMAP) │ │          │       ▼
└──────┬───────┘ └────┬─────┘ ┌────────────────┐
       │              │       │   Gemini 2.5   │
       │              │       │                │
       └──────────────┴──────▶│  Triage +       │
                              │  summaries +    │
                              │  (future)       │
                              │  reply drafting │
                              └─────────────────┘
```

---

## Data Model

High-level shape. Authoritative definitions are in [`supabase/migrations/`](supabase/migrations/).

- **`persons`** — one row per human relationship. `status` is `pending` (screener) / `approved` / `blocked`.
- **`identities`** — channel handles linked to a person. Unique on `(user_id, channel, handle)` (migration 041).
- **`messages`** — normalized message stream. Unique on `(user_id, external_id)` (migration 050). Includes `triage`, `seen` / `read_at`, `flagged_at`, `deleted` / `deleted_at`, `hidden`, `reactions`, `folder`, `embedding vector(2000)`.
- **`connected_accounts`** — one row per channel connection. X tokens stored AES-GCM-encrypted.
- **`circles` + `circle_members`** — user-defined groupings surfaced as colored avatar rings.
- **`send_audit_log`** — every outbound send.
- **`merge_log` + `merge_dismissed`** — person-merge history.
- **`x_oauth_state`** — PKCE state; auto-cleaned every 15 minutes via pg_cron (migration 052).
- **`deletion_log`** — person deletion audit.

---

## AI Features — Build Order

### 1. Triage (shipped)
Classify every inbound message into `urgent | human | newsletter | notification | noise | unclassified`. Gemini 2.5 Flash, fire-and-forget from the webhook (non-blocking). Default inbox view filters by triage level.

### 2. Semantic Search (planned)
User asks: "what did Leo say about the contract?"
- Embed query with Gemini Embedding 2
- Cosine similarity search on pgvector
- Return top-K messages
- Gemini 2.5 Pro synthesizes a natural language answer from results

The `messages.embedding` column and the `hnsw` index exist; the pipeline that populates them isn't built yet.

### 3. Context Brief (planned)
Before a meeting with a person:
- Fetch recent messages for that person (last 30 days full, older → embedding search)
- Gemini summarizes: recent topics, pending action items, relationship tone
- Cache in `persons.ai_summary`

### 4. Reply Drafting (planned)
- User clicks reply → Gemini drafts based on conversation context + user's past replies
- Learns user's voice/tone over time
- **User always confirms before sending** (never auto-send — ban risk)

### 5. Entity Resolution (shipped, AI-assisted)
- Exact match on phone/email → auto-merge during webhook ingest (`findOrCreatePerson`)
- Name similarity + shared channel → `merge-suggestions` edge function surfaces candidates
- User confirms in Settings → Merge Suggestions
- Manual merge/split + undo always available via `merge_persons` / `undo_merge` RPCs

---

## Risks & Mitigations

### Reliability Hardening

Current focus: make the inbox resilient to missed webhooks, transient Supabase write failures, sleep/wake gaps, and provider-side sync delays.

Completed in this hardening pass:
- Unipile backfill no longer marks a chat history as complete when message writes fail.
- `sync_chat` uses the same 2-hour self-heal overlap as `startup_sync`.
- iMessage polling no longer advances the local rowid watermark when Supabase persistence fails.
- X DM sync runs beyond first launch through the focused heartbeat and fails loudly if pagination cannot reach the cursor.
- Webhook mutation events scope message updates by resolved `user_id`, matching the `(user_id, external_id)` database uniqueness model.
- On-device bridge handles can be replaced after the sidecar RPC reader closes.
- Thread preview enrichment now reads TanStack infinite-query cache using `pages`.
- Thread query failures surface through the section error boundary instead of looking like empty threads.
- Attachment open/download paths share the 200 MB guard.

Still required before declaring realtime fully verified:
- Implement or explicitly gate Meta on-device outbound send until `meta-bridge` supports `SendMessage`.
- Replay real Unipile webhook events for message insert/update/read/delete/mail-moved idempotency.
- Simulate Supabase write failure during iMessage and Unipile backfill to confirm retry behavior.
- Verify X DM heartbeat sync with a live account and enough pagination to cross the cursor.
- Kill and restart the Meta sidecar during a session to confirm stale handles are replaced.
- Sleep/wake the app and verify realtime reconnect plus catch-up sync.

### WhatsApp Ban Risk
Unipile uses WhatsApp Web protocol (unofficial). Meta's ToS prohibits third-party clients.
- **Reality:** Beeper ran 200k+ users for years with minimal bans
- **Mitigation:** Never auto-send. Never bulk message. Never message people who haven't messaged first. AI drafts only, human confirms
- **Worst case:** Meta cracks down; Unipile handles reconnection. Passive reading + manual replies are the lowest-risk shape

### Unipile Dependency
Single vendor for 5 channels.
- **Mitigation:** Shape of the Rust backend is provider-agnostic (HTTP + Postgres). A `ChannelProvider` abstraction could be added if we ever swap. Not implemented today — Unipile is hardcoded

### Embedding Costs
~$0.50/user/month at 1,000 messages/month.
- **Mitigation:** Only embed non-noise messages (post-triage). Batch embed. Cache search results

### pgvector at Scale
Works well to ~1M vectors per index. At 10k users × 1k messages = 10M vectors we'll need partitioning.
- **Mitigation:** Partition `messages` by `user_id` when scale requires it. Today's single-user shape is fine

### X API Rate Limits
10k reads/month on Basic ($100/mo).
- **Mitigation:** Cache aggressively. Only poll when app is active. Upgrade to usage-based pricing at growth

### Token Expiry / Disconnects
OAuth tokens expire. WhatsApp QR sessions drop.
- **Mitigation:** X refresh is automatic (Rust `x_refresh_access_token`). For Unipile channels, `connected_accounts.status` flips to `credentials` / `disconnected` / `error` and the Settings UI shows a reconnect banner

### OAuth Token Storage
X tokens in the DB could be leaked if the service-role key ever escaped.
- **Mitigation:** Tokens are AES-GCM-encrypted with `TOKEN_ENCRYPTION_KEY` before being written to `connection_params`. Both the edge function callback and the Rust refresh path refuse to persist plaintext if the key is missing

---

## Infrastructure Costs (Early Stage)

| Service | Cost/month | Notes |
|---------|-----------|-------|
| Unipile | €49 minimum | Covers WhatsApp / LinkedIn / IG / Telegram / Email |
| X API | $100 | Basic tier, flat |
| Gemini API | ~$0.50/user | Triage now; embeddings + summaries once built |
| Supabase | $0–25 | Free tier → Pro when needed |
| **Total** | **~$150/mo flat** | Before paying users |

Break-even at a $20/mo subscription: **~8 paying users**.

---

## Roadmap

### Shipped
- Tauri 2 shell, React 19 frontend, Supabase backend
- All Unipile channels (WhatsApp, LinkedIn, IG, Telegram, Email)
- X DMs via official API with encrypted token storage
- iMessage via BlueBubbles
- Entity resolution (automatic + merge suggestions + manual merge/split with undo)
- Screener (`pending` / `approved` / `blocked`) with auto-promotion on outbound
- Circles (colored avatar rings, sidebar filter)
- Flagging (`flagged_at` with provider-side STARRED/FLAGGED sync for email)
- Pinning + marked-unread reminders
- Read-status sync (toggleable in Preferences)
- AI triage on ingest
- Turn-state inbox (`my_turn` / `their_turn` / `all` + `gate` scanner)
- Realtime with reconnect + 60 s fallback polling
- Tauri auto-updater (GitHub releases + signed `latest.json`)
- Security: email XSS sanitizer, AES-GCM X tokens, attachment size caps, tenant-scoped service-role queries, webhook-secret constant-time compare

### Next
- Semantic search pipeline (embed on ingest, query UI)
- Context Brief (per-person summary)
- Reply drafting
- Windows / Linux builds (currently macOS-first — signed via Developer ID)

### Later
- Slack / Google Chat / ClickUp via their official APIs
- Offline mode improvements

---

## What We Are NOT Building in V1
- Mobile app
- Web version
- Facebook Messenger personal
- SMS (existing phone inbox)
- Discord / Signal
- Auto-send anything
- Team/collaborative features
