# Convolios — Master Plan
_Last updated: April 6, 2026_

**The Single Source of Truth for Every Conversation.**

Convolios merges fragmented communication channels into one AI-enriched inbox, organized by Person, not by App.

---

## Vision

A founder/operator opens Convolios in the morning. Every conversation — WhatsApp, LinkedIn, email, Instagram, Telegram, X, Slack, ClickUp — is in one timeline. AI has already triaged noise, surfaced what's urgent, and drafted replies matching their voice. Before a meeting, they get a Context Brief summarizing the entire relationship history across channels. They reply from one compose window; Convolios routes it to the right channel.

---

## Target User

Solo founders, single-person companies, high-level operators managing relationships across multiple channels. People who currently app-switch 10+ times per hour.

---

## Channel Support

### Phase 1 — Unipile (managed API, white-labeled)
| Channel | Method | Status |
|---------|--------|--------|
| WhatsApp (personal + business) | Unipile — QR code pairing | ✅ |
| LinkedIn DMs | Unipile — hosted auth | ✅ |
| Instagram DMs | Unipile — hosted auth | ✅ |
| Telegram | Unipile — hosted auth | ✅ |
| Gmail | Unipile — OAuth | ✅ |
| Outlook | Unipile — OAuth | ✅ |
| IMAP (any email) | Unipile — credentials | ✅ |

### Phase 2 — Direct integrations (our own code)
| Channel | Method | License | Complexity |
|---------|--------|---------|------------|
| Twitter/X DMs | Official X API v2 — OAuth 2.0 | Official ($100/mo) | Medium |
| Slack | Official Slack Bolt SDK — OAuth | MIT ✅ | Easy |
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

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| **Desktop shell** | Tauri 2 (Rust) | Native, fast, low RAM. Scaffold with `tauri-ui` (MIT) |
| **Frontend** | React 19 + TypeScript + Tailwind | Dark mode, financial terminal aesthetic |
| **UI components** | shadcn/ui + chatscope/chat-ui-kit-react (MIT) | shadcn for general UI, chatscope for chat-specific components |
| **State** | Zustand | Lightweight, fits Tauri |
| **Auth** | Clerk | Convolios account login |
| **Database** | Supabase (Postgres + pgvector) | Messages, persons, embeddings |
| **Messaging API** | Unipile (managed) | Core channels |
| **X DMs** | Official X API v2 | $100/mo flat |
| **Slack** | @slack/bolt (MIT) | Official SDK |
| **ClickUp** | ClickUp API | Official |
| **AI / LLM** | Gemini 2.5 Pro | Triage, summaries, reply drafting |
| **Embeddings** | Gemini Embedding 2 (3072-dim) | Semantic search via pgvector |

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│               TAURI DESKTOP APP                   │
│                                                   │
│  React Frontend (dark mode, terminal aesthetic)   │
│  ├── Inbox (unified timeline)                     │
│  ├── Person view (all channels, one person)       │
│  ├── Compose (omni-channel reply)                 │
│  ├── Search (semantic, natural language)           │
│  ├── Settings (connect accounts)                  │
│  └── Context Brief (pre-meeting AI summary)       │
│                                                   │
│  Rust Backend (Tauri IPC)                         │
│  └── Local cache, offline support, file handling  │
└──────────────────────┬────────────────────────────┘
                       │
        ┌──────────────┼──────────────────┐
        ▼              ▼                  ▼
┌──────────────┐ ┌──────────┐ ┌────────────────┐
│   Unipile    │ │ X API v2 │ │  Slack/ClickUp │
│  (managed)   │ │ (direct) │ │   (direct)     │
│              │ │          │ │                │
│ WhatsApp     │ │ DMs      │ │ Messages       │
│ LinkedIn     │ │          │ │                │
│ Instagram    │ │          │ │                │
│ Telegram     │ │          │ │                │
│ Email        │ │          │ │                │
└──────┬───────┘ └────┬─────┘ └───────┬────────┘
       │              │               │
       └──────────────┼───────────────┘
                      ▼
            ┌──────────────────┐
            │     SUPABASE     │
            │                  │
            │  Edge Functions  │ ← webhook processors
            │  Postgres        │ ← persons, messages, identities
            │  pgvector        │ ← embeddings for semantic search
            │                  │
            └────────┬─────────┘
                     │
                     ▼
            ┌──────────────────┐
            │    GEMINI AI     │
            │                  │
            │  Triage          │ ← noise vs human vs urgent
            │  Embeddings      │ ← semantic search vectors
            │  Context Brief   │ ← pre-meeting summaries
            │  Reply Draft     │ ← match user's voice/tone
            └──────────────────┘
