# Convolios — Master Plan
_Last updated: April 11, 2026_

**The Single Source of Truth for Every Conversation.**

Convolios merges fragmented communication channels into one AI-enriched inbox, organized by Person, not by App.

---

## Vision

A founder/operator opens Convolios in the morning. Every conversation — WhatsApp, LinkedIn, email, Instagram, Telegram, X, Slack, ClickUp — is in one timeline. AI has already triaged noise, surfaced what's urgent, and drafted replies matching their voice. Before a meeting, they get a Context Brief summarizing the entire relationship history across channels. They reply from one compose window; Convolios routes it to the right channel.

---

## Target User

Solo founders, single-person companies, high-level operators managing relationships across multiple channels. People who currently app-switch 10+ times per hour.

**Important:** This is a single-user application. One Convolios account = one person. A mobile app may be added later, but it syncs the same single-user account. No multi-tenant or team features.

---

## Channel Support

### Phase 1 — Unipile (managed API, white-labeled)
| Channel | Method | Status |
|---------|--------|--------|
| WhatsApp (personal + business) | Unipile — QR code pairing | ✅ Implemented |
| LinkedIn DMs | Unipile — hosted auth | ✅ Implemented |
| Instagram DMs | Unipile — hosted auth | ✅ Implemented |
| Telegram | Unipile — hosted auth | ✅ Implemented |
| Gmail | Unipile — OAuth | ✅ Implemented |
| Outlook | Unipile — OAuth | ✅ Implemented |
| IMAP (any email) | Unipile — credentials | ✅ Implemented |

### Phase 2 — Direct integrations (our own code)
| Channel | Method | License | Complexity |
|---------|--------|---------|------------|
| Twitter/X DMs | Official X API v2 — OAuth 2.0 | Official ($100/mo) | Medium |
| Slack | Official Slack Bolt SDK — OAuth | MIT | Easy |
| ClickUp Chat | Official ClickUp API — OAuth | Official | Easy |
| Google Chat | Official Google API — OAuth | Official | Easy |

### Phase 3 — Power features (later)
| Channel | Method | Notes |
|---------|--------|-------|
| Discord | User token API (discord.js, Apache license) | Against Discord ToS, medium ban risk |
| Signal | Linked device protocol | Complex encryption |
| iMessage | BlueBubbles (user runs own Mac server) | Optional, Mac users only |

### Not supported (and why)
| Channel | Why |
|---------|-----|
| Facebook Messenger (personal) | No official API, unofficial breaks constantly |
| SMS (existing inbox) | Can't read existing phone SMS via API |
| iMessage (hosted) | Apple blocks all third-party access |

---

## Tech Stack (Actual)

| Layer | Choice | Why |
|-------|--------|-----|
| **Desktop shell** | Tauri 2 (Rust) | Native, fast, low RAM |
| **Frontend** | React 19 + TypeScript + Tailwind v4 | Dark mode, financial terminal aesthetic |
| **UI components** | Custom-built (inline styles + minimal Tailwind) | Discord-inspired dark theme |
| **State** | Zustand + @tauri-store/zustand | Persistent state across Tauri restarts |
| **Data fetching** | React Query v5 + LocalStorage persistence | Offline-first with cache |
| **Auth** | Supabase Auth (OTP magic link) | Replaced Clerk for simpler stack |
| **Database** | Supabase (Postgres + pgvector + Realtime) | Messages, persons, embeddings, live updates |
| **Messaging API** | Unipile (direct REST, no SDK) | Core channels via Rust backend |
| **AI / LLM** | Gemini 2.5 Flash (triage) | Non-blocking classification on ingest |
| **Embeddings** | Gemini Embedding 2 (3072-dim) | Semantic search via pgvector (not yet active) |
| **Deep linking** | tauri-plugin-deep-link | `convolios://auth` for magic link callback |

