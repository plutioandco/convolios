package main

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/mautrix-meta/pkg/messagix"
	"go.mau.fi/mautrix-meta/pkg/messagix/cookies"
	"go.mau.fi/mautrix-meta/pkg/messagix/table"
	"go.mau.fi/mautrix-meta/pkg/messagix/types"
)

// Bridge is the single per-process bridge state. One sidecar serves exactly
// one Convolios account (Instagram or Messenger); see the Rust-side
// BridgeManager which spawns one sidecar per on-device account.
//
// Login flow uses the cookie jar the parent lifts off its Tauri login
// webview — we never see usernames or passwords. Meta's cookie-based auth
// means no in-app 2FA: if the session needs a challenge/consent/checkpoint,
// the parent points a webview at Meta's own site, the user resolves it
// there, and fresh cookies come back the next time they click Connect.
type Bridge struct {
	mu           sync.Mutex
	session      *session
	notifier     func(method string, params any)
	eventStopCh  chan struct{}
	eventRunning atomic.Bool
	logger       zerolog.Logger
}

// session captures the state of a logged-in Meta account.
type session struct {
	platform  types.Platform
	channel   string
	accountID string
	username  string
	client    *messagix.Client
	cookies   *cookies.Cookies
	// lastCookieSnapshot is compared against the live jar to detect rotation;
	// we only emit cookies_updated when the map actually changes.
	lastCookieSnapshot map[string]string
	// initialTable holds the LSTable from LoadMessagesPage. Processed once
	// in BeginEvents (after the Rust side has set user_id) to avoid
	// emitting messages before the webhook has a valid user_id.
	initialTable *table.LSTable
	// knownContacts tracks Meta contact IDs (friends / people in the user's
	// address book) across every LSTable we see. A message whose other-party
	// handle matches an entry here is emitted with is_known_contact=true,
	// which tells the webhook to auto-approve the person instead of
	// parking them in the Gate.
	knownContactsMu sync.Mutex
	knownContacts   map[int64]struct{}
	// backfillRunning prevents overlapping runFullInboxSync passes when
	// Meta fires several Ready events in quick succession.
	backfillRunning atomic.Bool
}

func NewBridge() *Bridge {
	// Log to stderr so the Rust parent picks up every messagix diagnostic
	// in its own log files. ConsoleWriter would add ANSI colour codes that
	// look ugly when tail'ed into plain log files, so plain JSON lines it is.
	logger := zerolog.New(os.Stderr).With().Timestamp().Str("component", "meta-bridge").Logger()
	return &Bridge{logger: logger}
}

func (b *Bridge) SetNotifier(fn func(method string, params any)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.notifier = fn
}

func (b *Bridge) notify(method string, params any) {
	b.mu.Lock()
	fn := b.notifier
	b.mu.Unlock()
	if fn != nil {
		fn(method, params)
	}
}

// ─── Param / result types ────────────────────────────────────────────────

type loginParams struct {
	Channel string            `json:"channel"`
	Cookies map[string]string `json:"cookies"`
}

type resumeParams struct {
	Channel   string            `json:"channel"`
	AccountID string            `json:"account_id"`
	Cookies   map[string]string `json:"cookies"`
}

type beginEventsParams struct {
	AccountID string `json:"account_id"`
}

type sendParams struct {
	AccountID string `json:"account_id"`
	ThreadID  string `json:"thread_id"`
	Text      string `json:"text"`
}

// LoginResult is the shape the Rust parent expects back from the `login`
// RPC. Only `success` stores a new account — every other status is a
// "go reopen the webview and let the user finish what Meta wants" signal.
type LoginResult struct {
	Status      string            `json:"status"`
	Channel     string            `json:"channel,omitempty"`
	AccountID   string            `json:"account_id,omitempty"`
	Username    string            `json:"username,omitempty"`
	DisplayName string            `json:"display_name,omitempty"`
	AvatarURL   string            `json:"avatar_url,omitempty"`
	Cookies     map[string]string `json:"cookies,omitempty"`
}

// ─── Login flow ───────────────────────────────────────────────────────────

