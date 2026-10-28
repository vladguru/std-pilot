// Command api запускает HTTP-сервис. Настройки читаются только из переменных окружения.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/vladguru/std-pilot/services/api/internal/service"
	"github.com/vladguru/std-pilot/services/api/internal/transport"
)

func main() {
	healthcheck := flag.Bool("healthcheck", false, "проверить /healthz запущенного сервиса и выйти (для проверки состояния контейнера)")
	flag.Parse()

	port := env("PORT", "8080")
	if *healthcheck {
		os.Exit(checkHealth(port))
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel(env("LOG_LEVEL", "info"))}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, logger, port); err != nil {
		logger.Error("сервис остановлен с ошибкой", "error", err)
		os.Exit(1)
	}
}

// run обслуживает запросы, пока контекст не отменён, затем корректно останавливает сервер.
func run(ctx context.Context, logger *slog.Logger, port string) error {
	// Проверки готовности (база данных, внешние сервисы) добавляются сюда: service.Readiness.Add(...).
	readiness := service.NewReadiness()

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           transport.NewHandler(logger, readiness),
		ReadHeaderTimeout: 5 * time.Second,
	}

	errs := make(chan error, 1)
	go func() {
		logger.Info("сервис запущен", "port", port)
		errs <- server.ListenAndServe()
	}()

	select {
	case err := <-errs:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		logger.Info("получен сигнал остановки")
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return server.Shutdown(shutdown)
}

func checkHealth(port string) int {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%s/healthz", port))
	if err != nil {
		return 1
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func logLevel(name string) slog.Level {
	var level slog.Level
	if err := level.UnmarshalText([]byte(name)); err != nil {
		return slog.LevelInfo
	}
	return level
}
