package listentogether

import (
	"context"
	"encoding/json"
	"path"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/navidrome/navidrome/conf"
	"github.com/navidrome/navidrome/consts"
	"github.com/navidrome/navidrome/core/auth"
	"github.com/navidrome/navidrome/log"
	"github.com/navidrome/navidrome/model"
)

const (
	gracePeriod     = 30 * time.Second
	writeWait       = 10 * time.Second
	pongWait        = 60 * time.Second
	pingPeriod      = (pongWait * 9) / 10
	maxMessageSize  = 4096
	sendChannelSize = 16
)

// WSMessage is the message format exchanged over WebSocket.
type WSMessage struct {
	Type    string          `json:"type"`              // "command", "state", "participants", "remote", "remote_requested", "error", "welcome"
	Action  string          `json:"action,omitempty"`  // e.g. "play", "pause", "seek", "skip_next", etc.
	Payload json.RawMessage `json:"payload,omitempty"` // Action-specific data
}

// TrackInfo holds metadata + streaming token for a track in the session.
type TrackInfo struct {
	ID          string  `json:"id"`
	Token       string  `json:"token"` // JWT streaming token
	Title       string  `json:"title"`
	Artist      string  `json:"artist"`
	Album       string  `json:"album"`
	Duration    float32 `json:"duration"`
	MediaFileID string  `json:"mediaFileId"`        // Original media file ID for search/add
	CoverArt    string  `json:"coverArt,omitempty"` // Public, token-signed cover art URL
}

// Participant represents a connected WebSocket client.
type Participant struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	IsHost   bool   `json:"isHost"`
	JoinedAt time.Time
	conn     *websocket.Conn
	sendCh   chan []byte
	session  *LiveSession
}

// StatePayload is broadcast to all participants after state changes.
type StatePayload struct {
	Action            string      `json:"action,omitempty"` // What triggered this state update (e.g. "play", "seek", "queue_add", "tick", "auto_advance")
	CurrentTrackIndex int         `json:"currentTrackIndex"`
	Position          float64     `json:"position"`   // Authoritative position (seconds) at ServerTime
	ServerTime        int64       `json:"serverTime"` // Server wall-clock (unix millis) when this state was computed
	IsPlaying         bool        `json:"isPlaying"`
	Queue             []TrackInfo `json:"queue"`
}

// ParticipantsPayload is broadcast when participants change.
type ParticipantsPayload struct {
	Participants []ParticipantInfo `json:"participants"`
}

// ParticipantInfo is the public info about a participant.
type ParticipantInfo struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	IsHost bool   `json:"isHost"`
}

// RemotePayload is broadcast when the remote changes hands.
type RemotePayload struct {
	HolderID   string `json:"holderId"`
	HolderName string `json:"holderName"`
}

// LiveSession holds the runtime state of an active listening session.
type LiveSession struct {
	mu           sync.RWMutex
	sessionID    string
	hostUserID   string // The authenticated user who created it
	format       string
	maxBitRate   int
	tracks       []TrackInfo
	queue        []int // Indices into tracks (playback order)
	currentIndex int   // Current position in queue
	// Playback position is modeled as a base + a server timestamp so the
	// server can compute the authoritative "live" position at any instant
	// (positionBase + elapsed-since-lastUpdate while playing). This is what
	// makes drift correction and accurate late-joiner sync possible.
	positionBase float64   // Playback position (seconds) at lastUpdate
	lastUpdate   time.Time // Server time when positionBase/isPlaying last changed
	isPlaying    bool
	remoteHolder string // Participant ID who has the remote
	participants map[string]*Participant
	graceTimer   *time.Timer
	advanceTimer *time.Timer // Fires when the current track is expected to end
	hub          *Hub
}

// Hub manages all active listening sessions.
type Hub struct {
	mu       sync.RWMutex
	sessions map[string]*LiveSession
	ds       model.DataStore
}

// NewHub creates a new Hub.
func NewHub(ds model.DataStore) *Hub {
	return &Hub{
		sessions: make(map[string]*LiveSession),
		ds:       ds,
	}
}