```

---

## Data Model

### `persons` — one row per human relationship
```sql
CREATE TABLE persons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,              -- Convolios user (Clerk ID)
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  notes TEXT,
  ai_summary TEXT,                    -- cached context brief
  ai_summary_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### `identities` — links a person to their channel handles
```sql
CREATE TABLE identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID REFERENCES persons(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,              -- 'whatsapp', 'linkedin', 'gmail', 'x', 'slack', 'clickup'
  handle TEXT NOT NULL,               -- email, phone, username, account ID
  display_name TEXT,                  -- name as shown on that channel
  unipile_account_id TEXT,            -- for Unipile-managed channels
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(channel, handle)
);
```

### `messages` — every message, normalized
```sql
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  person_id UUID REFERENCES persons(id),
  identity_id UUID REFERENCES identities(id),
  external_id TEXT UNIQUE,            -- dedup key (unipile_message_id, x_dm_id, etc.)
  channel TEXT NOT NULL,
  direction TEXT NOT NULL,            -- 'inbound' | 'outbound'
  message_type TEXT DEFAULT 'dm',     -- 'dm' | 'group' | 'channel'
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  attachments JSONB DEFAULT '[]',
  thread_id TEXT,
  sent_at TIMESTAMPTZ NOT NULL,
  synced_at TIMESTAMPTZ DEFAULT now(),
  triage TEXT DEFAULT 'unclassified', -- 'urgent' | 'human' | 'newsletter' | 'notification' | 'noise'
  embedding vector(3072),
  CONSTRAINT messages_user_person_idx UNIQUE (user_id, external_id)
);

-- Indexes
CREATE INDEX messages_person_idx ON messages(person_id, sent_at DESC);
CREATE INDEX messages_user_triage_idx ON messages(user_id, triage, sent_at DESC);
CREATE INDEX messages_embedding_idx ON messages
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
```

