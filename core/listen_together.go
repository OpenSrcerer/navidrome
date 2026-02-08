package core

import (
	"context"
	"strings"

	"github.com/Masterminds/squirrel"
	"github.com/deluan/rest"
	gonanoid "github.com/matoous/go-nanoid/v2"
	"github.com/navidrome/navidrome/log"
	"github.com/navidrome/navidrome/model"
	"github.com/navidrome/navidrome/utils/slice"
	"github.com/navidrome/navidrome/utils/str"
)

type ListenTogether interface {
	Load(ctx context.Context, id string) (*model.ListenSession, error)
	NewRepository(ctx context.Context) rest.Repository
}

func NewListenTogether(ds model.DataStore) ListenTogether {
	return &listenTogetherService{ds: ds}
}

type listenTogetherService struct {
	ds model.DataStore
}

func (s *listenTogetherService) Load(ctx context.Context, id string) (*model.ListenSession, error) {
	repo := s.ds.ListenSession(ctx)
	session, err := repo.Get(id)
	if err != nil {
		return nil, err
	}
	return session, nil
}

func (s *listenTogetherService) NewRepository(ctx context.Context) rest.Repository {
	repo := s.ds.ListenSession(ctx)
	wrapper := &listenSessionRepositoryWrapper{
		ctx:                     ctx,
		ListenSessionRepository: repo,
		Repository:              repo.(rest.Repository),
		Persistable:             repo.(rest.Persistable),
		ds:                      s.ds,
	}
	return wrapper
}

type listenSessionRepositoryWrapper struct {
	model.ListenSessionRepository
	rest.Repository
	rest.Persistable
	ctx context.Context
	ds  model.DataStore
}

func (r *listenSessionRepositoryWrapper) newId() (string, error) {
	for {
		id, err := gonanoid.Generate("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 10)
		if err != nil {
			return "", err
		}
		exists, err := r.Exists(id)
		if err != nil {
			return "", err
		}
		if !exists {
			return id, nil
		}
	}
}

func (r *listenSessionRepositoryWrapper) Save(entity interface{}) (string, error) {
	s := entity.(*model.ListenSession)
	id, err := r.newId()
	if err != nil {
		return "", err
	}
	s.ID = id

	firstId := strings.SplitN(s.ResourceIDs, ",", 2)[0]
	v, err := model.GetEntityByID(r.ctx, r.ds, firstId)
	if err != nil {
		return "", err
	}
	switch v.(type) {
	case *model.Artist:
		s.ResourceType = "artist"
		s.Contents = r.contentsLabelFromArtist(s.ID, s.ResourceIDs)
	case *model.Album:
		s.ResourceType = "album"
		s.Contents = r.contentsLabelFromAlbums(s.ID, s.ResourceIDs)
	case *model.Playlist:
		s.ResourceType = "playlist"
		s.Contents = r.contentsLabelFromPlaylist(s.ID, s.ResourceIDs)
	case *model.MediaFile:
		s.ResourceType = "media_file"
		s.Contents = r.contentsLabelFromMediaFiles(s.ID, s.ResourceIDs)
	default:
		log.Error(r.ctx, "Invalid Resource ID", "id", firstId)
		return "", model.ErrNotFound
	}

	s.Contents = str.TruncateRunes(s.Contents, 30, "...")

	id, err = r.Persistable.Save(s)
	return id, err
}

func (r *listenSessionRepositoryWrapper) Update(id string, entity interface{}, _ ...string) error {
	cols := []string{"description"}
	return r.Persistable.Update(id, entity, cols...)
}

func (r *listenSessionRepositoryWrapper) contentsLabelFromArtist(sessionID string, ids string) string {
	idList := strings.SplitN(ids, ",", 2)
	a, err := r.ds.Artist(r.ctx).Get(idList[0])
	if err != nil {
		log.Error(r.ctx, "Error retrieving artist name for listen session", "session", sessionID, err)
		return ""
	}
	return a.Name
}

func (r *listenSessionRepositoryWrapper) contentsLabelFromAlbums(sessionID string, ids string) string {
	idList := strings.Split(ids, ",")
	all, err := r.ds.Album(r.ctx).GetAll(model.QueryOptions{Filters: squirrel.Eq{"album.id": idList}})
	if err != nil {
		log.Error(r.ctx, "Error retrieving album names for listen session", "session", sessionID, err)
		return ""
	}
	names := slice.Map(all, func(a model.Album) string { return a.Name })
	return strings.Join(names, ", ")
}

func (r *listenSessionRepositoryWrapper) contentsLabelFromPlaylist(sessionID string, id string) string {
	pls, err := r.ds.Playlist(r.ctx).Get(id)
	if err != nil {
		log.Error(r.ctx, "Error retrieving playlist name for listen session", "session", sessionID, err)
		return ""
	}
	return pls.Name
}

func (r *listenSessionRepositoryWrapper) contentsLabelFromMediaFiles(sessionID string, ids string) string {
	idList := strings.Split(ids, ",")
	mfs, err := r.ds.MediaFile(r.ctx).GetAll(model.QueryOptions{Filters: squirrel.And{
		squirrel.Eq{"media_file.id": idList},
		squirrel.Eq{"missing": false},
	}})
	if err != nil {
		log.Error(r.ctx, "Error retrieving media files for listen session", "session", sessionID, err)
		return ""
	}

	if len(mfs) == 1 {
		return mfs[0].Title
	}

	albums := slice.Group(mfs, func(mf model.MediaFile) string { return mf.Album })
	if len(albums) == 1 {
		for name := range albums {
			return name
		}
	}
	artists := slice.Group(mfs, func(mf model.MediaFile) string { return mf.AlbumArtist })
	if len(artists) == 1 {
		for name := range artists {
			return name
		}
	}

	return mfs[0].Title
}