// CreateSession creates a new live session from a persisted ListenSession.
func (h *Hub) CreateSession(session *model.ListenSession) *LiveSession {
	h.mu.Lock()
	defer h.mu.Unlock()

	// If session already exists, return it
	if ls, ok := h.sessions[session.ID]; ok {
		return ls
	}

	tracks := make([]TrackInfo, len(session.Tracks))
	queue := make([]int, len(session.Tracks))
	for i, mf := range session.Tracks {
		token := generateStreamToken(mf.ID, session.Format, session.MaxBitRate)
		tracks[i] = TrackInfo{
			ID:          mf.ID,
			Token:       token,
			Title:       mf.Title,
			Artist:      mf.Artist,
			Album:       mf.Album,
			Duration:    mf.Duration,
			MediaFileID: mf.ID,
			CoverArt:    coverArtURL(mf),
		}
		queue[i] = i
	}

	ls := &LiveSession{
		sessionID:    session.ID,
		hostUserID:   session.UserID,
		format:       session.Format,
		maxBitRate:   session.MaxBitRate,
		tracks:       tracks,
		queue:        queue,
		currentIndex: 0,
		positionBase: 0,
		lastUpdate:   time.Now(),
		isPlaying:    false,
		remoteHolder: "", // Will be set when host joins
		participants: make(map[string]*Participant),
		hub:          h,
	}

	h.sessions[session.ID] = ls
	return ls
}

// GetSession returns a live session by ID.
func (h *Hub) GetSession(sessionID string) *LiveSession {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.sessions[sessionID]
}

// RemoveSession removes a live session.
func (h *Hub) removeSession(sessionID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.sessions, sessionID)
}

// GetDataStore returns the data store for search queries.
func (h *Hub) GetDataStore() model.DataStore {
	return h.ds
}

// Join adds a participant to the session. clientID is a stable, client-provided
// identifier (persisted in the browser) so that a reconnecting client keeps its
// identity — and crucially its remote-holder status — across brief drops. If it
// is empty, a random ID is assigned (legacy behavior).
func (ls *LiveSession) Join(conn *websocket.Conn, name string, isHost bool, clientID string) *Participant {
	ls.mu.Lock()
	defer ls.mu.Unlock()

	// Cancel grace timer if running
	if ls.graceTimer != nil {
		ls.graceTimer.Stop()
		ls.graceTimer = nil
	}

	id := clientID
	if id == "" {
		id = uuid.New().String()
	}

	joinedAt := time.Now()
	// Reconnect: a participant with this stable ID already exists. Take over its
	// slot (preserving JoinedAt so remote-transfer ordering is stable) and tear
	// down the stale connection. The stale ReadPump's Leave is pointer-guarded,
	// so it will not evict this new participant.
	if existing, ok := ls.participants[id]; ok {
		joinedAt = existing.JoinedAt
		close(existing.sendCh)
		_ = existing.conn.Close()
	}

	p := &Participant{
		ID:       id,
		Name:     name,
		IsHost:   isHost,
		JoinedAt: joinedAt,
		conn:     conn,
		sendCh:   make(chan []byte, sendChannelSize),
		session:  ls,
	}

	ls.participants[p.ID] = p

	// If no remote holder, assign to this participant (host gets priority)
	if ls.remoteHolder == "" || isHost {
		ls.remoteHolder = p.ID
	}

	return p
}

// Leave removes a participant and handles remote transfer / grace period. It is
// pointer-guarded: if the participant currently stored under p.ID is not p (e.g.
// because the client already reconnected and took over the slot), this is a
// no-op, so a stale connection's teardown cannot evict the live one.
func (ls *LiveSession) Leave(p *Participant) {
	ls.mu.Lock()

	if current, ok := ls.participants[p.ID]; !ok || current != p {
		ls.mu.Unlock()
		return
	}

	close(p.sendCh)
	delete(ls.participants, p.ID)

	// If the departing participant held the remote, transfer it
	if ls.remoteHolder == p.ID {
		ls.remoteHolder = ls.findLongestConnected()
	}

	remaining := len(ls.participants)
	newRemoteHolder := ls.remoteHolder

	ls.mu.Unlock()

	if remaining == 0 {
		// Start grace period
		ls.mu.Lock()
		ls.graceTimer = time.AfterFunc(gracePeriod, func() {
			ls.mu.Lock()
			count := len(ls.participants)
			ls.mu.Unlock()
			if count == 0 {
				log.Info("Listen Together session expired (grace period)", "sessionId", ls.sessionID)
				ls.hub.removeSession(ls.sessionID)
			}
		})
		ls.mu.Unlock()
	} else {
		// Broadcast updated participants and remote
		ls.broadcastParticipants()
		if newRemoteHolder != "" {
			ls.broadcastRemote()
		}
	}
}

