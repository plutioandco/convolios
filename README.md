# Convolios

**The Single Source of Truth for Every Conversation.**

Convolios merges fragmented communication channels (WhatsApp, LinkedIn, Instagram, Telegram, Gmail/Outlook/IMAP, X DMs, iMessage) into a single, AI-enriched inbox organized by **Person**, not by app.

This repository contains the Tauri 2 desktop shell, the React 19 frontend, the Supabase schema and edge functions, and the documentation needed to build and run it.

---

## Problem

Operators manage individual relationships across many apps. A contract lands in Gmail, the follow-up lands in LinkedIn, a question arrives on WhatsApp. The full context of a relationship lives only in someone's head.

Convolios unifies those channels by person. One row in `persons` per human; many rows in `identities` linking them to their channel handles; one normalized stream in `messages`. You search, reply, and triage from one place.

---

## Feature overview

- **Unified inbox** — all channels in one timeline, per-person threading.
- **Entity resolution** — automatic and manual merging of identities into a single person.
- **Circles** — lightweight tagging of people (Work / Family / Investors / …) surfaced as colored rings on avatars.
- **Screener** — new contacts land in a pending queue; approved contacts enter the main inbox.
- **AI triage** — Gemini classifies inbound messages as `urgent | human | newsletter | notification | noise | unclassified`.
- **Flagging / starred emails** — mark important messages; star status is synced with the provider for Gmail and Outlook (folder = `STARRED` / `FLAGGED`).
- **Read-status sync** — opening or replying to a conversation can mark it read on WhatsApp and LinkedIn (toggleable in Preferences).
- **Realtime + fallback polling** — Supabase Realtime drives live updates; React Query polls every 15s when realtime is down and every 60s for list/count safety nets when healthy.

---

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri 2 (Rust + Wry WebView) |
| Frontend | React 19 + TypeScript 5.9, Tailwind v4 (CSS-in-`@theme` tokens), Zustand for UI state, TanStack Query for server state |
| Auth | Supabase Auth (email + OAuth, deep-link callback on `convolios://auth`) |
| Database | Supabase Postgres (+ pgvector for semantic search) |
| Realtime | Supabase Realtime (Postgres changes on `messages` filtered by `user_id`) |
| Messaging (WhatsApp / LinkedIn / Instagram / Telegram / Email) | Unipile REST API |
| X / Twitter DMs | Official X API v2 via our own OAuth 2.0 PKCE flow |
| iMessage | BlueBubbles (user runs their own local bridge) |
| AI / LLM | Gemini 2.5 Flash for triage, Gemini 2.5 Pro for reasoning and summaries |
| Embeddings | Gemini Embedding 2 (3072-dim) → pgvector HNSW index |

---

## High-level architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Tauri Desktop App                     │
│  React frontend ── useAuth (Supabase) ── TanStack Query   │
│      │                                                    │
│      ▼ Tauri IPC                                          │
│  Rust backend (reqwest, tokio)                            │
│      ├── Unipile REST                                     │
│      ├── X API v2 (OAuth PKCE, AES-GCM-encrypted tokens)  │
│      ├── BlueBubbles (iMessage)                           │
│      └── Supabase REST (service role from local env)      │
└──────────────────────────────────────────────────────────┘
                 ▲                    ▲
                 │ webhooks           │ realtime
                 │                    │
        ┌────────┴────────┐   ┌───────┴─────────┐
        │ Supabase Edge   │   │ Supabase        │
        │ Functions       │──▶│ Postgres        │
        │  - unipile-     │   │  + pgvector     │
        │    webhook      │   │  + pg_cron      │
        │  - *-callback   │   │                 │
        │  - merge-       │   └───────┬─────────┘
        │    suggestions  │           │
        └────────┬────────┘           │
                 │                    ▼
                 ▼            ┌────────────────┐
        ┌────────────────┐    │ Gemini 2.5     │
        │ Gemini triage  │    │ (triage,       │
        │ on inbound msg │    │  summaries)    │
        └────────────────┘    └────────────────┘
