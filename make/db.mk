# База данных PostgreSQL: миграции dbmate (up → down → up) и линтер squawk (спека, п. 7).
# Тесты используют DATABASE_URL (см. .env.example); если база не запущена, db-up поднимает её через docker compose.

DATABASE_URL ?= postgres://app:app@localhost:5432/app?sslmode=disable
MIGRATIONS_DIR := services/api/migrations
DBMATE := dbmate --url "$(DATABASE_URL)" --migrations-dir $(MIGRATIONS_DIR) --no-dump-schema

# make/db.mk подключается раньше make/go.mk и т. д., поэтому база поднимается до тестов стека.
STACKS += db

.PHONY: db-up migrate migrate-check migrations-lint deps-db lint-db test-db build-db security-db nightly-db docs-generate-db

db-up: ## Поднять базу данных для разработки и тестов, если она ещё не запущена
	@if command -v pg_isready >/dev/null 2>&1 && pg_isready -q -h localhost -p 5432; then echo "db-up: PostgreSQL уже запущен"; else $(COMPOSE) up -d --wait db; fi

migrate: ## Применить миграции
	$(DBMATE) up

migrate-check: db-up ## Проверка миграций: up → down → up
	$(DBMATE) up
	$(DBMATE) rollback
	$(DBMATE) up

migrations-lint: ## Линтер миграций squawk
	$(call tool,squawk,squawk --exclude ban-drop-table $(MIGRATIONS_DIR)/*.sql)

deps-db build-db security-db nightly-db docs-generate-db:
	@true

lint-db: migrations-lint

test-db: migrate-check