// findLongestConnected returns the ID of the longest-connected participant (must hold mu).
func (ls *LiveSession) findLongestConnected() string {
	var oldest *Participant
	for _, p := range ls.participants {
		if oldest == nil || p.JoinedAt.Before(oldest.JoinedAt) {
			oldest = p
		}
	}
	if oldest != nil {
		return oldest.ID
	}
	return ""
}

// effectivePositionLocked returns the authoritative playback position right now,
// advancing positionBase by the wall-clock elapsed since lastUpdate while playing.
// Caller must hold ls.mu (read or write).
func (ls *LiveSession) effectivePositionLocked() float64 {
	if !ls.isPlaying {
		return ls.positionBase
	}
	pos := ls.positionBase + time.Since(ls.lastUpdate).Seconds()
	if dur := ls.currentDurationLocked(); dur > 0 && pos > dur {
		pos = dur
	}
	return pos
}

// currentDurationLocked returns the duration (seconds) of the current track, or 0
// if unknown. Caller must hold ls.mu.
func (ls *LiveSession) currentDurationLocked() float64 {
	if ls.currentIndex >= 0 && ls.currentIndex < len(ls.queue) {
		idx := ls.queue[ls.currentIndex]
		if idx >= 0 && idx < len(ls.tracks) {
			return float64(ls.tracks[idx].Duration)
		}
	}
	return 0
}

// cancelAdvanceLocked stops any pending auto-advance timer. Caller must hold ls.mu.
func (ls *LiveSession) cancelAdvanceLocked() {
	if ls.advanceTimer != nil {
		ls.advanceTimer.Stop()
		ls.advanceTimer = nil
	}
}

// scheduleAdvanceLocked (re)arms the auto-advance timer to fire when the current
// track is expected to end. This is what makes the queue play through like a
// playlist without depending on any client. Caller must hold ls.mu.
func (ls *LiveSession) scheduleAdvanceLocked() {
	ls.cancelAdvanceLocked()
	if !ls.isPlaying {
		return
	}
	dur := ls.currentDurationLocked()
	if dur <= 0 {
		return // Unknown duration; rely on the holder's track_ended fallback
	}
	remaining := dur - ls.effectivePositionLocked()
	if remaining < 0 {
		remaining = 0
	}
	ls.advanceTimer = time.AfterFunc(time.Duration(remaining*float64(time.Second)), ls.onAdvanceTimer)
}

// onAdvanceTimer is invoked when a track is expected to have finished.
func (ls *LiveSession) onAdvanceTimer() {
	ls.mu.Lock()
	ls.advanceToNextLocked()
	ls.mu.Unlock()
	ls.broadcastState("auto_advance")
}

// advanceToNextLocked moves to the next queued track (or stops at the end of the
// queue) and re-arms the advance timer. Caller must hold ls.mu.
func (ls *LiveSession) advanceToNextLocked() {
	if ls.currentIndex < len(ls.queue)-1 {
		ls.currentIndex++
		ls.positionBase = 0
		ls.lastUpdate = time.Now()
		ls.isPlaying = true
		ls.scheduleAdvanceLocked()
		return
	}
	// End of queue: stop at the end of the last track.
	ls.isPlaying = false
	ls.positionBase = ls.currentDurationLocked()
	ls.lastUpdate = time.Now()
	ls.cancelAdvanceLocked()
}

