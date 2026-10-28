// Package storage содержит слой хранения: доступ к базе данных и внешним хранилищам.
package storage

import "context"

// Pinger — то, что умеет проверять соединение (подходит *sql.DB).
type Pinger interface {
	PingContext(ctx context.Context) error
}

// PingCheck превращает хранилище в проверку готовности для service.Readiness.Add:
//
//	readiness.Add("db", storage.PingCheck(db))
func PingCheck(p Pinger) func(ctx context.Context) error {
	return func(ctx context.Context) error { return p.PingContext(ctx) }
}
