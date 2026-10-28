// Package transport содержит HTTP-слой: маршруты, разбор запросов, ответы.
package transport

import (
	"context"
	"log/slog"
	"net/http"
	"time"
)

// Readiness проверяет готовность зависимостей сервиса.
type Readiness interface {
	Check(ctx context.Context) error
}

// NewHandler возвращает корневой обработчик сервиса с эндпоинтами /healthz и /readyz.
func NewHandler(logger *slog.Logger, readiness Readiness) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthz)
	mux.HandleFunc("GET /readyz", readyz(logger, readiness))
	return mux
}

// healthz отвечает, пока процесс жив; зависимости не проверяет.
func healthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte("ok\n"))
}

// readyz отвечает 200, когда все зависимости готовы, иначе 503. Причина пишется в журнал, а не в ответ.
func readyz(logger *slog.Logger, readiness Readiness) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := readiness.Check(ctx); err != nil {
			logger.Warn("сервис не готов", "error", err)
			http.Error(w, "not ready", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ready\n"))
	}
}