// HandleMessage processes an incoming WebSocket message from a participant.
func (ls *LiveSession) HandleMessage(sender *Participant, msg WSMessage) {
	switch msg.Action {
	case "play":
		ls.handlePlay(sender)
	case "pause":
		ls.handlePause(sender)
	case "seek":
		ls.handleSeek(sender, msg.Payload)
	case "skip_next":
		ls.handleSkipNext(sender)
	case "skip_prev":
		ls.handleSkipPrev(sender)
	case "track_ended":
		ls.handleTrackEnded(sender)
	case "sync":
		ls.handleSync(sender, msg.Payload)
	case "pass_remote":
		ls.handlePassRemote(sender, msg.Payload)
	case "request_remote":
		ls.handleRequestRemote(sender)
	case "accept_remote_request":
		ls.handleAcceptRemoteRequest(sender, msg.Payload)
	case "queue_add":
		ls.handleQueueAdd(sender, msg.Payload)
	case "queue_remove":
		ls.handleQueueRemove(sender, msg.Payload)
	case "queue_reorder":
		ls.handleQueueReorder(sender, msg.Payload)
	case "end_session":
		ls.handleEndSession(sender)
	default:
		ls.sendError(sender, "unknown action: "+msg.Action)
	}
}

func (ls *LiveSession) isRemoteHolder(p *Participant) bool {
	ls.mu.RLock()
	defer ls.mu.RUnlock()
	return ls.remoteHolder == p.ID
}

func (ls *LiveSession) handlePlay(sender *Participant) {
	if !ls.isRemoteHolder(sender) {
		ls.sendError(sender, "only the remote holder can control playback")
		return
	}
	ls.mu.Lock()
	ls.positionBase = ls.effectivePositionLocked()
	ls.isPlaying = true
	ls.lastUpdate = time.Now()
	ls.scheduleAdvanceLocked()
	ls.mu.Unlock()
	ls.broadcastState("play")
}

func (ls *LiveSession) handlePause(sender *Participant) {
	if !ls.isRemoteHolder(sender) {
		ls.sendError(sender, "only the remote holder can control playback")
		return
	}
	ls.mu.Lock()
	ls.positionBase = ls.effectivePositionLocked()
	ls.isPlaying = false
	ls.lastUpdate = time.Now()
	ls.cancelAdvanceLocked()
	ls.mu.Unlock()
	ls.broadcastState("pause")
}

func (ls *LiveSession) handleSeek(sender *Participant, payload json.RawMessage) {
	if !ls.isRemoteHolder(sender) {
		ls.sendError(sender, "only the remote holder can control playback")
		return
	}
	var data struct {
		Position float64 `json:"position"`
	}
	if err := json.Unmarshal(payload, &data); err != nil {
		ls.sendError(sender, "invalid seek payload")
		return
	}
	ls.mu.Lock()
	ls.positionBase = data.Position
	ls.lastUpdate = time.Now()
	ls.scheduleAdvanceLocked()
	ls.mu.Unlock()
	ls.broadcastState("seek")
}

func (ls *LiveSession) handleSkipNext(sender *Participant) {
	if !ls.isRemoteHolder(sender) {
		ls.sendError(sender, "only the remote holder can control playback")
		return
	}
	ls.mu.Lock()
	if ls.currentIndex < len(ls.queue)-1 {
		ls.currentIndex++
		ls.positionBase = 0
		ls.lastUpdate = time.Now()
		ls.scheduleAdvanceLocked()
	}
	ls.mu.Unlock()
	ls.broadcastState("skip_next")
}

func (ls *LiveSession) handleSkipPrev(sender *Participant) {
	if !ls.isRemoteHolder(sender) {
		ls.sendError(sender, "only the remote holder can control playback")
		return
	}
	ls.mu.Lock()
	if ls.currentIndex > 0 {
		ls.currentIndex--
		ls.positionBase = 0
		ls.lastUpdate = time.Now()
		ls.scheduleAdvanceLocked()
	}
	ls.mu.Unlock()
	ls.broadcastState("skip_prev")
}

