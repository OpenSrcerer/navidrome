package listentogether

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
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
	ID        string  `json:"id"`
	Token     string  `json:"token"`     // JWT streaming token
	Title     string  `json:"title"`
	Artist    string  `json:"artist"`
	Album     string  `json:"album"`
	Duration  float32 `json:"duration"`
	MediaFileID string `json:"mediaFileId"` // Original media file ID for search/add
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
	Action            string      `json:"action,omitempty"`     // What triggered this state update (e.g. "play", "seek", "queue_add")
	CurrentTrackIndex int         `json:"currentTrackIndex"`
	Position          float64     `json:"position"`
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
	queue        []int   // Indices into tracks (playback order)
	currentIndex int     // Current position in queue
	position     float64 // Playback position in seconds
	isPlaying    bool
	remoteHolder string // Participant ID who has the remote
	participants map[string]*Participant
	graceTimer   *time.Timer
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
		position:     0,
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

// Join adds a participant to the session.
func (ls *LiveSession) Join(conn *websocket.Conn, name string, isHost bool) *Participant {
	ls.mu.Lock()
	defer ls.mu.Unlock()

	// Cancel grace timer if running
	if ls.graceTimer != nil {
		ls.graceTimer.Stop()
		ls.graceTimer = nil
	}

	p := &Participant{
		ID:       uuid.New().String(),
		Name:     name,
		IsHost:   isHost,
		JoinedAt: time.Now(),
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

// Leave removes a participant and handles remote transfer / grace period.
func (ls *LiveSession) Leave(participantID string) {
	ls.mu.Lock()

	p, ok := ls.participants[participantID]
	if !ok {
		ls.mu.Unlock()
		return
	}

	close(p.sendCh)
	delete(ls.participants, participantID)

	// If the departing participant held the remote, transfer it
	if ls.remoteHolder == participantID {
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
	ls.isPlaying = true
	ls.mu.Unlock()
	ls.broadcastState("play")
}

func (ls *LiveSession) handlePause(sender *Participant) {
	if !ls.isRemoteHolder(sender) {
		ls.sendError(sender, "only the remote holder can control playback")
		return
	}
	ls.mu.Lock()
	ls.isPlaying = false
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
	ls.position = data.Position
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
		ls.position = 0
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
		ls.position = 0
	}
	ls.mu.Unlock()
	ls.broadcastState("skip_prev")
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
	// Only update internal state for new joiners — do NOT broadcast.
	// Broadcasting sync would cause periodic position jumps on all clients,
	// ruining smooth playback. Clients track their own position locally and
	// only seek when the remote holder performs an explicit action
	// (play, pause, seek, skip).
	ls.mu.Lock()
	ls.position = data.Position
	if data.TrackIndex >= 0 && data.TrackIndex < len(ls.queue) {
		ls.currentIndex = data.TrackIndex
	}
	ls.mu.Unlock()
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

	ls.mu.RLock()
	participants := make([]*Participant, 0, len(ls.participants))
	for _, p := range ls.participants {
		participants = append(participants, p)
	}
	ls.mu.RUnlock()

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
		Position:          ls.position,
		IsPlaying:         ls.isPlaying,
		Queue:             queueTracks,
	}
	participants := make([]*Participant, 0, len(ls.participants))
	for _, p := range ls.participants {
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
		Position:          ls.position,
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
		p.session.Leave(p.ID)
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
	claims := map[string]any{"id": mediaFileID}
	if format != "" {
		claims["f"] = format
	}
	if maxBitRate != 0 {
		claims["b"] = maxBitRate
	}
	// Token expires in 24 hours
	expiry := time.Now().Add(24 * time.Hour)
	token, _ := auth.CreateExpiringPublicToken(expiry, claims)
	return token
}