### Key stack decisions that differ from original plan
- **Auth**: Pivoted from Clerk to Supabase Auth to reduce vendor count
- **UI**: Did not adopt shadcn/ui or chatscope — entire UI is custom-built
- **Unipile**: Using direct REST API calls from Rust, not unipile-node-sdk
- **Triage**: Uses Gemini 2.5 Flash (not Pro) — cheaper and faster for classification
- **Tailwind**: v4 (no config file, wired through @tailwindcss/vite plugin)

---

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full technical reference.

```
┌──────────────────────────────────────────────────────┐
│               TAURI DESKTOP APP                       │
│                                                       │
│  React Frontend (dark mode, Discord aesthetic)        │
│  ├── Sidebar — channel navigation (Discord guild bar) │
│  ├── InboxList — conversation previews                │
│  ├── ThreadView — full message thread + compose       │
│  └── Settings — account connections + health checks   │
│                                                       │
│  Rust Backend (Tauri IPC — 16 commands)               │
│  ├── Unipile API calls (accounts, chats, messages)    │
│  ├── Supabase REST (persons, identities, messages)    │
│  └── Backfill, sync, send, attachments, avatars       │
└──────────────────────┬────────────────────────────────┘
                       │
        ┌──────────────┼──────────────────┐
        ▼              ▼                  ▼
┌──────────────┐ ┌──────────┐ ┌────────────────┐
│   Unipile    │ │ Supabase │ │  Gemini AI     │
│  (managed)   │ │          │ │                │
│              │ │ Postgres │ │ 2.5 Flash      │
│ WhatsApp     │ │ Realtime │ │ (triage)       │
│ LinkedIn     │ │ Edge Fn  │ │                │
│ Instagram    │ │ pgvector │ │ Embedding 2    │
│ Telegram     │ │ Auth     │ │ (search, TODO) │
│ Email        │ │          │ │                │
└──────────────┘ └──────────┘ └────────────────┘
```

---

## Data Model (Actual)

See [ARCHITECTURE.md](ARCHITECTURE.md) for full column listings. Summary:

- **`persons`** — one row per human relationship (user_id, display_name, avatar_url, ai_summary)
- **`identities`** — links a person to their channel handles (channel + handle, unique per user)
- **`messages`** — every message normalized (40+ columns including reactions, seen/delivered, quoted replies, email metadata)
- **`connected_accounts`** — user's linked channels with Unipile account details (status, email, phone, username, provider_type)

16 migrations applied so far. No `conversations` table — conversations are derived from the messages table via `get_conversations` RPC.

---

## AI Features — Build Order

### 1. Triage ✅ IMPLEMENTED (basic)
Classify every inbound message via Gemini 2.5 Flash:
- `urgent` — needs reply now (client asking something, deadline, money)
- `human` — real person, real conversation, but not urgent
- `newsletter` — mass email, marketing
- `notification` — automated system message (receipts, alerts)
- `noise` — spam, irrelevant

Runs non-blocking in the webhook Edge Function after message persistence. UI has triage filter in inbox.

### 2. Semantic Search — NOT YET STARTED
- Embedding column exists (`vector(2000)` in DB, plan calls for 3072-dim)
- No embedding pipeline built yet
- No search UI built yet

### 3. Context Brief — NOT YET STARTED
- `ai_summary` column exists on `persons` table
- No generation logic built yet

### 4. Reply Drafting — NOT YET STARTED

### 5. Entity Resolution — PARTIAL
- Exact match on channel+handle: ✅ automatic
- Variant matching (with/without +, WhatsApp suffixes): ✅ in webhook
- Display name matching: ✅ in webhook
- AI-assisted fuzzy merge: ❌ not built
- Manual merge/split UI: ❌ not built
- Duplicate person cleanup scripts exist (`scripts/cleanup-groups-and-dupes.mjs`, migrations 014/015)

---

## Build Progress

