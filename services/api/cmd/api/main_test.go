package main

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestEnvAndLogLevel(t *testing.T) {
	t.Setenv("STD_TEST_VALUE", "из окружения")
	if got := env("STD_TEST_VALUE", "по умолчанию"); got != "из окружения" {
		t.Fatalf("env: %q", got)
	}
	if got := env("STD_TEST_UNSET", "по умолчанию"); got != "по умолчанию" {
		t.Fatalf("env без значения: %q", got)
	}
	if got := logLevel("debug"); got != slog.LevelDebug {
		t.Fatalf("logLevel(debug) = %v", got)
	}
	if got := logLevel("не уровень"); got != slog.LevelInfo {
		t.Fatalf("неизвестный уровень должен давать info, получено %v", got)
	}
}

func portOf(t *testing.T, serverURL string) string {
	t.Helper()
	u, err := url.Parse(serverURL)
	if err != nil {
		t.Fatal(err)
	}
	return u.Port()
}

func TestCheckHealth(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	defer ok.Close()
	if code := checkHealth(portOf(t, ok.URL)); code != 0 {
		t.Fatalf("здоровый сервис: код %d", code)
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) }))
	defer bad.Close()
	if code := checkHealth(portOf(t, bad.URL)); code != 1 {
		t.Fatalf("сервис с ошибкой: код %d", code)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closedPort := portOf(t, "http://"+listener.Addr().String())
	_ = listener.Close()
	if code := checkHealth(closedPort); code != 1 {
		t.Fatalf("сервис не запущен: код %d", code)
	}
}

func TestRunServesUntilContextIsCancelled(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := portOf(t, "http://"+listener.Addr().String())
	_ = listener.Close()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- run(ctx, slog.New(slog.NewTextHandler(io.Discard, nil)), port) }()

	deadline := time.Now().Add(5 * time.Second)
	for {
		resp, err := http.Get("http://127.0.0.1:" + port + "/readyz") //nolint:noctx // тест обращается к локальному серверу
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("/readyz: код %d", resp.StatusCode)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("сервис не запустился: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("остановка: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("сервис не остановился после отмены контекста")
	}
}
