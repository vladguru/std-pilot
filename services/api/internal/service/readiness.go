// Package service содержит прикладной слой: сценарии использования и проверки готовности.
package service

import (
	"context"
	"fmt"
	"sync"
)

// Check проверяет одну зависимость сервиса (например, базу данных); nil означает «готова».
type Check func(ctx context.Context) error

// Readiness хранит именованные проверки готовности для эндпоинта /readyz.
type Readiness struct {
	mu     sync.RWMutex
	names  []string
	checks map[string]Check
}

// NewReadiness создаёт пустой набор проверок: сервис без зависимостей всегда готов.
func NewReadiness() *Readiness {
	return &Readiness{checks: map[string]Check{}}
}

// Add регистрирует проверку под именем зависимости.
func (r *Readiness) Add(name string, check Check) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.checks[name]; !exists {
		r.names = append(r.names, name)
	}
	r.checks[name] = check
}

// Check выполняет все проверки и возвращает ошибку с именем первой неготовой зависимости.
func (r *Readiness) Check(ctx context.Context) error {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, name := range r.names {
		if err := r.checks[name](ctx); err != nil {
			return fmt.Errorf("зависимость %q не готова: %w", name, err)
		}
	}
	return nil
}