// handleTrackEnded is a fallback for auto-advance when the server's timer can't
// fire (e.g. missing/incorrect duration metadata). The remote holder reports
// that its audio element reached the end. We only advance if we genuinely appear
// to be at the end of the current track, which makes this idempotent with the
// server-side advance timer (after a timer-driven advance, position is reset to
// 0 and this becomes a no-op).
func (ls *LiveSession) handleTrackEnded(sender *Participant) {
	if !ls.isRemoteHolder(sender) {
		return
	}
	ls.mu.Lock()
	dur := ls.currentDurationLocked()
	atEnd := dur <= 0 || ls.effectivePositionLocked() >= dur-1.0
	if !atEnd {
		ls.mu.Unlock()
		return
	}
	ls.advanceToNextLocked()
	ls.mu.Unlock()
	ls.broadcastState("auto_advance")
}

func (ls *LiveSession) handleSync(sender *Participant, payload json.RawMessage) {
	if !ls.isRemoteHolder(sender) {
		return // Silently ignore sync from non-holders
	}
	var data struct {
		Position   float64 `json:"position"`
		TrackIndex int     `json:"trackIndex"`
	}
	if err := json.Unmarshal(payload, &data); err != nil {
		return
	}
	// The remote holder is the source of truth for the live position. Its
	// periodic sync refreshes the server's authoritative clock (positionBase +
	// lastUpdate) to track the holder's *actual* audio position, accounting for
	// the holder's own buffering. We then re-broadcast this as a "tick" to the
	// other participants so they can softly correct drift (small playbackRate
	// nudges) against the shared clock — without disturbing the holder.
	ls.mu.Lock()
	ls.positionBase = data.Position
	ls.lastUpdate = time.Now()
	if data.TrackIndex >= 0 && data.TrackIndex < len(ls.queue) {
		ls.currentIndex = data.TrackIndex
	}
	ls.scheduleAdvanceLocked()
	ls.mu.Unlock()
	ls.broadcastStateExcept("tick", sender.ID)
}

func (ls *LiveSession) handlePassRemote(sender *Participant, payload json.RawMessage) {
	if !ls.isRemoteHolder(sender) {
		ls.sendError(sender, "only the remote holder can pass the remote")
		return
	}
	var data struct {
		ParticipantID string `json:"participantId"`
	}
	if err := json.Unmarshal(payload, &data); err != nil {
		ls.sendError(sender, "invalid pass_remote payload")
		return
	}
	ls.mu.Lock()
	if _, ok := ls.participants[data.ParticipantID]; !ok {
		ls.mu.Unlock()
		ls.sendError(sender, "participant not found")
		return
	}
	ls.remoteHolder = data.ParticipantID
	ls.mu.Unlock()
	ls.broadcastRemote()
}

func (ls *LiveSession) handleRequestRemote(sender *Participant) {
	ls.mu.RLock()
	holderID := ls.remoteHolder
	holder, ok := ls.participants[holderID]
	ls.mu.RUnlock()

	if !ok {
		return
	}

	payload, _ := json.Marshal(struct {
		FromID   string `json:"fromId"`
		FromName string `json:"fromName"`
	}{
		FromID:   sender.ID,
		FromName: sender.Name,
	})

	msg, _ := json.Marshal(WSMessage{
		Type:    "remote_requested",
		Payload: payload,
	})

	select {
	case holder.sendCh <- msg:
	default:
	}
}

func (ls *LiveSession) handleAcceptRemoteRequest(sender *Participant, payload json.RawMessage) {
	if !ls.isRemoteHolder(sender) {
		ls.sendError(sender, "only the remote holder can accept requests")
		return
	}
	var data struct {
		ParticipantID string `json:"participantId"`
	}
	if err := json.Unmarshal(payload, &data); err != nil {
		ls.sendError(sender, "invalid accept payload")
		return
	}
	ls.mu.Lock()
	if _, ok := ls.participants[data.ParticipantID]; !ok {
		ls.mu.Unlock()
		ls.sendError(sender, "participant not found")
		return
	}
	ls.remoteHolder = data.ParticipantID
	ls.mu.Unlock()
	ls.broadcastRemote()
}