### Phase 1 — Foundation ✅ COMPLETE
- [x] Scaffold Tauri 2 + React 19 + TypeScript + Tailwind v4 + Zustand
- [x] Supabase project + initial schema migration + pgvector
- [x] Auth (pivoted from Clerk to Supabase Auth OTP)
- [x] Push to `github.com/plutioandco/convolios`
- [x] 1Password vault for secrets

### Phase 2 — Message Ingestion ✅ COMPLETE
- [x] Unipile integration — connect accounts via hosted auth
- [x] Webhook processor Edge Function (handles 17 event types)
- [x] Full backfill from Rust backend (paginated, all channels)
- [x] Normalize all messages into `messages` table
- [x] Auto-create persons and identities from incoming messages
- [x] Startup sync (24h backfill on every app launch)
- [ ] X API DM poller — not started

### Phase 3 — Core UI ✅ MOSTLY COMPLETE
- [x] Inbox view — unified timeline, sorted by sent_at, channel badges
- [x] Person thread — all messages for one person, grouped by sender
- [x] Conversation list — sidebar with search, channel filter, triage filter
- [x] Compose window — text, attachments, voice notes, reply-to, drag & drop
- [x] Settings — connect accounts, sync, pull history, health checks, disconnect
- [x] Rich message rendering (locations, VCards, GIFs, voice notes, email HTML)
- [x] Message actions (reply, react, edit for WhatsApp)
- [x] Realtime updates (Supabase Realtime + fallback polling)
- [x] Optimistic message sending with retry on failure
- [x] Unread count — based on `read_at` column, shown in inbox via `get_conversations` RPC
- [ ] Person merge/split UI — not built

### Phase 4 — AI Layer ⏳ PARTIAL
- [x] Triage — basic classification on ingest via Gemini 2.5 Flash
- [x] Triage filter — inbox filters conversations by triage level (urgent/human/newsletter/noise)
- [ ] Semantic search — not started
- [ ] Context Brief — not started
- [ ] Reply drafting — not started

### Phase 5 — More Channels ❌ NOT STARTED
### Phase 6 — Entity Resolution + Polish ❌ NOT STARTED

---

## Known Issues & Tech Debt

See [ARCHITECTURE.md](ARCHITECTURE.md) § Known Issues for the full list. Key items:

1. **Embedding dimension mismatch** — DB has `vector(2000)`, Gemini outputs 3072-dim (irrelevant until embedding pipeline is built)
2. **Base64 avatars in DB** — works but bloats rows; consider Supabase Storage later

---

## Risks & Mitigations

### WhatsApp Ban Risk
Unipile uses WhatsApp Web protocol (unofficial). Meta's ToS prohibits third-party clients.
- **Reality:** Beeper ran 200k+ users for 3 years, zero permanent bans
- **Mitigation:** Never auto-send. Never bulk message. AI drafts only, human confirms.

### Unipile Dependency
Single vendor for 7 channels.
- **Mitigation:** Data model is provider-agnostic. No `ChannelProvider` abstraction yet (tech debt).

### Embedding Costs
~$0.50/user/month at 1,000 messages/month.
- **Mitigation:** Only embed non-noise messages (post-triage). Batch embed.

### Service Role Key on Disk
Supabase service role key lives in `.env.local` on the user's machine (Tauri desktop app).
- **Mitigation:** Consider proxying sensitive operations through Edge Functions.

---

## Infrastructure Costs (Early Stage)

| Service | Cost/month | Notes |
|---------|-----------|-------|
| Unipile | €49 minimum | Covers all Phase 1 channels |
| Gemini API | ~$0.50/user | Triage (Flash) + future embeddings/summaries |
| Supabase | $0–25 | Free tier → Pro at scale |
| **Total** | **~$50/mo flat** | Before paying users |

Break-even at $20/mo subscription: **3 paying users**.

---

## What We Are NOT Building in V1
- Mobile app
- Web version
- Facebook Messenger personal
- SMS (existing phone inbox)
- iMessage
- Discord
- Auto-send anything
- Team/collaborative features
