# Convolios — Architecture Reference
_Last updated: April 11, 2026_

This document describes the actual implementation as it exists today. For the vision, roadmap, and build progress, see [PLAN.md](PLAN.md).

---

## Codebase Patterns

**Read this section first.** It defines how things are built in this project. All new code must follow these patterns — do not invent new ones.

### Component Patterns

- **One feature per file** — `Sidebar.tsx`, `InboxList.tsx`, `ThreadView.tsx`, `Settings.tsx`. No deep component tree.
- **Helper components live in the same file** as their parent — `GifPlayer`, `AttachmentMedia`, `ComposeBox` all live inside `ThreadView.tsx`.
- **Named exports** for components: `export function Sidebar()`, not default exports (except `App`).
- **Inline styles** for layout, colors, and spacing. Use CSS custom property tokens defined in `src/index.css` `@theme` block (e.g. `var(--color-surface)`, `var(--color-accent)`, `var(--radius-card)`). Never hardcode hex values.
- **CSS classes** only for reusable behaviors: `thin-scroll`, `chat-scroll`, `guild-pill`, `guild-icon`, `av-1`–`av-8`, `msg-compact`, `pulse-dot`.
- **Conditional rendering** uses `&&` (never `? : null`).
- **Zustand selectors** pull one field per call: `useInboxStore((s) => s.activeChannel)`.

### Scroll & Chat UI

- **`flex-direction: column-reverse`** on chat scroll containers — the browser natively starts at the bottom and stays there as content loads. No JavaScript scroll management.
- **`ResizeObserver` is not needed** — `column-reverse` handles async content growth (images, embeds).

### Hook Patterns

- **React Query for all server data** — conversations, threads, accounts. Zustand only for UI state (selection, filters).
- **Query keys**: `['conversations', userId]`, `['thread', personId, userId]`.
- **Fetching**: use `supabase.rpc()` for aggregations/lists, `supabase.from().select()` for simple reads.
- **`enabled` guards**: use `_.isString(id)` (Lodash), not `typeof` or `!!`.
- **Polling fallback**: `refetchInterval` switches between 8s (realtime down) and 30s (realtime healthy). Use `realtimeConnected` from `useRealtimeConnected()`.
- **Optimistic updates**: `queryClient.setQueryData` to append/modify cache, then `invalidateQueries` on error to reconcile.

### Rust IPC Patterns

- **`#[tauri::command] async fn`** with `Result<T, String>` return type.
- **All HTTP via `reqwest`** — shared client in `AppState` with connection pool.
- **Unipile calls**: `X-API-KEY` header, base URL from env. `serde_json::Value` for parsing.
- **Supabase from Rust**: direct REST to `/rest/v1/...` with `apikey` + `Authorization: Bearer <service_role>`. NOT the Supabase SDK.
- **RPC from Rust**: `POST /rest/v1/rpc/{function_name}` with JSON body using `p_`-prefixed parameters.
- **Error handling**: `.map_err(|e| format!("context: {e}"))` — errors become strings for the frontend.
- **Pagination**: use `fetch_paginated()` for Unipile list endpoints (handles `items` + `cursor`).

### Supabase Patterns

- **Migration naming**: `NNN_snake_case_description.sql` (e.g. `005_conversations_rpc.sql`).
- **RPC parameters**: always `p_`-prefixed (`p_user_id`, `p_person_id`).
- **RPC functions**: `LANGUAGE sql`, `STABLE`, explicit `RETURNS TABLE(...)`.
- **Edge Functions**: `Deno.serve`, `createClient` from `esm.sh/@supabase/supabase-js@2`, service role key from `Deno.env.get`.
- **Auth on webhooks**: check `x-webhook-secret` header against env secret.

### Type & Import Conventions

- **Types**: single barrel in `src/types/index.ts`. Interfaces match DB column names.
- **Utils**: single barrel in `src/utils/index.ts`. All display/channel helpers.
- **Lodash**: `_.isString()`, `_.isArray()`, `_.isNil()` — never `typeof`, never `Array.isArray()`.
- **Imports**: `from '../../types'`, `from '../../stores/inboxStore'`, `from '../../hooks/useThread'`. Path aliases not yet configured.

### Styling Conventions

