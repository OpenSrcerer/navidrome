package model

import (
	"time"
)

type ListenSession struct {
	ID           string    `structs:"id" json:"id,omitempty"`
	UserID       string    `structs:"user_id" json:"userId,omitempty"`
	Description  string    `structs:"description" json:"description,omitempty"`
	ResourceIDs  string    `structs:"resource_ids" json:"resourceIds,omitempty"`
	ResourceType string    `structs:"resource_type" json:"resourceType,omitempty"`
	Contents     string    `structs:"contents" json:"contents,omitempty"`
	Format       string    `structs:"format" json:"format,omitempty"`
	MaxBitRate   int       `structs:"max_bit_rate" json:"maxBitRate,omitempty"`
	CreatedAt    time.Time `structs:"created_at" json:"createdAt,omitempty"`
	UpdatedAt    time.Time `structs:"updated_at" json:"updatedAt,omitempty"`
	Tracks       MediaFiles `structs:"-" json:"tracks,omitempty"`
}

type ListenSessions []ListenSession

type ListenSessionRepository interface {
	Exists(id string) (bool, error)
	Get(id string) (*ListenSession, error)
	GetAll(options ...QueryOptions) (ListenSessions, error)
	CountAll(options ...QueryOptions) (int64, error)
}