func (b *Bridge) Login(ctx context.Context, p loginParams) (any, *rpcErr) {
	platform := platformFromChannel(p.Channel)
	if platform == types.Unset {
		return nil, invalidParams(errors.New("channel must be 'instagram' or 'messenger'"))
	}
	if len(p.Cookies) == 0 {
		return nil, invalidParams(errors.New("cookies required"))
	}

	b.logger.Info().
		Str("channel", p.Channel).
		Int("cookie_count", len(p.Cookies)).
		Func(func(e *zerolog.Event) {
			for k, v := range p.Cookies {
				if len(v) > 12 {
					e.Str("cookie_"+k, v[:6]+"…"+v[len(v)-6:])
				} else {
					e.Str("cookie_"+k, v)
				}
			}
		}).
		Msg("login: received cookies")

	jar, err := buildCookieJar(platform, p.Cookies)
	if err != nil {
		b.logger.Warn().Err(err).Msg("login: buildCookieJar failed")
		return nil, invalidParams(err)
	}

	b.logger.Info().
		Int64("fbid", jar.GetUserID()).
		Bool("is_logged_in", jar.IsLoggedIn()).
		Msg("login: cookie jar built")

	client, userInfo, initialTable, err := b.loadClient(ctx, platform, jar)
	if err != nil {
		b.logger.Warn().Err(err).Msg("login: loadClient failed")
		if status, handled := classifyUserFacingError(err); handled {
			return LoginResult{Status: status, Channel: p.Channel}, nil
		}
		return nil, internalError(err)
	}

	accountID := strconv.FormatInt(userInfo.GetFBID(), 10)
	if accountID == "0" {
		return LoginResult{Status: "token_invalidated", Channel: p.Channel}, nil
	}

	sess := &session{
		platform:           platform,
		channel:            p.Channel,
		accountID:          accountID,
		username:           userInfo.GetUsername(),
		client:             client,
		cookies:            jar,
		lastCookieSnapshot: cookieMapOut(jar),
		initialTable:       initialTable,
		knownContacts: make(map[int64]struct{}),
	}
	b.install(sess)

	return LoginResult{
		Status:      "success",
		Channel:     p.Channel,
		AccountID:   accountID,
		Username:    userInfo.GetUsername(),
		DisplayName: userInfo.GetName(),
		AvatarURL:   userInfo.GetAvatarURL(),
		Cookies:     cookieMapOut(jar),
	}, nil
}

// Resume rebuilds the messagix client from the cookie jar persisted in
// Keychain. Same shape as Login but we skip emitting identity info back
// (Rust already has it from the original login).
func (b *Bridge) Resume(ctx context.Context, p resumeParams) (any, *rpcErr) {
	platform := platformFromChannel(p.Channel)
	if platform == types.Unset {
		return nil, invalidParams(errors.New("channel must be 'instagram' or 'messenger'"))
	}
	if p.AccountID == "" {
		return nil, invalidParams(errors.New("account_id required"))
	}
	if len(p.Cookies) == 0 {
		return nil, invalidParams(errors.New("cookies required"))
	}

	jar, err := buildCookieJar(platform, p.Cookies)
	if err != nil {
		return nil, invalidParams(err)
	}

	client, userInfo, initialTable, err := b.loadClient(ctx, platform, jar)
	if err != nil {
		if status, handled := classifyUserFacingError(err); handled {
			return LoginResult{Status: status, Channel: p.Channel}, nil
		}
		return nil, internalError(err)
	}

	gotAccountID := strconv.FormatInt(userInfo.GetFBID(), 10)
	if gotAccountID != p.AccountID {
		return LoginResult{Status: "token_invalidated", Channel: p.Channel}, nil
	}

	sess := &session{
		platform:           platform,
		channel:            p.Channel,
		accountID:          p.AccountID,
		username:           userInfo.GetUsername(),
		client:             client,
		cookies:            jar,
		lastCookieSnapshot: cookieMapOut(jar),
		initialTable:       initialTable,
		knownContacts: make(map[int64]struct{}),
	}
	b.install(sess)

	return map[string]any{"status": "resumed"}, nil
}

