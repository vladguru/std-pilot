package transport

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeReadiness struct{ err error }

func (f fakeReadiness) Check(context.Context) error { return f.err }

func get(t *testing.T, h http.Handler, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
	return rec
}

func TestHealthzAnswersWhileProcessIsAlive(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	// Даже если зависимость не готова, /healthz отвечает 200: процесс жив.
	rec := get(t, NewHandler(logger, fakeReadiness{err: errors.New("база недоступна")}), http.MethodGet, "/healthz")
	if rec.Code != http.StatusOK {
		t.Fatalf("/healthz: код %d, ожидался 200", rec.Code)
	}
}

func TestReadyz(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	tests := []struct {
		name     string
		err      error
		wantCode int
	}{
		{name: "готов", err: nil, wantCode: http.StatusOK},
		{name: "зависимость не готова", err: errors.New("секретный пароль базы"), wantCode: http.StatusServiceUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := get(t, NewHandler(logger, fakeReadiness{err: tt.err}), http.MethodGet, "/readyz")
			if rec.Code != tt.wantCode {
				t.Fatalf("/readyz: код %d, ожидался %d", rec.Code, tt.wantCode)
			}
			if tt.err != nil && strings.Contains(rec.Body.String(), tt.err.Error()) {
				t.Fatalf("причина неготовности попала в ответ: %q", rec.Body.String())
			}
		})
	}
}

func TestOnlyGetIsAllowed(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	rec := get(t, NewHandler(logger, fakeReadiness{}), http.MethodPost, "/healthz")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /healthz: код %d, ожидался 405", rec.Code)
	}
}