```

Detailed component/hook/edge-function reference lives in [ARCHITECTURE.md](ARCHITECTURE.md). Product vision and channel roadmap live in [PLAN.md](PLAN.md).

---

## Data model (current)

The authoritative definitions live in [`supabase/migrations/`](supabase/migrations/). The abridged view:

**`persons`** — one row per human relationship. Columns include `id`, `user_id`, `display_name`, `avatar_url` / `avatar_stale` / `avatar_refreshed_at`, `status` (`pending` | `approved` | `blocked`), `notes`, `ai_summary`, `pinned_at`, `marked_unread`.

**`identities`** — links a person to a channel handle. Columns include `id`, `person_id`, `user_id`, `channel`, `handle`, `display_name`, `unipile_account_id`, `metadata`, plus a normalized-handle uniqueness constraint on `(user_id, channel, handle)`.

**`messages`** — every message across every channel, normalized. Columns include `id`, `user_id`, `person_id`, `identity_id`, `external_id`, `channel`, `direction`, `message_type`, `subject`, `body_text`, `body_html`, `attachments` (JSONB), `thread_id`, `sent_at`, `synced_at`, `triage`, `seen` / `delivered` / `read_at`, `edited`, `deleted` / `deleted_at`, `hidden`, `is_event` / `event_type`, `quoted_text` / `quoted_sender`, `reactions` (JSONB), `folder`, `flagged_at`, `provider_id`, `chat_provider_id`, `in_reply_to_message_id`, `smtp_message_id`, `unipile_account_id`, `embedding vector(2000)`. Uniqueness is `(user_id, external_id)` (migration 050); legacy global unique was dropped.

**`connected_accounts`** — one row per channel connection per user. Columns include `user_id`, `provider` (`unipile` | `x` | `imessage`), `channel`, `account_id`, `status`, `display_name` / `username` / `email` / `phone` / `avatar_url` / `provider_type`, `connection_params` (JSONB; AES-GCM-encrypted for X), `last_synced_at`.

**`circles` and `circle_members`** — user-defined groupings of persons with a color and sort order.

**`send_audit_log`** — every outbound send (text / attachment / reaction / edit) for forensic replay.

**`merge_log` + `merge_dismissed`** — record of manual/automatic person merges and dismissed suggestions.

**`x_oauth_state`** — PKCE state for the X OAuth flow. Rows older than 1 hour are purged every 15 minutes by a `pg_cron` job (migration 052).

**`deletion_log`** — audit of person deletions for manual recovery.

The conversation list you see in the UI is computed on the fly by the `get_conversations` RPC (migration 050) — there is no `conversations` table.

---

## Repository layout

```
convolios/
├── src/                         # React 19 frontend
│   ├── App.tsx                  # root, auth gate, skeleton, query persistence
│   ├── components/
│   │   ├── inbox/               # InboxList, conversation rows
│   │   ├── thread/              # ThreadView, ComposeBox, Email render (shadow DOM)
│   │   ├── sidebar/             # channels + circles nav
│   │   ├── settings/            # connections, circles, merge suggestions, preferences
│   │   └── icons/               # ChannelLogo
│   ├── hooks/                   # useConversations, useThread, useRealtimeMessages, useCircles, useMergeSuggestions, useFlaggedMessages
│   ├── stores/                  # inboxStore, accountsStore, preferencesStore (Tauri-persisted)
│   ├── lib/                     # auth, supabase client, queryClient
│   ├── utils/                   # channel labels, colors, time formatting
│   └── types/                   # barrel of TS interfaces matching DB columns
│
├── src-tauri/                   # Rust backend (Tauri 2)
│   ├── src/
│   │   ├── main.rs              # entrypoint
│   │   └── lib.rs               # all #[tauri::command] handlers
│   ├── permissions/             # capabilities and command allow-lists
│   ├── tauri.conf.json
│   └── Cargo.toml
│
├── supabase/
│   ├── migrations/              # numbered SQL migrations (001 → 052)
│   └── functions/               # Deno edge functions
│       ├── _shared/             # cors, auth, crypto, channel-map, logging, validate
│       ├── unipile-webhook/
│       ├── unipile-account-callback/
│       ├── x-account-callback/
│       └── merge-suggestions/
│
├── public/                      # static assets (favicon)
├── ARCHITECTURE.md              # implementation reference
├── PLAN.md                      # product strategy & roadmap
└── README.md                    # this file
```

---

## Setup

### Prerequisites

- **Node.js 20+**
- **Rust stable** (via rustup) with the target for your OS (`aarch64-apple-darwin`, `x86_64-pc-windows-msvc`, `x86_64-unknown-linux-gnu`)
- **Tauri prerequisites** — see <https://tauri.app/start/prerequisites/> (Xcode CLT on macOS, WebView2 on Windows, libwebkit2gtk on Linux)
- A Supabase project with the migrations in [`supabase/migrations/`](supabase/migrations/) applied
- A Unipile account and API key
- X API v2 credentials (for X DMs) and a Gemini API key (for triage)

### Environment

Copy `.env.example` to `.env.local` and fill in the values:

```ini
# Client
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=

# Server / Rust (never prefixed with VITE_)
SUPABASE_SERVICE_ROLE_KEY=
UNIPILE_API_KEY=
UNIPILE_API_URL=
UNIPILE_WEBHOOK_SECRET=
X_API_CLIENT_ID=
X_API_CLIENT_SECRET=
GEMINI_API_KEY=
# 32 bytes, base64-encoded. Required — app refuses to store X tokens plaintext.
TOKEN_ENCRYPTION_KEY=
```

`.env.local` is git-ignored. The Rust backend loads it at startup via `dotenvy` from the project root.

### Install and run

```bash
npm install            # Frontend + Tauri CLI
npm run tauri dev      # Dev: spawns Vite on 1420, Tauri shell on top
npm run build          # TypeScript + Vite production build of the web assets
npm run tauri build    # Full packaged installer (signed on macOS)
npm run lint           # ESLint across src/
```

Edge functions deploy via the Supabase CLI:

```bash
supabase functions deploy unipile-webhook
supabase functions deploy unipile-account-callback
supabase functions deploy x-account-callback
supabase functions deploy merge-suggestions
```

---

## Security notes

- **X OAuth tokens are AES-GCM-encrypted** using `TOKEN_ENCRYPTION_KEY` before they're written to `connected_accounts.connection_params`. Both the edge function callback and the Rust token-refresh path refuse to persist plaintext if the key is missing.
- **Email HTML** is sanitized (scripts, iframes, svg, math, form, link, base, object, embed, applet, portal, srcdoc, formaction, and dangerous URL protocols including `javascript:`, `vbscript:`, `data:text/html`) before being rendered in a shadow-DOM sandbox.
- **Webhook secrets** are compared in constant time via a double-HMAC pattern (see [`supabase/functions/_shared/auth.ts`](supabase/functions/_shared/auth.ts)).
- **Attachment size limits**: uploads and drag-drop capped at 100 MB; downloads capped at 200 MB.
- **Tenant scoping**: every service-role Rust query filters on `user_id`. `fetch_chat_avatars` takes `user_id` as a parameter and scopes all three lookups to that user.

---

## License

Proprietary. All rights reserved.
