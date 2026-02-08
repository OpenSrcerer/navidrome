package persistence

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	. "github.com/Masterminds/squirrel"
	"github.com/deluan/rest"
	"github.com/navidrome/navidrome/log"
	"github.com/navidrome/navidrome/model"
	"github.com/navidrome/navidrome/model/request"
	"github.com/pocketbase/dbx"
)

type listenSessionRepository struct {
	sqlRepository
}

func NewListenSessionRepository(ctx context.Context, db dbx.Builder) model.ListenSessionRepository {
	r := &listenSessionRepository{}
	r.ctx = ctx
	r.db = db
	r.registerModel(&model.ListenSession{}, nil)
	return r
}

func (r *listenSessionRepository) Delete(id string) error {
	err := r.delete(Eq{"id": id})
	if errors.Is(err, model.ErrNotFound) {
		return rest.ErrNotFound
	}
	return err
}

func (r *listenSessionRepository) selectListenSession(options ...model.QueryOptions) SelectBuilder {
	return r.newSelect(options...).Columns("listen_session.*")
}

func (r *listenSessionRepository) Exists(id string) (bool, error) {
	return r.exists(Eq{"id": id})
}

func (r *listenSessionRepository) Get(id string) (*model.ListenSession, error) {
	sel := r.selectListenSession().Where(Eq{"listen_session.id": id})
	var res model.ListenSession
	err := r.queryOne(sel, &res)
	if err != nil {
		return nil, err
	}
	err = r.loadMedia(&res)
	return &res, err
}

func (r *listenSessionRepository) GetAll(options ...model.QueryOptions) (model.ListenSessions, error) {
	sq := r.selectListenSession(options...)
	res := model.ListenSessions{}
	err := r.queryAll(sq, &res)
	if err != nil {
		return nil, err
	}
	for i := range res {
		err = r.loadMedia(&res[i])
		if err != nil {
			return nil, fmt.Errorf("error loading media for listen session %s: %w", res[i].ID, err)
		}
	}
	return res, err
}

func (r *listenSessionRepository) loadMedia(session *model.ListenSession) error {
	ids := strings.Split(session.ResourceIDs, ",")
	if len(ids) == 0 {
		return nil
	}
	noMissing := func(cond Sqlizer) Sqlizer {
		return And{cond, Eq{"missing": false}}
	}
	var err error
	switch session.ResourceType {
	case "artist":
		mfRepo := NewMediaFileRepository(r.ctx, r.db)
		session.Tracks, err = mfRepo.GetAll(model.QueryOptions{Filters: noMissing(Eq{"album_artist_id": ids}), Sort: "artist"})
		return err
	case "album":
		mfRepo := NewMediaFileRepository(r.ctx, r.db)
		session.Tracks, err = mfRepo.GetAll(model.QueryOptions{Filters: noMissing(Eq{"album_id": ids}), Sort: "album"})
		return err
	case "playlist":
		ctx := request.WithUser(r.ctx, model.User{IsAdmin: true})
		plsRepo := NewPlaylistRepository(ctx, r.db)
		tracks, err := plsRepo.Tracks(ids[0], true).GetAll(model.QueryOptions{Sort: "id", Filters: noMissing(Eq{})})
		if err != nil {
			return err
		}
		if len(tracks) >= 0 {
			session.Tracks = tracks.MediaFiles()
		}
		return nil
	case "media_file":
		mfRepo := NewMediaFileRepository(r.ctx, r.db)
		tracks, err := mfRepo.GetAll(model.QueryOptions{Filters: noMissing(Eq{"media_file.id": ids})})
		session.Tracks = sortByIdPosition(tracks, ids)
		return err
	}
	log.Warn(r.ctx, "Unsupported ListenSession ResourceType", "session", session.ID, "resourceType", session.ResourceType)
	return nil
}

func (r *listenSessionRepository) Update(id string, entity interface{}, cols ...string) error {
	s := entity.(*model.ListenSession)
	s.ID = id
	s.UpdatedAt = time.Now()
	cols = append(cols, "updated_at")
	_, err := r.put(id, s, cols...)
	if errors.Is(err, model.ErrNotFound) {
		return rest.ErrNotFound
	}
	return err
}

func (r *listenSessionRepository) Save(entity interface{}) (string, error) {
	s := entity.(*model.ListenSession)
	u := loggedUser(r.ctx)
	if s.UserID == "" {
		s.UserID = u.ID
	}
	s.CreatedAt = time.Now()
	s.UpdatedAt = time.Now()
	id, err := r.put(s.ID, s)
	if errors.Is(err, model.ErrNotFound) {
		return "", rest.ErrNotFound
	}
	return id, err
}

func (r *listenSessionRepository) CountAll(options ...model.QueryOptions) (int64, error) {
	return r.count(r.selectListenSession(), options...)
}

func (r *listenSessionRepository) Count(options ...rest.QueryOptions) (int64, error) {
	return r.CountAll(r.parseRestOptions(r.ctx, options...))
}

func (r *listenSessionRepository) EntityName() string {
	return "listen_session"
}

func (r *listenSessionRepository) NewInstance() interface{} {
	return &model.ListenSession{}
}

func (r *listenSessionRepository) Read(id string) (interface{}, error) {
	sel := r.selectListenSession().Where(Eq{"listen_session.id": id})
	var res model.ListenSession
	err := r.queryOne(sel, &res)
	return &res, err
}

func (r *listenSessionRepository) ReadAll(options ...rest.QueryOptions) (interface{}, error) {
	sq := r.selectListenSession(r.parseRestOptions(r.ctx, options...))
	res := model.ListenSessions{}
	err := r.queryAll(sq, &res)
	return res, err
}

var _ model.ListenSessionRepository = (*listenSessionRepository)(nil)
var _ rest.Repository = (*listenSessionRepository)(nil)
var _ rest.Persistable = (*listenSessionRepository)(nil)