func (ls *LiveSession) handleQueueAdd(sender *Participant, payload json.RawMessage) {
	if !ls.isRemoteHolder(sender) {
		ls.sendError(sender, "only the remote holder can modify the queue")
		return
	}
	var data struct {
		MediaFileID string `json:"mediaFileId"`
	}
	if err := json.Unmarshal(payload, &data); err != nil {
		ls.sendError(sender, "invalid queue_add payload")
		return
	}

	// Look up the media file from the database
	ctx := context.Background()
	mf, err := ls.hub.ds.MediaFile(ctx).Get(data.MediaFileID)
	if err != nil {
		ls.sendError(sender, "track not found")
		return
	}

	token := generateStreamToken(mf.ID, ls.format, ls.maxBitRate)
	track := TrackInfo{
		ID:          mf.ID,
		Token:       token,
		Title:       mf.Title,
		Artist:      mf.Artist,
		Album:       mf.Album,
		Duration:    mf.Duration,
		MediaFileID: mf.ID,
		CoverArt:    coverArtURL(*mf),
	}

	ls.mu.Lock()
	newIdx := len(ls.tracks)
	ls.tracks = append(ls.tracks, track)
	ls.queue = append(ls.queue, newIdx)
	ls.mu.Unlock()

	ls.broadcastState("queue_add")
}

func (ls *LiveSession) handleQueueRemove(sender *Participant, payload json.RawMessage) {
	if !ls.isRemoteHolder(sender) {
		ls.sendError(sender, "only the remote holder can modify the queue")
		return
	}
	var data struct {
		QueuePosition int `json:"queuePosition"`
	}
	if err := json.Unmarshal(payload, &data); err != nil {
		ls.sendError(sender, "invalid queue_remove payload")
		return
	}

	ls.mu.Lock()
	if data.QueuePosition < 0 || data.QueuePosition >= len(ls.queue) {
		ls.mu.Unlock()
		ls.sendError(sender, "invalid queue position")
		return
	}
	// Don't allow removing the currently playing track
	if data.QueuePosition == ls.currentIndex {
		ls.mu.Unlock()
		ls.sendError(sender, "cannot remove the currently playing track")
		return
	}
	ls.queue = append(ls.queue[:data.QueuePosition], ls.queue[data.QueuePosition+1:]...)
	// Adjust currentIndex if needed
	if data.QueuePosition < ls.currentIndex {
		ls.currentIndex--
	}
	ls.mu.Unlock()

	ls.broadcastState("queue_remove")
}

func (ls *LiveSession) handleQueueReorder(sender *Participant, payload json.RawMessage) {
	if !ls.isRemoteHolder(sender) {
		ls.sendError(sender, "only the remote holder can modify the queue")
		return
	}
	var data struct {
		From int `json:"from"`
		To   int `json:"to"`
	}
	if err := json.Unmarshal(payload, &data); err != nil {
		ls.sendError(sender, "invalid queue_reorder payload")
		return
	}

	ls.mu.Lock()
	if data.From < 0 || data.From >= len(ls.queue) || data.To < 0 || data.To >= len(ls.queue) {
		ls.mu.Unlock()
		ls.sendError(sender, "invalid queue positions")
		return
	}

	// Move element
	item := ls.queue[data.From]
	ls.queue = append(ls.queue[:data.From], ls.queue[data.From+1:]...)

	// Insert at new position
	newQueue := make([]int, 0, len(ls.queue)+1)
	newQueue = append(newQueue, ls.queue[:data.To]...)
	newQueue = append(newQueue, item)
	newQueue = append(newQueue, ls.queue[data.To:]...)
	ls.queue = newQueue

	// Adjust currentIndex
	if data.From == ls.currentIndex {
		ls.currentIndex = data.To
	} else if data.From < ls.currentIndex && data.To >= ls.currentIndex {
		ls.currentIndex--
	} else if data.From > ls.currentIndex && data.To <= ls.currentIndex {
		ls.currentIndex++
	}
	ls.mu.Unlock()

	ls.broadcastState("queue_reorder")
}

