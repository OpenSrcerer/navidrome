package tests

import (
	"github.com/deluan/rest"
	"github.com/navidrome/navidrome/model"
)

type MockListenSessionRepo struct {
	model.ListenSessionRepository
	rest.Repository
	rest.Persistable

	Entity interface{}
	ID     string
	Cols   []string
	Error  error
}

func (m *MockListenSessionRepo) Exists(id string) (bool, error) {
	if m.Error != nil {
		return false, m.Error
	}
	return m.ID == id, nil
}

func (m *MockListenSessionRepo) Get(id string) (*model.ListenSession, error) {
	if m.Error != nil {
		return nil, m.Error
	}
	if m.Entity != nil {
		s := m.Entity.(*model.ListenSession)
		return s, nil
	}
	return nil, model.ErrNotFound
}

func (m *MockListenSessionRepo) GetAll(options ...model.QueryOptions) (model.ListenSessions, error) {
	if m.Error != nil {
		return nil, m.Error
	}
	return model.ListenSessions{}, nil
}

func (m *MockListenSessionRepo) CountAll(options ...model.QueryOptions) (int64, error) {
	if m.Error != nil {
		return 0, m.Error
	}
	return 0, nil
}
