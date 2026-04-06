# Convolios

**The Single Source of Truth for Every Conversation.**

Convolios merges fragmented communication channels (Email, Instagram, WhatsApp, LinkedIn) into a singular, AI-enriched "Full Picture" inbox, organized by **Person**, not by App.

---

## The Problem

Founders and high-level operators are "app-switching" to maintain single relationships.

- **Identity Fragmentation**: A client sends a contract via Gmail, a follow-up via Instagram DM, and a quick question via WhatsApp.
- **Context Loss**: Searching for a specific detail requires checking four different search bars.
- **Mental Overload**: The "Full Picture" of a relationship lives only in the founder's head, not in their tools.

## The Solution

Convolios is a "Stateful" inbox that builds a living database of human relationships.

- **Entity Resolution**: AI automatically links a contact's various handles (e.g., `leo@plutio.com` + `@leobassam` IG) into one Human Thread.
- **The "Full Picture" Box**: A chronological timeline of every interaction across all channels in one scrolling feed.
- **Omni-Channel Reply**: A single compose window that intelligently routes your reply to the most effective channel.

---

## Key Features

### Semantic "Full Picture" Search

Instead of keyword matching, users can ask: *"What was the feedback on the last design draft?"* The AI retrieves the answer from a WhatsApp voice note and the attached PDF from a Gmail thread.

### Relationship Intelligence

Before a meeting, Convolios provides a "Context Brief" — summarizing recent DMs, emails, and social mentions across all platforms to give you a 360-degree view.

### The "Deep Work" Filter

AI-driven triage that separates "Human-to-Human" high-value messages from newsletters, marketing blasts, and social noise.

---

## Tech Stack

| Component | Technology | Purpose |
|---|---|---|
| Desktop Shell | Tauri 2 (Rust + React) | High-performance, low-RAM desktop app |
| Frontend | React 18+ / TypeScript / TailwindCSS | Dark-mode-first UI with "financial terminal" aesthetic |
| State Management | Zustand | Lightweight, fits Tauri's philosophy |
| Unified Comms API | Unipile (`unipile-node-sdk`) | Single API for Gmail, Outlook, WhatsApp, Instagram, LinkedIn |
| Database | Supabase (PostgreSQL + pgvector) | Messages, contacts, and vector embeddings |
| AI / LLM | Gemini 2.5 Pro | Reasoning, classification, summarization |
| Embeddings | Gemini Embedding 2 (3072-dim) | Semantic search over message history |

### Why Unipile as the Single API?

The original design called for Unipile (messaging) + Nylas (email). After evaluation, Unipile alone covers all channels:

- Full email history with no 90-day limit (unlike Nylas)
- One SDK, one schema, one webhook system
- Lower cost (~€5/connected account/month, €49/month minimum)
- Simpler Entity Resolution when all data comes from one normalized source

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Tauri Desktop App                     │
│  ┌───────────────────────────────────────────────────┐  │
│  │              React Frontend (Dark Mode)            │  │
│  │  ┌──────────┐ ┌──────────┐ ┌───────────────────┐  │  │
│  │  │  Unified  │ │  Person  │ │   Omni-Channel    │  │  │
│  │  │  Inbox    │ │  Thread  │ │   Compose Window  │  │  │
│  │  └──────────┘ └──────────┘ └───────────────────┘  │  │
│  │  ┌──────────┐ ┌──────────┐ ┌───────────────────┐  │  │
│  │  │ Semantic  │ │ Context  │ │   Deep Work       │  │  │
│  │  │ Search    │ │ Brief    │ │   Filter          │  │  │
│  │  └──────────┘ └──────────┘ └───────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Rust Backend (Tauri IPC)              │  │
│  └───────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
     ┌──────────────┐ ┌────────┐ ┌──────────────┐
     │   Unipile    │ │Supabase│ │  Gemini 2.5  │
     │  (All Comms) │ │+pgvec  │ │  + Embed 2   │
     └──────────────┘ └────────┘ └──────────────┘
```

---

## Data Schema

### `persons` — The unified human identity

Every contact is resolved into a single person, regardless of how many channels they use.

```sql
CREATE TABLE persons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  notes TEXT,
  ai_summary TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### `identities` — Links a person to their channel handles

```sql
CREATE TABLE identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID REFERENCES persons(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,          -- 'gmail', 'instagram', 'whatsapp', 'linkedin'
  handle TEXT NOT NULL,           -- 'leo@plutio.com', '@leobassam', '+1234567890'
  unipile_account_id TEXT,
  metadata JSONB DEFAULT '{}',
  verified BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(channel, handle)
);
```

### `messages` — Every message across all channels, normalized

