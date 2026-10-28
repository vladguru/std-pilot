package service

import (
	"context"
	"errors"
	"testing"
)

func TestReadiness(t *testing.T) {
	failing := errors.New("нет соединения")
	tests := []struct {
		name    string
		checks  map[string]error
		wantErr bool
	}{
		{name: "без зависимостей готов", checks: nil},
		{name: "все зависимости готовы", checks: map[string]error{"db": nil, "cache": nil}},
		{name: "одна зависимость не готова", checks: map[string]error{"db": failing}, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := NewReadiness()
			for name, err := range tt.checks {
				r.Add(name, func(context.Context) error { return err })
			}
			err := r.Check(context.Background())
			if (err != nil) != tt.wantErr {
				t.Fatalf("Check() = %v, ошибка ожидалась: %v", err, tt.wantErr)
			}
			if tt.wantErr && !errors.Is(err, failing) {
				t.Fatalf("ошибка %v не содержит причину %v", err, failing)
			}
		})
	}
}

func TestReadinessReplacesCheckWithSameName(t *testing.T) {
	r := NewReadiness()
	r.Add("db", func(context.Context) error { return errors.New("старая") })
	r.Add("db", func(context.Context) error { return nil })
	if err := r.Check(context.Background()); err != nil {
		t.Fatalf("повторная регистрация должна заменять проверку, получено %v", err)
	}
}
