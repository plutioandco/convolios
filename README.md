# Convolios

**The Single Source of Truth for Every Conversation.**

Convolios merges fragmented communication channels (WhatsApp, LinkedIn, Email, Instagram, Telegram) into a singular, AI-enriched inbox, organized by **Person**, not by App.

---

## The Problem

Founders and high-level operators are "app-switching" to maintain single relationships.

- **Identity Fragmentation**: A client sends a contract via Gmail, a follow-up via Instagram DM, and a quick question via WhatsApp.
- **Context Loss**: Searching for a specific detail requires checking four different search bars.
- **Mental Overload**: The "Full Picture" of a relationship lives only in the founder's head, not in their tools.

## The Solution

Convolios is a "Stateful" inbox that builds a living database of human relationships.

- **Entity Resolution**: Automatically links a contact's various handles (`leo@plutio.com` + `@leobassam` IG + `+1234567890` WhatsApp) into one unified Person.
- **The "Full Picture" Thread**: A chronological timeline of every interaction across all channels in one scrolling feed.
- **Omni-Channel Reply**: A single compose window that routes your reply to the right channel.
- **AI Triage**: Separates "Human-to-Human" messages from newsletters, notifications, and noise.

---

## Tech Stack

| Component | Technology | Purpose |
|---|---|---|
| Desktop Shell | Tauri 2 (Rust + React) | High-performance, low-RAM desktop app |
| Frontend | React 19 / TypeScript / Tailwind v4 | Dark-mode-first UI, Discord-inspired aesthetic |
| State | Zustand + @tauri-store/zustand | Persistent lightweight state |
| Data Fetching | React Query v5 + LocalStorage persistence | Offline-first caching |
| Auth | Supabase Auth (OTP magic link) | Passwordless sign-in |
| Messaging API | Unipile (direct REST from Rust) | WhatsApp, LinkedIn, Instagram, Telegram, Email |
| Database | Supabase (PostgreSQL + pgvector + Realtime) | Messages, persons, embeddings, live updates |
| AI / LLM | Gemini 2.5 Flash | Message triage (classification on ingest) |
| Embeddings | Gemini Embedding 2 (3072-dim) | Semantic search (planned) |
| Deep Linking | tauri-plugin-deep-link | `convolios://auth` callback |

### Why Unipile?

- Single API for 7 channels (WhatsApp, LinkedIn, Instagram, Telegram, Gmail, Outlook, IMAP)
- Full email history with no 90-day limit
- One webhook system for all messaging + email events
- ~€5/connected account/month, €49/month minimum

---

## Project Structure

```
convolios/
  src-tauri/                 # Rust backend (Tauri 2)
    src/
      main.rs                # Entry point
      lib.rs                 # 16 Tauri IPC commands + Unipile integration
    capabilities/            # Tauri permission configs
    Cargo.toml
    tauri.conf.json          # App config, CSP, deep link schemes
  src/                       # React frontend
    components/
      inbox/InboxList.tsx    # Conversation list with search + channel filter
      thread/ThreadView.tsx  # Full message thread + compose box
      sidebar/Sidebar.tsx    # Channel navigation (Discord guild bar style)
      settings/Settings.tsx  # Account connections, sync, health checks
    hooks/
      useConversations.ts    # Fetches conversation previews (React Query)
      useThread.ts           # Fetches message thread for a person
      useRealtimeMessages.ts # Supabase Realtime + fallback polling
    stores/
      inboxStore.ts          # Selected person, active channel, triage filter
      accountsStore.ts       # Connected accounts (Zustand + realtime)
    lib/
      supabase.ts            # Supabase client init
      auth.ts                # Supabase Auth hook + deep link handling
      queryClient.ts         # React Query config (staleTime, gcTime, offline)
    types/index.ts           # TypeScript interfaces (Person, Message, etc.)
    utils/index.ts           # Channel labels, timestamps, formatters
    App.tsx                  # Root layout, routing, error boundary
    main.tsx                 # React entry + HashRouter
    index.css                # Global styles (avatar colors, scrollbars, animations)
  supabase/
    migrations/              # 15 SQL migration files (001–015, no 011)
    functions/
      unipile-webhook/       # Webhook processor (17 event types)
      unipile-account-callback/  # Account connection callback
    templates/
      magic_link.html        # Auth email template
  scripts/
    backfill.mjs             # Manual backfill script
    cleanup-groups-and-dupes.mjs  # Duplicate person cleanup
  .env.example               # Required environment variables
  PLAN.md                    # Master plan with build progress
  ARCHITECTURE.md            # Full technical reference
```

---

## Setup

### Prerequisites

- Node.js 20+
- Rust (latest stable) + Tauri CLI
- Supabase project (with pgvector enabled)
- Unipile account with API key

### Environment

Copy `.env.example` to `.env.local` and fill in:

```bash
# Supabase
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Unipile
UNIPILE_API_KEY=your-key
UNIPILE_API_URL=https://apiXXX.unipile.com:XXXXX
UNIPILE_WEBHOOK_SECRET=your-secret

# Gemini AI
GEMINI_API_KEY=your-key
```

### Install & Run

```bash
npm install
npm run tauri dev
```

### Scripts

- `npm run dev` — Vite dev server (frontend only)
- `npm run build` — Production build
- `npm run tauri dev` — Full Tauri + Vite development
- `npm run tauri build` — Production desktop build
- `npm run lint` — ESLint

### Supabase

Migrations are in `supabase/migrations/`. Apply them via the Supabase dashboard SQL editor or CLI:

```bash
supabase db push
```

Edge Functions deploy via:

```bash
supabase functions deploy unipile-webhook
supabase functions deploy unipile-account-callback
```

---

## Documentation

- **[PLAN.md](PLAN.md)** — Master plan: vision, channel support, build progress, tech debt
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — Full technical reference: data flows, Unipile integration, schema details, Tauri commands, Edge Functions, known issues

---

## Target Market

- **Primary**: Solo-founders and "single-person" companies
- **Secondary**: High-level creators and talent managers managing high-volume DMs and high-stakes email contracts

## Branding

- **Name**: Convolios (The Conversation Operating System)
- **Tone**: Human, professional, and "no-BS"
- **Aesthetic**: Clean, high-contrast, dark mode by default — less "social app", more "financial terminal" for conversations