- **Design tokens** defined in `src/index.css` via Tailwind v4 `@theme` block. All colors, radii, spacing, and typography are CSS custom properties (`var(--color-surface)`, `var(--radius-card)`, `var(--font-sm)`, etc.). Never use raw hex values — always reference the tokens.
- **Style primitives** in `src/components/thread/threadStyles.ts` — composable `CSSProperties` objects (`S.card`, `S.label`, `S.meta`, `S.media`, etc.) shared across all thread/media components. Spread with overrides: `{ ...S.card, display: 'flex' }`.
- **Inline styles** for layout, colors, and spacing — referencing `var(--color-*)` tokens, not hardcoded hex.
- **CSS classes** only for reusable behaviors: `thin-scroll`, `chat-scroll`, `guild-pill`, `guild-icon`, `av-1`–`av-8`, `msg-compact`, `pulse-dot`.
- **Hover states** use `onMouseEnter`/`onMouseLeave` mutating `e.currentTarget.style`.
- **Scrollbars**: use `chat-scroll` for main scroll areas, `thin-scroll` for narrow sidebars.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Desktop Shell (Tauri 2 / Rust)](#desktop-shell-tauri-2--rust)
3. [Frontend (React 19)](#frontend-react-19)
4. [Database (Supabase)](#database-supabase)
5. [Unipile Integration](#unipile-integration)
6. [Edge Functions](#edge-functions)
7. [AI Integration (Gemini)](#ai-integration-gemini)
8. [Data Flows](#data-flows)
9. [Authentication](#authentication)
10. [Realtime System](#realtime-system)
11. [Migration History](#migration-history)
12. [Known Issues & Tech Debt](#known-issues--tech-debt)

---

## System Overview

```
User ─── Tauri Desktop App ──┬── Unipile REST API (accounts, chats, messages, send)
                              ├── Supabase Postgres  (read/write persons, messages, etc.)
                              └── Supabase Realtime   (live message updates)

Unipile ─── Webhook ──► Supabase Edge Function ──┬── Supabase Postgres (persist)
                                                   └── Gemini 2.5 Flash  (triage)
```

Three runtime processes:
1. **Tauri app** — user-facing desktop client. React frontend + Rust backend making HTTP calls to Unipile and Supabase.
2. **Supabase Edge Functions** — serverless webhook handlers (Deno). Receive events from Unipile, persist to Postgres, call Gemini for triage.
3. **Supabase Realtime** — Postgres change notifications pushed to the frontend via WebSocket.

---

## Desktop Shell (Tauri 2 / Rust)

### File: `src-tauri/src/lib.rs`

The Rust backend is a single file (1665 lines) containing all Tauri IPC commands. It uses `reqwest` for HTTP and `serde_json` for serialization.

### Setup

```rust
tauri::Builder::default()
  .plugin(tauri_plugin_shell::init())     // Open URLs in browser
  .plugin(tauri_plugin_zustand::init())   // Persist Zustand stores to disk
  .plugin(tauri_plugin_deep_link::init()) // convolios:// URL handler
```

The `AppState` holds a shared `reqwest::Client` with 30s timeout and connection pooling.

Environment variables are loaded from `.env.local` and `.env` in the project root via `dotenvy`.

### Tauri IPC Commands (19 total)

| Command | Purpose |
|---------|---------|
| `check_unipile_connection` | Verify Unipile API key and URL are valid |
| `check_gemini_connection` | Verify Gemini API key works |
| `fetch_unipile_accounts` | List all accounts on the Unipile DSN |
| `register_unipile_webhook` | Register webhook URL with Unipile |
| `create_connect_link` | Generate Unipile Hosted Auth URL (opens in browser) |
| `sync_unipile_accounts` | Fetch Unipile accounts, deduplicate, upsert to `connected_accounts` |
| `disconnect_account` | Delete account from Unipile + mark `disconnected` in Supabase |
| `startup_sync` | On app launch: sync accounts + backfill last 24h of messages (Unipile + X + iMessage) |
| `backfill_messages` | Full historical backfill — all accounts including X DMs and iMessage |
| `send_message` | Send text message via Unipile, X API, or AppleScript (dispatched by channel) |
| `send_attachment` | Send file attachment via Unipile multipart upload |
| `send_voice_message` | Send voice note via Unipile |
| `add_reaction` | Add emoji reaction to a message via Unipile |
| `edit_message` | Edit a sent message (WhatsApp) via Unipile |
| `fetch_attachment` | Download attachment binary from Unipile, return as base64 (with disk cache) |
| `fetch_chat_avatars` | Fetch group chat avatars from Unipile, store in `persons.avatar_url` |
| `reconcile_chats` | Reconcile stale chat/thread IDs after chat resolution |
| `connect_x_account` | Initiate X OAuth 2.0 PKCE flow, store state, return auth URL |
| `connect_imessage` | Verify chat.db access, create connected_account for macOS Messages |

### Key Helper Functions

| Function | Purpose |
|----------|---------|
| `unipile_config()` | Read `UNIPILE_API_KEY` and `UNIPILE_API_URL` from env |
| `fetch_paginated()` | Generic paginated GET with cursor-based pagination |
| `dedupe_accounts()` | Deduplicate Unipile accounts (phone/email normalization) |
| `channel_from_type()` | Map account types (LINKEDIN, WHATSAPP, MAIL, MOBILE, X, IMESSAGE...) to our `Channel` |
| `map_unipile_status()` | Map Unipile status strings to our status enum |
| `normalize_handle()` | Strip WhatsApp suffixes, normalize LinkedIn URLs, lowercase |
| `persist_outbound()` | Save a sent message to Supabase via REST API |
| `resolve_chat()` | Find or create a chat for sending (lookup by thread_id or person handle) |
| `patch_stale_thread_ids()` | Fix messages with outdated thread_ids after chat resolution |
| `base64_encode()` / `base64_engine()` | Encode binary data (avatars, attachments) to base64 |

### Environment Variables Used by Rust

| Variable | Required | Purpose |
|----------|----------|---------|
| `UNIPILE_API_KEY` | Yes | Unipile API authentication |
| `UNIPILE_API_URL` | Yes | Unipile DSN base URL (e.g., `https://api5.unipile.com:13555`) |
| `VITE_SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key (bypasses RLS) |
| `GEMINI_API_KEY` | Yes | Gemini API for health check |
| `X_API_CLIENT_ID` | For X | X/Twitter OAuth 2.0 client ID |
| `X_API_CLIENT_SECRET` | For X | X/Twitter OAuth 2.0 client secret |

---

## Frontend (React 19)

### Entry Point: `src/App.tsx`

The app renders inside a `HashRouter` with two routes:
- `/` — main inbox (Sidebar + InboxList + ThreadView)
- `/settings` — account management

Wrapped in:
- `QueryClientProvider` (React Query v5 with LocalStorage persistence)
- `RealtimeContext` (Supabase Realtime subscription)
- `ErrorBoundary` (catch-all crash handler)

Auth state is managed via `useAuth()` hook. If not authenticated, shows an OTP login form.

### Component Tree

```
App
├── Sidebar                    # Channel navigation (Discord guild-bar style)
│   ├── "All Messages" button
│   ├── Per-channel buttons (WhatsApp, LinkedIn, etc.)
│   └── Settings link
├── InboxList                  # Conversation previews
│   ├── Search bar
│   ├── Triage filter (urgent/human/newsletter/noise)
│   └── ConversationPreview cards (avatar, name, preview text, timestamp, channel badge)
└── ThreadView                 # Full message thread
    ├── Message list (grouped by date, sender)
    │   ├── Text messages
    │   ├── Attachments (images, files, voice notes)
    │   ├── Email HTML (rendered in Shadow DOM)
    │   ├── System events (group created, missed call, etc.)
    │   ├── Reactions
    │   ├── Quoted/reply messages
    │   ├── Locations (map links)
    │   └── VCards (contact cards)
    └── ComposeBox
        ├── Text input (Enter to send, Shift+Enter for newline)
        ├── File attachment (click or drag & drop)
        ├── Voice note recording
        └── Reply-to context bar
```

### Hooks

| Hook | File | Purpose |
|------|------|---------|
| `useConversations` | `src/hooks/useConversations.ts` | Fetches conversation list via `get_conversations` RPC (server-side DISTINCT ON + persons JOIN). Calls `get_prev_inbound_batch` RPC for outbound conversation previews. Unread count comes from real `read_at`-based count. |
| `useThread` | `src/hooks/useThread.ts` | Fetches all messages for a person, ordered by `sent_at`. Includes `useAddOptimisticMessage` for instant UI updates on send. |
| `useRealtimeMessages` | `src/hooks/useRealtimeMessages.ts` | Subscribes to Supabase Realtime for `messages` INSERT/UPDATE events. Robust retry with exponential backoff, heartbeat check, and fallback polling. |
| `useAuth` | `src/lib/auth.ts` | Manages Supabase Auth state. Handles deep link callbacks (`convolios://auth`). |

### Stores (Zustand)

| Store | File | State |
|-------|------|-------|
| `inboxStore` | `src/stores/inboxStore.ts` | `selectedPersonId`, `activeChannel`, `triageFilter`, `searchQuery`. Includes `markConversationRead` action (calls Supabase RPC). Persisted via `@tauri-store/zustand`. |
| `accountsStore` | `src/stores/accountsStore.ts` | `accounts[]`, `loading`, `error`. Fetches from Supabase, subscribes to Realtime for status changes, includes polling fallback. |

### Utility Functions (`src/utils/index.ts`)

| Function | Purpose |
|----------|---------|
| `CHANNEL_META` | Label, abbreviation, and color for each channel |
| `CHANNEL_ALIAS` | Maps provider names (google_oauth, gmail, outlook...) to normalized channel |
| `channelLabel(ch)` | Human-readable channel name |
| `channelAbbr(ch)` | Two-letter abbreviation |
| `channelColor(ch)` | Hex color for badges |
| `channelIcon(ch)` | Badge text (same as abbr) |
| `formatTimestamp(iso)` | "Today at 2:30 PM", "Yesterday at ...", or "04/11/2026 2:30 PM" |
| `shortTime(iso)` | "2:30 PM" |
| `dateDivider(iso)` | "Today", "Yesterday", or "April 11, 2026" |
| `relativeTime(iso)` | "now", "5m ago", "3h ago", "Yesterday", "Apr 11" |
| `initials(name)` | First letter of first two words |
| `avatarCls(id)` | Deterministic CSS class `av-1` through `av-8` |
| `cleanPreviewText(text)` | Strip zero-width chars, decode HTML entities, collapse whitespace |
| `accountDisplayLabel(a)` | Best display label for a ConnectedAccount (email > phone > username > name > channel) |

### TypeScript Types (`src/types/index.ts`)

| Type | Fields (key ones) |
|------|------------------|
| `Person` | id, user_id, display_name, avatar_url, notes, ai_summary |
| `Identity` | id, person_id, channel, handle, display_name, unipile_account_id |
| `Message` | id, user_id, person_id, channel, direction, body_text, body_html, attachments, thread_id, sender_name, reactions, triage, seen, delivered, edited, deleted, hidden, is_event, event_type, quoted_text, quoted_sender, provider_id, chat_provider_id, in_reply_to_message_id, smtp_message_id, folder, read_at |
| `ConnectedAccount` | id, user_id, provider, channel, account_id, status, display_name, email, phone, username, avatar_url, provider_type, connection_params, last_synced_at |
| `ConversationPreview` | person, lastMessage, unreadCount, prevInboundBody, prevInboundSender |
| `Channel` | Union: whatsapp, linkedin, instagram, telegram, email, x, imessage, sms, slack, clickup, google_chat |
| `TriageLevel` | Union: urgent, human, newsletter, notification, noise, unclassified |
| `Direction` | Union: inbound, outbound |

### React Query Configuration (`src/lib/queryClient.ts`)

- `staleTime`: 30s
- `gcTime`: 10 minutes
- `refetchOnWindowFocus`: true
- `networkMode`: 'offlineFirst'
- `retry`: 1

Query cache is persisted to LocalStorage via `persistQueryClient`.

---

## Database (Supabase)

### Tables

#### `persons`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_id | TEXT NOT NULL | Supabase Auth user ID |
| display_name | TEXT NOT NULL | |
| avatar_url | TEXT | Base64 data URIs for group avatars (tech debt) |
| notes | TEXT | |
| ai_summary | TEXT | Cached context brief (not yet populated) |
| ai_summary_updated_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

#### `identities`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| person_id | UUID FK NOT NULL | References `persons(id)` CASCADE |
| channel | TEXT NOT NULL | whatsapp, linkedin, instagram, telegram, email |
| handle | TEXT NOT NULL | Normalized: lowercase, WhatsApp suffixes stripped |
| display_name | TEXT | Name as shown on that channel |
| unipile_account_id | TEXT | Links to the connected account that sourced this identity |
| user_id | TEXT | Added in migration 007, backfilled from persons |
| metadata | JSONB | |
| created_at | TIMESTAMPTZ | |

**Constraint:** `UNIQUE(channel, handle)` — this is **global** across all users (known issue, should be per-user).

**Index:** `identities_user_channel_handle_idx ON (user_id, channel, handle)` (added in 007).

#### `messages`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_id | TEXT NOT NULL | |
| person_id | UUID FK | References `persons(id)` |
| identity_id | UUID FK | References `identities(id)` |
| external_id | TEXT UNIQUE | Dedup key (Unipile message ID) |
| channel | TEXT NOT NULL | |
| direction | TEXT NOT NULL | 'inbound' or 'outbound' |
| message_type | TEXT | 'dm', 'group', 'channel' |
| subject | TEXT | Email subject lines |
| body_text | TEXT | Plain text content |
| body_html | TEXT | HTML content (emails) |
| attachments | JSONB | Array of attachment objects |
| thread_id | TEXT | Unipile chat/thread ID |
| sender_name | TEXT | Display name of sender (added mig 004) |
| reactions | JSONB | Array of {value, emoji, sender_id, is_sender} (added mig 004) |
| sent_at | TIMESTAMPTZ NOT NULL | |
| synced_at | TIMESTAMPTZ | |
| triage | TEXT | urgent, human, newsletter, notification, noise, unclassified |
| embedding | vector(2000) | pgvector column (not yet populated) |
| seen | BOOLEAN | (added mig 007) |
| delivered | BOOLEAN | (added mig 007) |
| edited | BOOLEAN | (added mig 007) |
| deleted | BOOLEAN | (added mig 007) |
| hidden | BOOLEAN | (added mig 007) |
| is_event | BOOLEAN | System events (added mig 007) |
| event_type | TEXT | (added mig 007) |
| quoted_text | TEXT | Reply context (added mig 007) |
| quoted_sender | TEXT | (added mig 007) |
| provider_id | TEXT | Deep-link to provider (added mig 007) |
| chat_provider_id | TEXT | (added mig 007) |
| in_reply_to_message_id | TEXT | Email threading (added mig 007) |
| smtp_message_id | TEXT | (added mig 007) |
| unipile_account_id | TEXT | (added mig 007) |
| folder | TEXT | IG Primary/General, LI Focused/Other (added mig 007) |
| read_at | TIMESTAMPTZ | NULL = unread (added mig 007) |
| seen_by | JSONB | Per-participant read status (added mig 009) |

**Key indexes:**
- `messages_person_idx ON (person_id, sent_at DESC)`
- `messages_user_triage_idx ON (user_id, triage, sent_at DESC)`
- `messages_channel_idx ON (user_id, channel, sent_at DESC)`
- `messages_thread_idx ON (user_id, thread_id, sent_at DESC)`
- `messages_unread_idx ON (user_id, person_id, read_at) WHERE read_at IS NULL AND direction = 'inbound'`
- `messages_embedding_idx USING hnsw (embedding vector_cosine_ops)`

**Realtime:** Enabled via `ALTER PUBLICATION supabase_realtime ADD TABLE messages` with `REPLICA IDENTITY FULL`.

#### `connected_accounts`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_id | TEXT NOT NULL | |
| provider | TEXT NOT NULL | Always 'unipile' for now |
| channel | TEXT NOT NULL | whatsapp, linkedin, instagram, telegram, email |
| account_id | TEXT | Unipile's account ID |
| status | TEXT | active, disconnected, expired, credentials, error |
| credentials | JSONB | Unused (was planned for direct integrations) |
| display_name | TEXT | (added mig 012) |
| email | TEXT | (added mig 012) |
| phone | TEXT | (added mig 012) |
| username | TEXT | (added mig 012) |
| avatar_url | TEXT | (added mig 012) |
| provider_type | TEXT | (added mig 012) |
| connection_params | JSONB | (added mig 012) |
| last_synced_at | TIMESTAMPTZ | (added mig 012) |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Constraint:** `UNIQUE(user_id, provider, account_id)` (added in migration 006).

**Realtime:** Enabled with `REPLICA IDENTITY FULL`.

### Row Level Security (RLS)

All four tables have RLS enabled. Policies use `auth.uid()::text = user_id` to scope access.

Edge Functions and Rust backend use the **service role key** which bypasses RLS.

### RPC Functions

| Function | Purpose |
|----------|---------|
| `get_conversations(p_user_id)` | Returns one row per person with latest message, seen/delivered status, and real unread count based on `read_at IS NULL`. Prev-inbound stubbed to NULL (fetched separately via batch RPC). |
| `get_prev_inbound_batch(p_user_id, p_person_ids)` | Batch fetch latest inbound message per person for outbound conversation previews. |
| `mark_conversation_read(p_user_id, p_person_id)` | Sets `read_at = now()` on all unread inbound messages for a person. |
| `backfill_find_or_create_person(...)` | Find or create a person + identity during backfill. Handle-only matching (no display name fallback). Race-condition safe. EXECUTE revoked from frontend roles. |

---

## Unipile Integration

### How Accounts Are Connected

1. User clicks "Connect [channel]" in Settings
2. Rust calls `create_connect_link` → Unipile `POST /api/v1/hosted/accounts/link` with callback URL
3. Unipile returns a hosted auth URL → opened in user's default browser
4. User authenticates with their channel (WhatsApp QR, LinkedIn OAuth, etc.)
5. Unipile calls back to `supabase/functions/unipile-account-callback/`
6. Edge Function fetches full account details from Unipile and upserts to `connected_accounts`
7. Frontend detects the new account via Realtime subscription on `connected_accounts`

### How Messages Are Ingested

**Real-time (webhook):**
1. Unipile sends webhook event to `supabase/functions/unipile-webhook/`
2. Edge Function validates `UNIPILE_WEBHOOK_SECRET`
3. Routes event to handler based on `event` field
4. For `message_received`: resolves account → determines direction → finds/creates person → persists message → triggers Gemini triage (non-blocking)
5. Frontend receives the new message via Supabase Realtime subscription

**Backfill (on-demand from Rust):**
1. Rust `backfill_messages` iterates each connected account
2. For each account, fetches all chats via `GET /api/v1/chats?account_id=X`
3. For each chat, fetches messages via `GET /api/v1/chats/{chat_id}/messages`
4. Paginates with cursor until no more pages
5. For each message: calls `backfill_find_or_create_person` RPC → inserts to `messages` table
6. `startup_sync` does a lightweight version (last 24h only) on every app launch

### Unipile Event Types Handled

| Event | Handler | What it does |
|-------|---------|-------------|
| `message_received` | `handleMessageReceived` | Persist message, resolve person, triage |
| `mail_received` | `handleEmailEvent` | Fetch full email from Unipile, persist |
| `mail_sent` | `handleEmailEvent` | Same flow for outbound email |
| `mail_moved` | `handleMailMoved` | Update folder |
| `message_reaction` | `handleMessageReaction` | Update reactions JSONB array |
| `message_read` | `handleMessageRead` | Set seen=true |
| `message_edited` | `handleMessageEdited` | Update body_text |
| `message_deleted` | `handleMessageDeleted` | Set deleted=true |
| `message_delivered` | `handleMessageDelivered` | Set delivered=true |
| `account_connected` | `handleAccountStatus` | Update connected_accounts status |
| `account_disconnected` | `handleAccountStatus` | Update connected_accounts status |
| `account_error` | `handleAccountStatus` | Update connected_accounts status |
| `creation_success` | `handleAccountStatus` | Update connected_accounts status |
| `reconnected` | `handleAccountStatus` | Update connected_accounts status |
| `creation_fail` | `handleAccountStatus` | Update connected_accounts status |
| `error` | `handleAccountStatus` | Update connected_accounts status |
| `credentials` | `handleAccountStatus` | Update connected_accounts status |

### Unipile API Endpoints Used

| Endpoint | Used in | Purpose |
|----------|---------|---------|
| `GET /api/v1/accounts` | Rust `fetch_unipile_accounts` | List all connected accounts |
| `GET /api/v1/accounts/{id}` | Edge Function callback | Get account details |
| `POST /api/v1/hosted/accounts/link` | Rust `create_connect_link` | Generate hosted auth URL |
| `DELETE /api/v1/accounts/{id}` | Rust `disconnect_account` | Remove account from Unipile |
| `POST /api/v1/webhooks` | Rust `register_unipile_webhook` | Register webhook URL |
| `GET /api/v1/chats?account_id=X` | Rust `backfill_messages` | List chats for backfill |
| `GET /api/v1/chats/{id}/messages` | Rust `backfill_messages` | Get messages in a chat |
| `GET /api/v1/messages/{id}` | Edge Function | Fetch full message (email) |
| `POST /api/v1/chats/{id}/messages` | Rust `send_message` | Send text message |
| `POST /api/v1/chats/{id}/messages` (multipart) | Rust `send_attachment` | Send file |
| `POST /api/v1/chats/{id}/messages` (multipart audio) | Rust `send_voice_message` | Send voice note |
| `PUT /api/v1/messages/{id}/reactions` | Rust `add_reaction` | Add emoji reaction |
| `PATCH /api/v1/messages/{id}` | Rust `edit_message` | Edit message text |
| `GET /api/v1/messages/{id}/attachment` | Rust `fetch_attachment` | Download attachment |
| `GET /api/v1/chats/{id}` | Edge Function, Rust | Get chat info (avatars, attendees) |

### Channel Mapping

Unipile `account_type` values map to our `Channel` type:

| Unipile | Our Channel |
|---------|-------------|
| LINKEDIN | linkedin |
| WHATSAPP | whatsapp |
| INSTAGRAM | instagram |
| TELEGRAM | telegram |
| MAIL, GMAIL, GOOGLE, GOOGLE_OAUTH, OUTLOOK, MICROSOFT, IMAP | email |
| MOBILE, SMS, RCS | sms |
| X, TWITTER | x |
| IMESSAGE, APPLE | imessage |

---

## Direct Channel Integrations

Some channels bypass Unipile and are integrated directly.

### X / Twitter (Direct API)

- **Auth**: OAuth 2.0 PKCE flow. Rust generates `code_verifier` + `code_challenge`, stores state in `x_oauth_state` table, opens X consent URL in browser. On callback, `x-account-callback` Edge Function exchanges the code for tokens server-side.
- **Backfill**: `backfill_x_dms` fetches DMs via `GET https://api.x.com/2/dm_events` with user fields/expansions. Creates persons with avatars.
- **Send**: `send_x_dm` via `POST https://api.x.com/2/dm_conversations/with/:participant_id/messages`.
- **Env vars**: `X_API_CLIENT_ID`, `X_API_CLIENT_SECRET`.
- **Edge Function**: `x-account-callback/index.ts` handles the OAuth redirect.

### iMessage / SMS (macOS Local)

- **Connect**: `connect_imessage` command checks `~/Library/Messages/chat.db` accessibility (requires Full Disk Access). Creates a `local-imessage` connected account in Supabase.
- **Backfill**: `backfill_imessage` reads `chat.db` via `rusqlite`, groups by `chat_guid`, resolves persons, inserts messages with `imsg-` prefixed external IDs.
- **Send**: `send_imessage_dm` uses AppleScript (`osascript`) to send via Messages.app. Parses `chat_id` to determine iMessage vs SMS service.
- **Limitations**: macOS only. No real-time push (backfill on app launch). Requires Full Disk Access permission. SMS only available if iPhone SMS Forwarding is enabled.
- **Dependencies**: `rusqlite` (bundled SQLite, in Cargo.toml).

### SMS via Unipile (Android)

- **Connect**: Standard Unipile Hosted Auth flow. Account type `MOBILE`.
- **Backfill/Send/Webhook**: Uses the same Unipile infrastructure as WhatsApp, LinkedIn, etc. No special handling needed.
- **Limitations**: Android only. iOS not supported by Unipile for SMS.

### `unipile-webhook/index.ts`

The main webhook processor. 908 lines. Runs as a Supabase Edge Function (Deno).

**Authentication:** Checks `x-webhook-secret` header (or `Unipile-Auth` fallback) against `UNIPILE_WEBHOOK_SECRET`.

**Entity Resolution Flow (`findOrCreatePerson`):**
1. Normalize the sender handle (strip WhatsApp suffixes, lowercase, etc.)
2. Look up identity by `(channel, handle)` scoped to user
3. If not found: try variant handles (with/without `+`, WhatsApp phone normalization)
4. If not found: create new person + identity
5. Return `{person_id, identity_id}`

**Outbound Deduplication:**
When a `message_received` event arrives, the webhook checks if it's actually an outbound message (sent by the user via Convolios) by looking for a message with the same `body_text`, `channel`, `user_id`, and `sent_at` within 90 seconds. If found, it updates the existing record with the Unipile `external_id` instead of creating a duplicate.

### `unipile-account-callback/index.ts`

Handles the callback after Unipile Hosted Auth completes.

**Authentication:** Checks `x-callback-secret` header against `UNIPILE_CALLBACK_SECRET`.

**Flow:**
1. Receive `account_id` from Unipile callback
2. Fetch full account details from Unipile `GET /api/v1/accounts/{id}`
3. Upsert to `connected_accounts` with all detail fields (display_name, email, phone, etc.)

### `x-account-callback/index.ts`

Handles the X/Twitter OAuth 2.0 PKCE callback.

**Flow:**
1. Receive `code` and `state` from X OAuth redirect
2. Look up `code_verifier` from `x_oauth_state` table using `state`
3. Exchange authorization code for access/refresh tokens via `POST https://api.x.com/2/oauth2/token`
4. Fetch user profile from `GET https://api.x.com/2/users/me`
5. Upsert `connected_account` with X credentials
6. Clean up `x_oauth_state` row
7. Show success page with `window.close()` to dismiss browser tab

**Security:** `escapeHtml()` applied to all user-controlled text in HTML responses.

---

## AI Integration (Gemini)

### Triage (Implemented)

Called non-blocking from the webhook Edge Function after message persistence.

**Model:** Gemini 2.5 Flash (`gemini-2.5-flash`)

**Prompt structure:** Classifies messages into one of: `urgent`, `human`, `newsletter`, `notification`, `noise`.

**Flow:**
1. Message is persisted to Supabase
2. `triageMessage(messageId, bodyText, channel, direction)` is called (fire-and-forget, does not block webhook response)
3. Calls Gemini API with classification prompt
4. Updates `messages.triage` with the result

### Embeddings / Semantic Search (Not Yet Implemented)

- The `embedding vector(2000)` column exists but is never populated
- No embedding pipeline is built
- The HNSW index is created but unused
- Plan specifies 3072-dim (Gemini Embedding 2) but DB has 2000-dim

---

## Data Flows

### Message Lifecycle (Inbound)

```
Unipile ──webhook──► Edge Function
                       │
                       ├── resolveAccount(account_id)    → get user_id
                       ├── normalizeHandle(sender)       → clean handle
                       ├── findOrCreatePerson(handle)    → get person_id + identity_id
                       ├── INSERT INTO messages          → persist
                       ├── triageMessage() [async]       → Gemini classification
                       └── return 200
                       
Supabase Realtime ──websocket──► React Frontend
                                   │
                                   ├── invalidate queries → ['conversations', userId]
                                   └── invalidate queries → ['thread', personId, userId]
```

### Message Lifecycle (Outbound)

```
User types in ComposeBox ──► Rust send_message command
                               │
                               ├── resolve_chat(person, channel) → find/create chat_id
                               ├── POST /api/v1/chats/{id}/messages → Unipile sends it
                               ├── persist_outbound() → INSERT INTO messages (immediate)
                               └── return success
                               
React Frontend ──optimistic──► adds message to thread cache instantly
                               
Later: Unipile webhook fires message_received for same message
  → webhook deduplication logic matches it, updates external_id only
```

### Account Connection Flow

```
User clicks "Connect WhatsApp" ──► Rust create_connect_link
                                     │
                                     ├── POST /api/v1/hosted/accounts/link
                                     ├── Opens browser with hosted auth URL
                                     └── User authenticates (QR code / OAuth)
                                     
Unipile ──callback──► Edge Function (unipile-account-callback)
                        │
                        ├── GET /api/v1/accounts/{id}
                        └── UPSERT connected_accounts
                        
Supabase Realtime ──► React Frontend
                        └── accountsStore updates
```

---

## Authentication

**Provider:** Supabase Auth (magic link OTP)

**Flow:**
1. User enters email in login form
2. `supabase.auth.signInWithOtp({ email })` sends magic link
3. User clicks link → opens `convolios://auth#access_token=...`
4. Tauri deep link handler catches the URL
5. `useAuth` hook extracts tokens from URL fragment
6. `supabase.auth.setSession({ access_token, refresh_token })` establishes session
7. `onAuthStateChange` fires → app re-renders with user context

**Note:** The original plan called for Clerk auth. This was changed to Supabase Auth to reduce vendor dependencies. The `persons.user_id` column stores the Supabase Auth UUID (cast to text).

---

## Realtime System

### Architecture (`src/hooks/useRealtimeMessages.ts`)

The realtime system has three layers of resilience:

1. **Primary:** Supabase Realtime WebSocket subscription on `messages` table, filtered by `user_id`
2. **Heartbeat:** Supabase's built-in `heartbeatCallback` monitors connection health every 15s, auto-reconnects on `'disconnected'`. Web Worker (`worker: true`) prevents background tab throttling.
3. **Fallback polling:** If WebSocket disconnects, polls every 8 seconds. After 2 minutes of continuous disconnection, shows "Live updates paused" banner with manual retry.

**Reconnection:**
- Supabase Realtime has built-in auto-reconnect with exponential backoff (1s, 2s, 5s, 10s)
- The `heartbeatCallback` in `src/lib/supabase.ts` explicitly calls `supabase.realtime.connect()` on disconnect as a fallback
- On window focus: invalidates all queries
- On network online: reconnects if not already connected

**Cache invalidation:**
- On `INSERT`: invalidates `['conversations', userId]` and `['thread', personId, userId]`
- On `UPDATE`: same invalidation pattern

The `useConversations` hook also adjusts its polling interval based on realtime connection status: 30s when connected, 8s when disconnected.

---

## Migration History

| # | File | What it does |
|---|------|-------------|
| 001 | `001_initial_schema.sql` | Core tables: persons, identities, messages, connected_accounts. pgvector, RLS, indexes. |
| 002 | `002_enable_realtime.sql` | Enable Realtime on messages and connected_accounts. |
| 003 | `003_backfill_function.sql` | First version of `backfill_find_or_create_person` RPC. |
| 004 | `004_sender_reactions.sql` | Add `sender_name` and `reactions` columns to messages. |
| 005 | `005_conversations_rpc.sql` | `get_conversations` RPC with lateral join for prev_inbound. Superseded by 007/010. |
| 006 | `006_schema_hardening.sql` | Unique constraint on connected_accounts. Indexes. person_id NOT NULL on identities. Hardened backfill RPC. |
| 007 | `007_message_metadata_expansion.sql` | Major expansion: seen, delivered, edited, deleted, hidden, is_event, quoted_text, provider_id, email threading, folder, read_at. Added user_id to identities. Updated `get_conversations` with unread count. Added `mark_conversation_read`. |
| 008 | `008_replica_identity_full.sql` | `REPLICA IDENTITY FULL` on messages and connected_accounts for Realtime filtered subscriptions. |
| 009 | `009_seen_by_column.sql` | Add `seen_by` JSONB column to messages. |
| 010 | `010_conversations_seen_delivered.sql` | Rewrite `get_conversations` to remove lateral join (perf). Add `get_prev_inbound_batch` as separate RPC. Unread count stubbed to 0. |
| 011 | _(skipped)_ | No migration with this number exists. |
| 012 | `012_connected_accounts_details.sql` | Add detail columns to connected_accounts: display_name, email, phone, username, avatar_url, provider_type, connection_params, last_synced_at. |
| 013 | `013_backfill_person_name_fallback.sql` | Enhanced backfill RPC: display_name fallback match before creating new person. Race-condition handling. |
| 014 | `014_merge_duplicate_persons.sql` | One-time fix: merge duplicate persons with same (user_id, display_name). |
| 015 | `015_merge_fuzzy_duplicate_persons.sql` | One-time fix: merge fuzzy duplicates (e.g., "Sandro" vs "Sandro Kratz") with prefix matching on same channel. |
| 016 | `016_restore_unread_count.sql` | Restore real `read_at`-based unread count in `get_conversations` RPC (was stubbed to 0 in migration 010). |
| 017 | `017_avatar_storage_and_staleness.sql` | Add `avatar_stale`, `avatar_refreshed_at` columns to persons. Create `avatars` storage bucket with RLS. |
| 018 | `018_cascade_delete_messages.sql` | Add `ON DELETE CASCADE` to messages `person_id` FK. |
| 019 | `019_deletion_audit_log.sql` | Create `deletion_log` table for person deletion tracking. |
| 020 | `020_rpc_include_avatar_url.sql` | Re-include `avatar_url` in `get_conversations` RPC (now short Storage URLs, not base64). Remove `SECURITY DEFINER`. |
| 021 | `021_remove_name_based_matching.sql` | Remove dangerous display_name fallback from `backfill_find_or_create_person`. Handle-only matching. |
| 022 | `022_harden_security_definer.sql` | Revoke EXECUTE on backfill RPC from frontend roles. Add `auth.uid()` validation to `mark_conversation_read`. |

---

## Known Issues & Tech Debt

### Tech debt (not broken, worth knowing)

1. **Embedding dimension mismatch** — DB has `vector(2000)`, Gemini Embedding 2 outputs 3072-dim. Not relevant until the embedding pipeline is built. When it is: either use Gemini's `output_dimensionality` parameter to truncate, or alter the column.

2. **Avatars stored in Supabase Storage** — Avatars are now stored in the `avatars` bucket in Supabase Storage as short URLs. `persons.avatar_url` contains the public URL (~100 chars). Staleness tracked via `avatar_stale` and `avatar_refreshed_at` columns.

3. **No `ChannelProvider` abstraction** — PLAN.md called for abstracting Unipile behind a generic interface. Not implemented. Unipile is hardcoded in the Rust backend. Only matters if switching providers.

### Non-issues (previously flagged, now clarified)

4. **`identities` UNIQUE constraint is global** — `UNIQUE(channel, handle)` without `user_id`. This is fine for a single-user app — no cross-user collisions possible.

5. **Service role key on disk** — The user's own machine accessing their own data. Acceptable for a single-user desktop app.

6. **No message partitioning** — Irrelevant for single-user. One user's data is effectively one partition.