```sql
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID REFERENCES persons(id),
  identity_id UUID REFERENCES identities(id),
  unipile_message_id TEXT UNIQUE,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL,        -- 'inbound' | 'outbound'
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  attachments JSONB DEFAULT '[]',
  thread_id TEXT,
  sent_at TIMESTAMPTZ NOT NULL,
  synced_at TIMESTAMPTZ DEFAULT now(),
  is_noise BOOLEAN DEFAULT false,
  embedding vector(3072)          -- Gemini Embedding 2 output
);

CREATE INDEX messages_person_idx ON messages(person_id, sent_at DESC);
CREATE INDEX messages_channel_idx ON messages(channel, sent_at DESC);
CREATE INDEX messages_embedding_idx ON messages
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
```

### `conversations` — Grouped threads per person

```sql
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID REFERENCES persons(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  unipile_thread_id TEXT,
  subject TEXT,
  last_message_at TIMESTAMPTZ,
  message_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## Feature Implementation

### Entity Resolution (Person Linking)

When a new message arrives via Unipile webhook:
1. Extract sender identity (email, IG handle, phone, LinkedIn URL)
2. Check `identities` table for existing match
3. If no match, use Gemini 2.5 to suggest possible person matches (name similarity, shared context)
4. Create or link to a `persons` record
5. User can manually merge/split persons from the UI

### "Full Picture" Timeline

A single chronological feed per person mixing emails, DMs, and messages. Each message shows a channel badge (Gmail, WhatsApp, Instagram, LinkedIn).

### Semantic Search

1. On message ingest, generate embedding via Gemini Embedding 2 (3072 dimensions)
2. Store in `messages.embedding` column
3. User's natural language question is embedded, then cosine similarity search via pgvector
4. Gemini 2.5 synthesizes the top-K results into a natural language answer

### Omni-Channel Reply

Compose window detects the person's available channels from `identities`. User picks channel (or AI suggests the most effective one based on recency/response patterns). Sends via Unipile SDK.

### "Deep Work" Filter (AI Triage)

On ingest, Gemini 2.5 classifies each message: `human_conversation | newsletter | marketing | notification | noise`. Sets `messages.is_noise` flag. Default inbox view filters to `is_noise = false`.

### Context Brief

Before a meeting, queries all messages for a person from the last 30 days. Passes to Gemini 2.5 for summarization highlighting action items, pending decisions, and tone. Cached in `persons.ai_summary`.

---

## Project Structure

```
convolios/
  src-tauri/              # Rust backend (Tauri 2)
    src/
      main.rs
      lib.rs
    Cargo.toml
    tauri.conf.json
  src/                    # React frontend
    assets/
    components/
      inbox/              # Inbox list, message cards
      person/             # Person thread, timeline
      compose/            # Omni-channel compose window
      search/             # Semantic search bar + results
      sidebar/            # Navigation, channel filters
      common/             # Shared UI components
    hooks/                # Custom React hooks
    stores/               # Zustand stores
    services/             # API clients (Unipile, Supabase, Gemini)
    types/                # TypeScript types
    utils/                # Helpers, formatters
    App.tsx
    main.tsx
  supabase/
    migrations/           # SQL migration files
    functions/            # Supabase Edge Functions (webhook handlers, AI)
  package.json
  tailwind.config.ts
  tsconfig.json
```

---

## MVP Milestones

1. **Scaffold** — Tauri 2 + React + TypeScript + TailwindCSS + Zustand
2. **Database** — Supabase project, migrations for all 4 core tables + pgvector
3. **Unipile Integration** — Account connection flow, message sync, webhook handler
4. **Entity Resolution** — Identity linking, person creation, merge UI
5. **Inbox UI** — Unified inbox view, person thread timeline, channel badges
6. **Compose** — Omni-channel reply window routing to correct channel
7. **Semantic Search** — Embedding pipeline + pgvector search + Gemini answer synthesis
8. **AI Triage** — Deep Work filter (noise classification on ingest)
9. **Context Brief** — Pre-meeting relationship summary panel

---

## Target Market

- **Primary**: Solo-founders and "single-person" companies
- **Secondary**: High-level creators and talent managers who manage high-volume DMs and high-stakes email contracts simultaneously

## Branding

- **Name**: Convolios (The Conversation Operating System)
- **Tone**: Human, professional, and "no-BS"
- **Aesthetic**: Clean, high-contrast, dark mode by default — less "social app", more "financial terminal" for conversations

---

## Setup

```bash
npm install
```

## Scripts

- `npm run build` — compile TypeScript to `dist/`
- `npm run dev` — watch and recompile
- `npm start` — run `dist/index.js`
- `npm run typecheck` — type-check without emitting
- `npm run clean` — remove `dist/`