func (ls *LiveSession) handleEndSession(sender *Participant) {
	if !ls.isRemoteHolder(sender) {
		ls.sendError(sender, "only the remote holder can end the session")
		return
	}

	ls.mu.Lock()
	ls.cancelAdvanceLocked()
	participants := make([]*Participant, 0, len(ls.participants))
	for _, p := range ls.participants {
		participants = append(participants, p)
	}
	ls.mu.Unlock()

	// Notify all participants
	endMsg, _ := json.Marshal(WSMessage{
		Type:   "error",
		Action: "session_ended",
	})
	for _, p := range participants {
		select {
		case p.sendCh <- endMsg:
		default:
		}
		p.conn.Close()
	}

	ls.hub.removeSession(ls.sessionID)
}

// broadcastState sends the current state to all participants.
// The action parameter indicates what triggered the broadcast (e.g. "play", "seek", "queue_add"),
// allowing clients to decide whether to apply the position or ignore it.
func (ls *LiveSession) broadcastState(action string) {
	ls.broadcastStateExcept(action, "")
}

// broadcastStateExcept sends the current state to all participants except the one
// with exceptID (pass "" to send to everyone). Used for "tick" updates that should
// not disturb the remote holder, which is the source of the position.
func (ls *LiveSession) broadcastStateExcept(action string, exceptID string) {
	ls.mu.RLock()
	queueTracks := make([]TrackInfo, len(ls.queue))
	for i, idx := range ls.queue {
		if idx < len(ls.tracks) {
			queueTracks[i] = ls.tracks[idx]
		}
	}
	state := StatePayload{
		Action:            action,
		CurrentTrackIndex: ls.currentIndex,
		Position:          ls.effectivePositionLocked(),
		ServerTime:        time.Now().UnixMilli(),
		IsPlaying:         ls.isPlaying,
		Queue:             queueTracks,
	}
	participants := make([]*Participant, 0, len(ls.participants))
	for _, p := range ls.participants {
		if exceptID != "" && p.ID == exceptID {
			continue
		}
		participants = append(participants, p)
	}
	ls.mu.RUnlock()

	payload, _ := json.Marshal(state)
	msg, _ := json.Marshal(WSMessage{
		Type:    "state",
		Payload: payload,
	})

	for _, p := range participants {
		select {
		case p.sendCh <- msg:
		default:
		}
	}
}

// broadcastParticipants sends the participant list to everyone.
func (ls *LiveSession) broadcastParticipants() {
	ls.mu.RLock()
	infos := make([]ParticipantInfo, 0, len(ls.participants))
	for _, p := range ls.participants {
		infos = append(infos, ParticipantInfo{
			ID:     p.ID,
			Name:   p.Name,
			IsHost: p.IsHost,
		})
	}
	participants := make([]*Participant, 0, len(ls.participants))
	for _, p := range ls.participants {
		participants = append(participants, p)
	}
	ls.mu.RUnlock()

	payload, _ := json.Marshal(ParticipantsPayload{Participants: infos})
	msg, _ := json.Marshal(WSMessage{
		Type:    "participants",
		Payload: payload,
	})

	for _, p := range participants {
		select {
		case p.sendCh <- msg:
		default:
		}
	}
}

// broadcastRemote sends the remote holder info to everyone.
func (ls *LiveSession) broadcastRemote() {
	ls.mu.RLock()
	holderID := ls.remoteHolder
	holderName := ""
	if holder, ok := ls.participants[holderID]; ok {
		holderName = holder.Name
	}
	participants := make([]*Participant, 0, len(ls.participants))
	for _, p := range ls.participants {
		participants = append(participants, p)
	}
	ls.mu.RUnlock()

	payload, _ := json.Marshal(RemotePayload{
		HolderID:   holderID,
		HolderName: holderName,
	})
	msg, _ := json.Marshal(WSMessage{
		Type:    "remote",
		Payload: payload,
	})

	for _, p := range participants {
		select {
		case p.sendCh <- msg:
		default:
		}
	}
}

// sendError sends an error message to a specific participant.
func (ls *LiveSession) sendError(p *Participant, errMsg string) {
	payload, _ := json.Marshal(struct {
		Message string `json:"message"`
	}{Message: errMsg})
	msg, _ := json.Marshal(WSMessage{
		Type:    "error",
		Payload: payload,
	})
	select {
	case p.sendCh <- msg:
	default:
	}
}