### `connected_accounts` — user's connected channels
```sql
CREATE TABLE connected_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,             -- 'unipile', 'x', 'slack', 'clickup', 'google_chat'
  channel TEXT NOT NULL,              -- 'whatsapp', 'linkedin', etc.
  account_id TEXT,                    -- provider's account ID
  status TEXT DEFAULT 'active',       -- 'active' | 'disconnected' | 'expired'
  credentials JSONB DEFAULT '{}',     -- encrypted tokens (never raw in DB — use Supabase vault)
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

---

## AI Features — Build Order

### 1. Triage (ship first — highest impact)
Classify every inbound message:
- `urgent` — needs reply now (client asking something, deadline, money)
- `human` — real person, real conversation, but not urgent
- `newsletter` — mass email, marketing
- `notification` — automated system message (receipts, alerts)
- `noise` — spam, irrelevant

Use Gemini 2.5 Pro with a classification prompt. Batch process on ingest. Non-blocking — if AI is slow, message still shows, just unclassified.

### 2. Semantic Search
User asks: "what did Leo say about the contract?"
- Embed query with Gemini Embedding 2
- Cosine similarity search on pgvector
- Return top-K messages
- Gemini synthesizes a natural language answer from results

### 3. Context Brief
Before a meeting with a person:
- Fetch all messages for that person (last 30 days full, older → embedding search)
- Gemini summarizes: recent topics, pending action items, relationship tone
- Cache for 1 hour per person

### 4. Reply Drafting
- User clicks reply → Gemini drafts based on conversation context + user's past replies
- Learns user's voice/tone over time
- **User always confirms before sending** (never auto-send — ban risk)

### 5. Entity Resolution (AI-assisted)
- Exact match on phone/email → auto-merge
- Name similarity + same company → suggest merge, user confirms
- Over time: AI confidence increases as more signals arrive
- User can always manually merge/split

---

## Risks & Mitigations

### WhatsApp Ban Risk
Unipile uses WhatsApp Web protocol (unofficial). Meta's ToS prohibits third-party clients.
- **Reality:** Beeper ran 200k+ users for 3 years, zero permanent bans
- **Mitigation:** Never auto-send. Never bulk message. Never message people who haven't messaged first. AI drafts only, human confirms.
- **Worst case:** If Meta cracks down, Unipile handles reconnection. User's WhatsApp account is NOT at risk for passive reading + manual replies.

### Unipile Dependency
Single vendor for 7 channels.
- **Mitigation:** Abstract Unipile behind a `ChannelProvider` interface. If Unipile dies, swap to direct integrations. Data model is provider-agnostic.

### Embedding Costs
~$0.50/user/month at 1,000 messages/month.
- **Mitigation:** Only embed non-noise messages (post-triage). Batch embed. Cache search results. Consider half-precision vectors at scale.

### pgvector at Scale
Works well to ~1M vectors. 10k users × 1k messages = 10M vectors.
- **Mitigation:** Partition messages table by user_id from day one. Each user's vectors stay in their own partition.

### X API Rate Limits
10k reads/month on Basic ($100/mo).
- **Mitigation:** Cache aggressively. Only poll when app is active. At growth: upgrade to usage-based pricing.

### Token Expiry / Disconnects
OAuth tokens expire. WhatsApp QR sessions drop.
- **Mitigation:** Unipile handles reconnection prompts. For X/Slack/ClickUp: refresh tokens automatically. Show reconnect banner in UI when status = disconnected.

---

## Open Source Tools We'll Use

| Tool | Purpose | License |
|------|---------|---------|
| `tauri-ui` (agmmnn) | Tauri 2 + React + shadcn scaffold | MIT ✅ |
| `chatscope/chat-ui-kit-react` | Chat UI components (message list, conversation list, avatars) | MIT ✅ |
| `shadcn/ui` | General UI components | MIT ✅ |
| `@slack/bolt` | Slack integration SDK | MIT ✅ |
| `discord.js` | Discord integration (Phase 3) | Apache-2.0 ✅ |
| `unipile-node-sdk` | Unipile API client | Commercial |

### Study / Reference (don't use code directly)
| Project | What to learn | License |
|---------|---------------|---------|
| **Chatwoot** (MIT, 22k⭐) | Polymorphic channel architecture, webhook processors, message normalization for 13+ channels | MIT ✅ |
| **Ferdium** (Apache, 7k⭐) | Service "recipes" — per-platform config patterns | Apache ✅ |
| **mautrix bridges** (AGPL) | How WhatsApp/Discord/Signal/Instagram protocols actually work | Study only ❌ |
| **Inbox Zero** (AGPL) | AI email triage prompts, classification categories | Study only ❌ |
| **jenish0908/unified-inbox** | Working Unipile → unified UI patterns, webhook handlers | Study only ⚠️ |
| **splink** (MIT) | Entity resolution algorithm — probabilistic matching | MIT ✅ |

---

## Infrastructure Costs (Early Stage)

| Service | Cost/month | Notes |
|---------|-----------|-------|
| Unipile | €49 minimum | Covers all Phase 1 channels |
| X API | $100 | Basic tier, all users |
| Gemini API | ~$0.50/user | Embeddings + triage + summaries |
| Supabase | $0–25 | Free tier → Pro at 3rd project |
| Clerk | $0 | Free under 10k MAU |
| Slack API | $0 | Free |
| ClickUp API | $0 | Free |
| **Total** | **~$160/mo flat** | Before paying users |

Break-even at $20/mo subscription: **8 paying users**.

---

## Build Order

### Phase 1 — Foundation (Week 1-2)
1. Scaffold Tauri app with `tauri-ui`
2. Supabase project + schema migration (all tables above)
3. Enable pgvector extension
4. Clerk app for auth
5. Push to `github.com/plutioandco/convolios`
6. 1Password vault: Unipile key, X API key, Gemini key, Clerk keys

### Phase 2 — Message Ingestion (Week 3-4)
1. Sign up Unipile → connect test WhatsApp + Gmail
2. Build webhook processor Edge Function (Unipile → Supabase)
3. Build X API DM poller
4. Normalize all messages into `messages` table
5. Auto-create `persons` and `identities` from incoming messages

### Phase 3 — Core UI (Week 5-7)
1. Inbox view — unified timeline, sorted by sent_at, channel badges
2. Person view — all messages for one person across channels
3. Conversation list — sidebar with recent conversations
4. Compose window — select channel, type, send via Unipile/X API
5. Settings — connect accounts (Unipile hosted auth, X OAuth)

### Phase 4 — AI Layer (Week 8-10)
1. Triage — classify on ingest, filter inbox by triage level
2. Semantic search — embed messages, pgvector search, Gemini answer
3. Context Brief — on-demand per-person summary
4. Reply drafting — AI suggests, user confirms

### Phase 5 — More Channels (Week 11-12)
1. Slack via @slack/bolt
2. ClickUp Chat via ClickUp API
3. Google Chat via Google API

### Phase 6 — Entity Resolution + Polish (Week 13+)
1. AI-suggested person merges
2. Manual merge/split UI
3. Offline mode (local cache)
4. Auto-updater
5. Windows + Linux builds

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
