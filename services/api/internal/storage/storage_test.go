package storage

import (
	"context"
	"errors"
	"testing"
)

type fakePinger struct{ err error }

func (f fakePinger) PingContext(context.Context) error { return f.err }

func TestPingCheck(t *testing.T) {
	broken := errors.New("нет соединения")
	if err := PingCheck(fakePinger{})(context.Background()); err != nil {
		t.Fatalf("рабочее хранилище: %v", err)
	}
	if err := PingCheck(fakePinger{err: broken})(context.Background()); !errors.Is(err, broken) {
		t.Fatalf("ожидалась причина %v, получено %v", broken, err)
	}
}