// loadClient constructs a messagix.Client and walks the login validation
// path (LoadMessagesPage). Both Login and Resume use this — the only
// difference is how the caller reacts to the classified error.
func (b *Bridge) loadClient(
	ctx context.Context,
	platform types.Platform,
	jar *cookies.Cookies,
) (*messagix.Client, types.UserInfo, *table.LSTable, error) {
	client := messagix.NewClient(jar, b.logger, &messagix.Config{
		MayConnectToDGW: platform == types.Instagram,
	})

	userInfo, initialTable, err := client.LoadMessagesPage(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	return client, userInfo, initialTable, nil
}

// ─── Session management ───────────────────────────────────────────────────

func (b *Bridge) install(s *session) {
	b.mu.Lock()
	old := b.session
	b.session = s
	b.mu.Unlock()
	if old != nil && old.client != nil && old.client != s.client {
		old.client.Disconnect()
	}
}

// ─── Event pump ───────────────────────────────────────────────────────────

func (b *Bridge) BeginEvents(ctx context.Context, p beginEventsParams) (any, *rpcErr) {
	b.mu.Lock()
	if b.session == nil || b.session.accountID != p.AccountID {
		b.mu.Unlock()
		return nil, internalError(errors.New("account not logged in"))
	}
	if b.eventRunning.Load() {
		b.mu.Unlock()
		return map[string]any{"status": "already_running"}, nil
	}
	sess := b.session
	stopCh := make(chan struct{})
	b.eventStopCh = stopCh
	b.mu.Unlock()

	b.eventRunning.Store(true)

	b.logger.Info().
		Str("account_id", sess.accountID).
		Bool("has_initial_table", sess.initialTable != nil).
		Msg("BeginEvents: starting")

	b.notify("event", map[string]any{
		"type":       "account_status",
		"account_id": sess.accountID,
		"channel":    sess.channel,
		"payload":    map[string]any{"status": "connected"},
	})

	if sess.initialTable != nil {
		b.processLSTable(sess, sess.initialTable)
		sess.initialTable = nil
	}

	// Thread backfill is kicked off from the Event_Ready handler, where we
	// know the MQTT socket is connected. Starting it here would race
	// Connect() and return "not connected" from messagix.

	go b.runEventLoop(sess, stopCh)
	return map[string]any{"status": "started"}, nil
}

// runFullInboxSync paginates every Meta inbox slice we know about. Primary
// DMs live in SyncGroup 1; secondary surfaces (message requests, filtered
// threads, etc.) use SyncGroup 95 — same KeyStore machinery as
// mautrix-meta's SyncManager. Both paths must run or the phone shows
// threads Convolios never receives.
func (b *Bridge) runFullInboxSync(sess *session, stopCh <-chan struct{}) {
	b.runThreadBackfillForGroup(sess, stopCh, 1)

	// SyncGroup 95 is the secondary Messenger inbox (requests, filtered, …).
	// Instagram does not use this slice — skip the wait entirely.
	if !sess.platform.IsMessenger() {
		return
	}

	// KeyStore for 95 is populated asynchronously via MQTT after Connect.
	// Poll until Meta sets HasMoreBefore or we time out (no secondary pages).
	if b.waitSyncGroupReady(sess, stopCh, 95, 18, 200*time.Millisecond) {
		b.runThreadBackfillForGroup(sess, stopCh, 95)
	}
}

// waitSyncGroupReady blocks until keyStore[sg].HasMoreBefore becomes true,
// stopCh fires, or maxAttempts intervals elapse.
func (b *Bridge) waitSyncGroupReady(sess *session, stopCh <-chan struct{}, syncGroup int64, maxAttempts int, interval time.Duration) bool {
	for attempt := 0; attempt < maxAttempts; attempt++ {
		select {
		case <-stopCh:
			return false
		default:
		}
		ks := sess.client.GetSyncGroupKeyStore(syncGroup)
		if ks != nil && ks.HasMoreBefore {
			b.logger.Info().
				Str("account_id", sess.accountID).
				Int64("sync_group", syncGroup).
				Int("attempt", attempt+1).
				Msg("sync group ready for thread backfill")
			return true
		}
		select {
		case <-stopCh:
			return false
		case <-time.After(interval):
		}
	}
	b.logger.Debug().
		Str("account_id", sess.accountID).
		Int64("sync_group", syncGroup).
		Msg("sync group never advertised more pages — skipping backfill for this group")
	return false
}

// runThreadBackfillForGroup paginates one sync group's thread list until
// Meta reports no further pages. Each LSTable is fed through processLSTable.
//
// Bail-out mirrors mautrix-meta: HasMoreBefore=false, an empty table, or
// a MinThreadKey that did not change since the previous batch. Batch cap
// is a safety net for pathological accounts.
func (b *Bridge) runThreadBackfillForGroup(sess *session, stopCh <-chan struct{}, syncGroup int64) {
	const (
		maxBatches = 100
		batchDelay = 250 * time.Millisecond
	)

	ctx := context.Background()
	var prevMinThreadKey int64

	for batch := 0; batch < maxBatches; batch++ {
		select {
		case <-stopCh:
			return
		default:
		}

		keyStore, tbl, err := sess.client.FetchMoreThreads(ctx, syncGroup)
		if err != nil {
			b.logger.Warn().Err(err).
				Str("account_id", sess.accountID).
				Int64("sync_group", syncGroup).
				Int("batch", batch).
				Msg("thread backfill: FetchMoreThreads failed")
			return
		}
		if tbl == nil {
			b.logger.Info().
				Str("account_id", sess.accountID).
				Int64("sync_group", syncGroup).
				Int("batches_processed", batch).
				Msg("thread backfill complete (no more threads)")
			return
		}

		b.processLSTable(sess, tbl)

		if keyStore == nil || !keyStore.HasMoreBefore {
			b.logger.Info().
				Str("account_id", sess.accountID).
				Int64("sync_group", syncGroup).
				Int("batches_processed", batch+1).
				Msg("thread backfill complete (has_more_before=false)")
			return
		}
		if keyStore.MinThreadKey == prevMinThreadKey {
			b.logger.Info().
				Str("account_id", sess.accountID).
				Int64("sync_group", syncGroup).
				Int("batches_processed", batch+1).
				Msg("thread backfill complete (cursor did not advance)")
			return
		}
		prevMinThreadKey = keyStore.MinThreadKey

		select {
		case <-stopCh:
			return
		case <-time.After(batchDelay):
		}
	}

	b.logger.Info().
		Str("account_id", sess.accountID).
		Int64("sync_group", syncGroup).
		Int("batches_processed", maxBatches).
		Msg("thread backfill: hit batch cap")
}

func (b *Bridge) runEventLoop(sess *session, stopCh <-chan struct{}) {
	defer b.eventRunning.Store(false)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sess.client.SetEventHandler(func(evtCtx context.Context, rawEvt any) {
		if evtCtx.Err() != nil {
			return
		}
		b.handleMessagixEvent(sess, rawEvt)
	})

	if err := sess.client.Connect(ctx); err != nil {
		b.logger.Err(err).Str("account_id", sess.accountID).Msg("Connect failed")
		b.notify("event", map[string]any{
			"type":       "account_status",
			"account_id": sess.accountID,
			"channel":    sess.channel,
			"payload":    map[string]any{"status": "error", "error": err.Error()},
		})
		return
	}

	b.logger.Info().Str("account_id", sess.accountID).Msg("event loop running")

	<-stopCh
	sess.client.Disconnect()
	b.logger.Info().Str("account_id", sess.accountID).Msg("event loop stopped")
}

func (b *Bridge) handleMessagixEvent(sess *session, rawEvt any) {
	switch evt := rawEvt.(type) {
	case *messagix.Event_PublishResponse:
		if evt.Table == nil {
			return
		}
		b.processLSTable(sess, evt.Table)

	case *messagix.Event_Ready:
		b.logger.Info().Str("account_id", sess.accountID).Msg("MQTT ready")
		// Paginate every inbox sync group (1 + 95). Each reconnect gets a
		// fresh pass so threads that landed while offline are not skipped.
		if sess.backfillRunning.CompareAndSwap(false, true) {
			stopCh := b.currentStopCh()
			go func() {
				defer sess.backfillRunning.Store(false)
				b.runFullInboxSync(sess, stopCh)
			}()
		}

	case *messagix.Event_Reconnected:
		b.logger.Info().Str("account_id", sess.accountID).Msg("MQTT reconnected")
		b.notify("event", map[string]any{
			"type":       "account_status",
			"account_id": sess.accountID,
			"channel":    sess.channel,
			"payload":    map[string]any{"status": "connected"},
		})

	case *messagix.Event_SocketError:
		b.logger.Warn().Err(evt.Err).Int("attempts", evt.ConnectionAttempts).
			Str("account_id", sess.accountID).Msg("socket error (will reconnect)")

	case *messagix.Event_PermanentError:
		b.logger.Error().Err(evt.Err).Str("account_id", sess.accountID).Msg("permanent error")
		b.notify("event", map[string]any{
			"type":       "account_status",
			"account_id": sess.accountID,
			"channel":    sess.channel,
			"payload":    map[string]any{"status": "error", "error": evt.Err.Error()},
		})

	default:
		// DGW events etc — log but don't emit for now
		b.logger.Debug().Str("account_id", sess.accountID).
			Str("type", fmt.Sprintf("%T", rawEvt)).Msg("unhandled event type")
	}
}

// currentStopCh returns the active session's stop channel under the bridge
// lock. Consumed by goroutines that need to abort when the session is
// torn down (shutdown, reinstall, disconnect).
func (b *Bridge) currentStopCh() <-chan struct{} {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.eventStopCh
}

func (b *Bridge) maybeSendCookieUpdate(sess *session) {
	current := cookieMapOut(sess.cookies)
	if maps.Equal(current, sess.lastCookieSnapshot) {
		return
	}
	sess.lastCookieSnapshot = current
	b.notify("event", map[string]any{
		"type":       "cookies_updated",
		"account_id": sess.accountID,
		"channel":    sess.channel,
		"payload":    map[string]any{"cookies": current},
	})
}

func (b *Bridge) processLSTable(sess *session, tbl *table.LSTable) {
	selfID := sess.cookies.GetUserID()

	b.maybeSendCookieUpdate(sess)
	b.recordKnownContacts(sess, tbl)

	upsertGroups, insertMsgs := tbl.WrapMessages()

	totalMsgs := len(insertMsgs)
	for _, g := range upsertGroups {
		totalMsgs += len(g.Messages)
	}

	b.logger.Info().
		Int("upsert_groups", len(upsertGroups)).
		Int("upsert_msgs", totalMsgs-len(insertMsgs)).
		Int("insert_msgs", len(insertMsgs)).
		Int("total_msgs", totalMsgs).
		Int("threads", len(tbl.LSDeleteThenInsertThread)).
		Int("contacts", len(tbl.LSDeleteThenInsertContact)).
		Int64("self_id", selfID).
		Msg("processLSTable")

	emitted := 0
	for _, upsertGroup := range upsertGroups {
		for _, msg := range upsertGroup.Messages {
			b.emitMessage(sess, msg, selfID, tbl)
			emitted++
			if emitted%5 == 0 {
				time.Sleep(200 * time.Millisecond)
			}
		}
	}
	for _, msg := range insertMsgs {
		b.emitMessage(sess, msg, selfID, tbl)
		emitted++
		if emitted%5 == 0 {
			time.Sleep(200 * time.Millisecond)
		}
	}

	for _, typing := range tbl.LSUpdateTypingIndicator {
		b.notify("event", map[string]any{
			"type":       "typing",
			"account_id": sess.accountID,
			"channel":    sess.channel,
			"payload": map[string]any{
				"thread_id": strconv.FormatInt(typing.ThreadKey, 10),
				"sender_id": strconv.FormatInt(typing.SenderId, 10),
				"is_typing": typing.IsTyping,
			},
		})
	}
}

func (b *Bridge) emitMessage(sess *session, msg *table.WrappedMessage, selfID int64, tbl *table.LSTable) {
	if msg.LSInsertMessage == nil {
		return
	}

	direction := "inbound"
	if msg.SenderId == selfID {
		direction = "outbound"
	}

	threadID := strconv.FormatInt(msg.ThreadKey, 10)

	isGroup := false
	for _, thread := range tbl.LSDeleteThenInsertThread {
		if thread.ThreadKey == msg.ThreadKey {
			isGroup = !thread.ThreadType.IsOneToOne()
			break
		}
	}

	otherParty := resolveOtherParty(msg.SenderId, selfID, msg.ThreadKey, isGroup, tbl)

	// Known = person appears in the user's Meta contact list. 1:1 DMs with a
	// known contact bypass the Gate (they're already someone the user talks
	// with). Group threads stay neutral — group-level approval is a
	// separate UX decision.
	isKnownContact := false
	if !isGroup {
		if id, ok := otherParty["handle"].(string); ok {
			if n, err := strconv.ParseInt(id, 10, 64); err == nil {
				isKnownContact = b.isKnownContact(sess, n)
			}
		}
	}

	payload := map[string]any{
		"external_id":      msg.MessageId,
		"thread_id":        threadID,
		"direction":        direction,
		"body_text":        msg.Text,
		"sent_at":          time.UnixMilli(msg.TimestampMs).UTC().Format(time.RFC3339),
		"is_group":         isGroup,
		"other_party":      otherParty,
		"provider_id":      msg.MessageId,
		"is_known_contact": isKnownContact,
	}

	if msg.ReplySourceId != "" && msg.ReplyMessageText != "" {
		payload["quoted"] = map[string]any{
			"text": msg.ReplyMessageText,
		}
	}

	b.notify("event", map[string]any{
		"type":       "message_received",
		"account_id": sess.accountID,
		"channel":    sess.channel,
		"payload":    payload,
	})
}

// recordKnownContacts merges every contact ID Meta tells us about into the
// session's known-contact set. LSDeleteThenInsertContact is the user's Meta
// contact / friends list (our gold signal). LSVerifyContactRowExists
// contains contacts referenced by threads — still a strong signal since
// it only shows up for people the user already has a thread with.
func (b *Bridge) recordKnownContacts(sess *session, tbl *table.LSTable) {
	if len(tbl.LSDeleteThenInsertContact) == 0 && len(tbl.LSVerifyContactRowExists) == 0 {
		return
	}
	sess.knownContactsMu.Lock()
	defer sess.knownContactsMu.Unlock()
	for _, c := range tbl.LSDeleteThenInsertContact {
		if c.Id != 0 {
			sess.knownContacts[c.Id] = struct{}{}
		}
	}
	for _, c := range tbl.LSVerifyContactRowExists {
		if c.ContactId != 0 {
			sess.knownContacts[c.ContactId] = struct{}{}
		}
	}
}

func (b *Bridge) isKnownContact(sess *session, id int64) bool {
	sess.knownContactsMu.Lock()
	defer sess.knownContactsMu.Unlock()
	_, ok := sess.knownContacts[id]
	return ok
}

func resolveOtherParty(senderID, selfID, threadKey int64, isGroup bool, tbl *table.LSTable) map[string]any {
	if !isGroup && senderID == selfID {
		return map[string]any{
			"handle": strconv.FormatInt(threadKey, 10),
			"name":   contactName(threadKey, tbl),
		}
	}

	if senderID != selfID {
		return map[string]any{
			"handle": strconv.FormatInt(senderID, 10),
			"name":   contactName(senderID, tbl),
		}
	}

	return map[string]any{
		"handle": strconv.FormatInt(threadKey, 10),
		"name":   contactName(threadKey, tbl),
	}
}

func contactName(id int64, tbl *table.LSTable) string {
	for _, c := range tbl.LSDeleteThenInsertContact {
		if c.Id == id {
			return c.Name
		}
	}
	for _, c := range tbl.LSVerifyContactRowExists {
		if c.ContactId == id {
			return c.Name
		}
	}
	for _, t := range tbl.LSDeleteThenInsertThread {
		if t.ThreadKey == id && t.ThreadName != "" {
			return t.ThreadName
		}
	}
	return ""
}

// ─── Outbound messages ────────────────────────────────────────────────────

func (b *Bridge) SendMessage(ctx context.Context, p sendParams) (any, *rpcErr) {
	b.mu.Lock()
	sess := b.session
	b.mu.Unlock()
	if sess == nil || sess.accountID != p.AccountID {
		return nil, internalError(errors.New("account not logged in"))
	}
	if p.ThreadID == "" || p.Text == "" {
		return nil, invalidParams(errors.New("thread_id and text required"))
	}

	// TODO(t8): ExecuteTasks with messagix/socket.SendMessageTask
	return nil, internalError(fmt.Errorf("send_message for %s not yet implemented (step t8)", sess.channel))
}

// ─── Shutdown ─────────────────────────────────────────────────────────────

func (b *Bridge) Shutdown() {
	b.mu.Lock()
	stopCh := b.eventStopCh
	b.eventStopCh = nil
	sess := b.session
	b.session = nil
	b.mu.Unlock()

	if stopCh != nil {
		close(stopCh)
	}
	// If the event loop was never started (no stopCh), disconnect directly.
	if stopCh == nil && sess != nil && sess.client != nil {
		sess.client.Disconnect()
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────

func platformFromChannel(channel string) types.Platform {
	switch channel {
	case "instagram":
		return types.Instagram
	case "messenger":
		return types.Messenger
	default:
		return types.Unset
	}
}

// buildCookieJar constructs the messagix-shaped cookie jar and validates
// that every required cookie for the platform is present. Callers pass
// the raw `{name: value}` map coming off the parent's login webview.
func buildCookieJar(platform types.Platform, raw map[string]string) (*cookies.Cookies, error) {
	jar := &cookies.Cookies{Platform: platform}
	typed := make(map[cookies.MetaCookieName]string, len(raw))
	for k, v := range raw {
		typed[cookies.MetaCookieName(k)] = v
	}
	jar.UpdateValues(typed)

	if missing := jar.GetMissingCookieNames(); len(missing) > 0 {
		names := make([]string, 0, len(missing))
		for _, n := range missing {
			names = append(names, string(n))
		}
		return nil, fmt.Errorf("missing required cookies: %v", names)
	}
	return jar, nil
}

// cookieMapOut reflects messagix's current cookie state back to the Rust
// parent. messagix may have rotated xs / sessionid during LoadMessagesPage,
// so this is the canonical jar to persist — NOT the one the webview lifted.
func cookieMapOut(jar *cookies.Cookies) map[string]string {
	all := jar.GetAll()
	out := make(map[string]string, len(all))
	for k, v := range all {
		out[string(k)] = v
	}
	return out
}

// classifyUserFacingError decides whether an error from LoadMessagesPage
// represents a situation the user can recover from (by reopening the
// login webview and resolving it on Meta's site) versus an actual bug
// the parent should report as an RPC error.
func classifyUserFacingError(err error) (string, bool) {
	switch {
	case errors.Is(err, messagix.ErrChallengeRequired):
		return "challenge_required", true
	case errors.Is(err, messagix.ErrConsentRequired):
		return "consent_required", true
	case errors.Is(err, messagix.ErrCheckpointRequired):
		return "checkpoint_required", true
	case errors.Is(err, messagix.ErrTokenInvalidated):
		return "token_invalidated", true
	case errors.Is(err, messagix.ErrAccountSuspended):
		return "token_invalidated", true
	}

	msg := err.Error()
	for _, needle := range []string{
		"password",
		"credentials",
		"login",
		"bad username",
		"unauthorized",
		"USER_ID",
	} {
		if containsFold(msg, needle) {
			return "token_invalidated", true
		}
	}

	return "", false
}

func containsFold(s, substr string) bool {
	ls, lsub := len(s), len(substr)
	for i := 0; i <= ls-lsub; i++ {
		match := true
		for j := 0; j < lsub; j++ {
			a, b := s[i+j], substr[j]
			if a >= 'A' && a <= 'Z' {
				a += 'a' - 'A'
			}
			if b >= 'A' && b <= 'Z' {
				b += 'a' - 'A'
			}
			if a != b {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