// SendWelcome sends the initial state to a newly joined participant.
func (ls *LiveSession) SendWelcome(p *Participant) {
	ls.mu.RLock()
	queueTracks := make([]TrackInfo, len(ls.queue))
	for i, idx := range ls.queue {
		if idx < len(ls.tracks) {
			queueTracks[i] = ls.tracks[idx]
		}
	}
	state := StatePayload{
		Action:            "welcome",
		CurrentTrackIndex: ls.currentIndex,
		Position:          ls.effectivePositionLocked(),
		ServerTime:        time.Now().UnixMilli(),
		IsPlaying:         ls.isPlaying,
		Queue:             queueTracks,
	}

	infos := make([]ParticipantInfo, 0, len(ls.participants))
	for _, pp := range ls.participants {
		infos = append(infos, ParticipantInfo{
			ID:     pp.ID,
			Name:   pp.Name,
			IsHost: pp.IsHost,
		})
	}

	holderID := ls.remoteHolder
	holderName := ""
	if holder, ok := ls.participants[holderID]; ok {
		holderName = holder.Name
	}
	ls.mu.RUnlock()

	// Send welcome with participant's own ID
	welcomePayload, _ := json.Marshal(struct {
		YourID string `json:"yourId"`
	}{YourID: p.ID})
	welcomeMsg, _ := json.Marshal(WSMessage{
		Type:    "welcome",
		Payload: welcomePayload,
	})
	select {
	case p.sendCh <- welcomeMsg:
	default:
	}

	// Send current state
	statePayload, _ := json.Marshal(state)
	stateMsg, _ := json.Marshal(WSMessage{
		Type:    "state",
		Payload: statePayload,
	})
	select {
	case p.sendCh <- stateMsg:
	default:
	}

	// Send participants list
	partPayload, _ := json.Marshal(ParticipantsPayload{Participants: infos})
	partMsg, _ := json.Marshal(WSMessage{
		Type:    "participants",
		Payload: partPayload,
	})
	select {
	case p.sendCh <- partMsg:
	default:
	}

	// Send remote holder info
	remotePayload, _ := json.Marshal(RemotePayload{
		HolderID:   holderID,
		HolderName: holderName,
	})
	remoteMsg, _ := json.Marshal(WSMessage{
		Type:    "remote",
		Payload: remotePayload,
	})
	select {
	case p.sendCh <- remoteMsg:
	default:
	}
}

// ReadPump reads messages from the WebSocket and dispatches them.
func (p *Participant) ReadPump() {
	defer func() {
		p.session.Leave(p)
		p.conn.Close()
	}()

	p.conn.SetReadLimit(maxMessageSize)
	_ = p.conn.SetReadDeadline(time.Now().Add(pongWait))
	p.conn.SetPongHandler(func(string) error {
		_ = p.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, message, err := p.conn.ReadMessage()
		if err != nil {
			break
		}

		var msg WSMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			continue
		}

		p.session.HandleMessage(p, msg)
	}
}

// WritePump writes messages from the send channel to the WebSocket.
func (p *Participant) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		p.conn.Close()
	}()

	for {
		select {
		case message, ok := <-p.sendCh:
			_ = p.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = p.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := p.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
		case <-ticker.C:
			_ = p.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := p.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// generateStreamToken creates a JWT token for streaming a track.
func generateStreamToken(mediaFileID string, format string, maxBitRate int) string {
	claims := auth.Claims{ID: mediaFileID, Format: format, BitRate: maxBitRate}
	// Token expires in 24 hours
	expiry := time.Now().Add(24 * time.Hour)
	token, _ := auth.CreateExpiringPublicToken(expiry, claims)
	return token
}

// coverArtURL builds a public, token-signed URL for a track's cover art, served
// by the existing public images endpoint (/share/img/{token}). Returns "" if a
// token can't be created.
func coverArtURL(mf model.MediaFile) string {
	token, err := auth.CreatePublicToken(auth.Claims{ID: mf.CoverArtID().String()})
	if err != nil {
		return ""
	}
	u := path.Join(consts.URLPathPublicImages, token)
	if size := conf.Server.UICoverArtSize; size > 0 {
		u += "?size=" + strconv.Itoa(size)
	}
	return u
}
