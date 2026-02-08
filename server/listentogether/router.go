package listentogether

import (
	"encoding/json"
	"errors"
	"net/http"
	"path"
	"strconv"
	"strings"

	"github.com/Masterminds/squirrel"
	"github.com/deluan/rest"
	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"github.com/navidrome/navidrome/conf"
	"github.com/navidrome/navidrome/consts"
	"github.com/navidrome/navidrome/core"
	"github.com/navidrome/navidrome/core/auth"
	"github.com/navidrome/navidrome/core/stream"
	"github.com/navidrome/navidrome/log"
	"github.com/navidrome/navidrome/model"
	"github.com/navidrome/navidrome/model/request"
	"github.com/navidrome/navidrome/server"
	"github.com/navidrome/navidrome/ui"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for Listen Together
	},
}

// Router handles both authenticated API endpoints and public session routes.
type Router struct {
	http.Handler
	ds             model.DataStore
	listenTogether core.ListenTogether
	streamer       stream.MediaStreamer
	hub            *Hub
	assetsHandler  http.Handler
}

// New creates a new Listen Together router for authenticated API endpoints.
func New(ds model.DataStore, listenTogether core.ListenTogether, streamer stream.MediaStreamer) *Router {
	ltRoot := path.Join(conf.Server.BasePath, consts.URLPathListenTogether)
	r := &Router{
		ds:             ds,
		listenTogether: listenTogether,
		streamer:       streamer,
		hub:            NewHub(ds),
		assetsHandler:  http.StripPrefix(ltRoot, http.FileServer(http.FS(ui.BuildAssets()))),
	}
	r.Handler = r.routes()
	return r
}

// routes returns the authenticated API routes (mounted at /api/listenTogether).
func (rt *Router) routes() http.Handler {
	r := chi.NewRouter()

	r.Group(func(r chi.Router) {
		r.Use(server.Authenticator(rt.ds))
		r.Use(server.JWTRefresher)
		r.Post("/", rt.createSession)
		r.Get("/", rt.listSessions)
		r.Route("/{id}", func(r chi.Router) {
			r.Use(server.URLParamsMiddleware)
			r.Get("/", rt.getSession)
			r.Delete("/", rt.deleteSession)
		})
	})

	return r
}

// PublicRoutes returns the public routes to be mounted alongside share routes.
func (rt *Router) PublicRoutes() chi.Router {
	r := chi.NewRouter()
	r.Use(server.URLParamsMiddleware)
	r.HandleFunc("/s/{id}", rt.handleStream)
	r.Get("/{id}/ws", rt.handleWebSocket)
	r.Get("/{id}/search", rt.handleSearch)
	r.Get("/{id}", rt.handleSessionPage)
	r.Get("/", rt.handleSessionPage)
	r.Handle("/*", rt.assetsHandler)
	return r
}

// GetHub returns the hub for external access.
func (rt *Router) GetHub() *Hub {
	return rt.hub
}

// --- Authenticated endpoints ---

