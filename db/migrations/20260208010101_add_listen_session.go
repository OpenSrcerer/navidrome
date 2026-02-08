package migrations

import (
	"context"
	"database/sql"

	"github.com/pressly/goose/v3"
)

func init() {
	goose.AddMigrationContext(upAddListenSession, downAddListenSession)
}

func upAddListenSession(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS listen_session (
			id            VARCHAR(255) NOT NULL PRIMARY KEY,
			user_id       VARCHAR(255) NOT NULL,
			description   VARCHAR(255) DEFAULT '',
			resource_ids  VARCHAR NOT NULL,
			resource_type VARCHAR(255) NOT NULL,
			contents      VARCHAR(255) DEFAULT '',
			format        VARCHAR(255) DEFAULT '',
			max_bit_rate  INTEGER DEFAULT 0,
			created_at    DATETIME NOT NULL,
			updated_at    DATETIME NOT NULL,
			FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
		);
		CREATE INDEX IF NOT EXISTS idx_listen_session_user_id ON listen_session(user_id);
	`)
	return err
}

func downAddListenSession(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `
		DROP INDEX IF EXISTS idx_listen_session_user_id;
		DROP TABLE IF EXISTS listen_session;
	`)
	return err
}