func (rt *Router) createSession(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	repo := rt.listenTogether.NewRepository(ctx)

	var input struct {
		ResourceIDs string `json:"resourceIds"`
		ResourceType string `json:"resourceType"`
		Description string `json:"description"`
		Format      string `json:"format"`
		MaxBitRate  int    `json:"maxBitRate"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	session := &model.ListenSession{
		ResourceIDs:  input.ResourceIDs,
		Description:  input.Description,
		Format:       input.Format,
		MaxBitRate:   input.MaxBitRate,
	}

	id, err := repo.(rest.Persistable).Save(session)
	if err != nil {
		log.Error(ctx, "Error creating listen session", err)
		http.Error(w, "error creating session", http.StatusInternalServerError)
		return
	}

	// Load the full session with tracks to create the live session
	fullSession, err := rt.listenTogether.Load(ctx, id)
	if err != nil {
		log.Error(ctx, "Error loading listen session", err)
		http.Error(w, "error loading session", http.StatusInternalServerError)
		return
	}

	// Create the live session in the hub
	rt.hub.CreateSession(fullSession)

	// Build the public URL
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	host := r.Host
	publicURL := scheme + "://" + host + "/share/lt/" + id

	resp := map[string]interface{}{
		"id":  id,
		"url": publicURL,
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func (rt *Router) listSessions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user, _ := request.UserFrom(ctx)

	repo := rt.ds.ListenSession(ctx)
	sessions, err := repo.GetAll(model.QueryOptions{
		Filters: squirrel.Eq{"user_id": user.ID},
	})
	if err != nil {
		log.Error(ctx, "Error listing listen sessions", err)
		http.Error(w, "error listing sessions", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(sessions)
}

func (rt *Router) getSession(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "id")

	session, err := rt.listenTogether.Load(ctx, id)
	if err != nil {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(session)
}

func (rt *Router) deleteSession(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	user, _ := request.UserFrom(ctx)

	session, err := rt.listenTogether.Load(ctx, id)
	if err != nil {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	if session.UserID != user.ID {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	repo := rt.listenTogether.NewRepository(ctx)
	if err := repo.(rest.Persistable).Delete(id); err != nil {
		log.Error(ctx, "Error deleting listen session", err)
		http.Error(w, "error deleting session", http.StatusInternalServerError)
		return
	}

	// Also remove the live session from the hub
	rt.hub.removeSession(id)

	w.WriteHeader(http.StatusNoContent)
}

// --- Public endpoints ---

func (rt *Router) handleSessionPage(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	// If the requested path is actually a UI asset, serve it directly
	// (e.g. manifest.webmanifest, favicon-32x32.png, etc.)
	if id != "" {
		_, err := ui.BuildAssets().Open(id)
		if err == nil {
			rt.assetsHandler.ServeHTTP(w, r)
			return
		}
	}

	session, err := rt.listenTogether.Load(r.Context(), id)
	if err != nil {
		log.Error(r.Context(), "Listen session not found", "id", id, err)
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	// Ensure a live session exists in the hub
	rt.hub.CreateSession(session)

	server.IndexWithListenTogether(rt.ds, ui.BuildAssets(), session)(w, r)
}

func (rt *Router) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	name := r.URL.Query().Get("name")
	if name == "" {
		name = "Guest"
	}
	isHost := r.URL.Query().Get("host") == "true"

	ls := rt.hub.GetSession(id)
	if ls == nil {
		// Try to load from DB and create live session
		session, err := rt.listenTogether.Load(r.Context(), id)
		if err != nil {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
		ls = rt.hub.CreateSession(session)
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Error(r.Context(), "WebSocket upgrade failed", err)
		return
	}

	participant := ls.Join(conn, name, isHost)

	// Send welcome + initial state
	ls.SendWelcome(participant)

	// Broadcast updated participants to everyone
	ls.broadcastParticipants()
	ls.broadcastRemote()

	// Start read/write pumps
	go participant.WritePump()
	participant.ReadPump() // Blocks until disconnect
}

func (rt *Router) handleSearch(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	query := r.URL.Query().Get("q")
	if query == "" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]interface{}{})
		return
	}

	// Load the session to get the host's user ID
	session, err := rt.listenTogether.Load(r.Context(), id)
	if err != nil {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	// Search the library under the session creator's context
	ctx := request.WithUser(r.Context(), model.User{ID: session.UserID, IsAdmin: true})
	mfRepo := rt.ds.MediaFile(ctx)

	// Build search filter
	searchFilter := squirrel.Or{
		squirrel.Like{"title": "%" + query + "%"},
		squirrel.Like{"artist": "%" + query + "%"},
		squirrel.Like{"album": "%" + query + "%"},
	}

	results, err := mfRepo.GetAll(model.QueryOptions{
		Filters: squirrel.And{searchFilter, squirrel.Eq{"missing": false}},
		Max:     20,
		Sort:    "title",
	})
	if err != nil {
		log.Error(r.Context(), "Error searching media files for listen session", err)
		http.Error(w, "search error", http.StatusInternalServerError)
		return
	}

	type searchResult struct {
		ID       string  `json:"id"`
		Title    string  `json:"title"`
		Artist   string  `json:"artist"`
		Album    string  `json:"album"`
		Duration float32 `json:"duration"`
	}

	out := make([]searchResult, len(results))
	for i, mf := range results {
		out[i] = searchResult{
			ID:       mf.ID,
			Title:    mf.Title,
			Artist:   mf.Artist,
			Album:    mf.Album,
			Duration: mf.Duration,
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

func (rt *Router) handleStream(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	tokenId := chi.URLParam(r, "id")
	if tokenId == "" {
		tokenId = strings.TrimPrefix(r.URL.Path, "/s/")
	}

	info, err := decodeStreamInfo(tokenId)
	if err != nil {
		log.Error(ctx, "Error parsing listen together stream info", err)
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	mf, err := rt.ds.MediaFile(ctx).Get(info.id)
	if err != nil {
		if errors.Is(err, model.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
		} else {
			log.Error(ctx, "Error retrieving media file for listen together stream", "id", info.id, err)
			http.Error(w, "internal error", http.StatusInternalServerError)
		}
		return
	}

	s, err := rt.streamer.NewStream(ctx, mf, stream.Request{Format: info.format, BitRate: info.bitrate})
	if err != nil {
		if errors.Is(err, stream.ErrTooManyTranscodes) {
			w.Header().Set("Retry-After", strconv.Itoa(stream.RetryAfterSeconds))
			http.Error(w, "too many concurrent transcodes, please retry shortly", http.StatusTooManyRequests)
			return
		}
		log.Error(ctx, "Error starting listen together stream", err)
		http.Error(w, "invalid request", http.StatusInternalServerError)
		return
	}
	defer func() {
		if err := s.Close(); err != nil && log.IsGreaterOrEqualTo(log.LevelDebug) {
			log.Error("Error closing listen together stream", "id", info.id, "file", s.Name(), err)
		}
	}()

	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Content-Duration", strconv.FormatFloat(float64(s.Duration()), 'G', -1, 32))

	n, err := s.Serve(ctx, w, r)
	if err != nil || n == 0 {
		http.Error(w, "internal error", http.StatusInternalServerError)
	}
}

type streamInfo struct {
	id      string
	format  string
	bitrate int
}

func decodeStreamInfo(tokenStr string) (streamInfo, error) {
	c, err := auth.Validate(tokenStr)
	if err != nil {
		return streamInfo{}, err
	}
	if c.ID == "" {
		return streamInfo{}, errors.New("required claim \"id\" not found")
	}
	return streamInfo{id: c.ID, format: c.Format, bitrate: c.BitRate}, nil
}
