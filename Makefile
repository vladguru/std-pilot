# Команды проекта. Вызываются из корня репозитория. Файл ведёт агент.
# Цели каждого стека лежат в make/*.mk и подключаются ниже; общие цели — здесь.
# Версии инструментов закреплены в .mise.toml: перед первым запуском выполните «mise install».

# Пороги проекта: покрытие кода тестами и доля убитых мутантов, %. Ослабление — изменение ограничителя.
COVERAGE_MIN := 80
MUTATION_MIN := 60

export NEXT_TELEMETRY_DISABLED := 1
STACKS :=
-include make/*.mk

STD := node scripts/std
COMPOSE := docker compose -f deploy/docker-compose.yml
# Выполнить команду инструмента; если инструмента нет, в CI это ошибка, локально — предупреждение.
define tool
@if command -v $(1) >/dev/null 2>&1; then $(2); else echo "не найден $(1): выполните 'mise install'"; test -z "$$CI"; fi
endef

.DEFAULT_GOAL := help
.PHONY: help ci hooks deps lint test build dev e2e e2e-deps smoke check-std docs docs-vale docs-links docs-diagrams docs-generated docs-generate security security-base nightly deploy-preview

help: ## Список целей
	@grep -hE '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/' | sort

ci: lint test build check-std ## Полная проверка перед открытием PR: линтеры, тесты, сборка, трассировка AC
deps: $(addprefix deps-,$(STACKS)) ## Установить зависимости проекта
lint: $(addprefix lint-,$(STACKS)) ## Линтеры, типы и проверка форматирования
test: $(addprefix test-,$(STACKS)) ## Модульные и интеграционные тесты
build: $(addprefix build-,$(STACKS)) ## Сборка всех частей

check-std: ## Трассировка согласованных AC → тест
	$(STD)/ac-trace.mjs

hooks: ## Включить проверки перед коммитом (lefthook)
	$(call tool,lefthook,lefthook install)

dev: ## Запустить систему целиком (docker compose)
	$(COMPOSE) up --build

e2e-deps: ## Браузеры для сквозных тестов (только при наличии tests/e2e)
	@if [ -f tests/e2e/playwright.config.ts ]; then if [ "$$(id -u)" = 0 ]; then pnpm exec playwright install --with-deps chromium; else pnpm exec playwright install chromium; fi; fi

e2e: ## Сквозные тесты Playwright по AC
	@if [ -f tests/e2e/playwright.config.ts ]; then pnpm exec playwright test -c tests/e2e/playwright.config.ts; else echo "e2e: нет tests/e2e/playwright.config.ts — пропуск"; fi

smoke: ## Дымовой тест работающей системы: make smoke URL=http://localhost:8080
	$(STD)/smoke.mjs $(or $(URL),http://localhost:8080)

docs: docs-vale docs-links docs-diagrams docs-generated ## Проверки документации: стиль, ссылки, схемы, формируемые файлы
docs-vale:
	$(call tool,vale,vale --minAlertLevel=error README.md ARCHITECTURE.md CONTRIBUTING.md SPEC.md docs)
docs-links:
	$(call tool,lychee,lychee --offline --no-progress --config .lychee.toml '**/*.md')
docs-diagrams:
	$(STD)/diagrams.mjs
docs-generated:
	$(STD)/generated-docs.mjs
docs-generate: $(addprefix docs-generate-,$(STACKS)) ## Заново сформировать автоматически формируемые документы
	$(STD)/ac-trace.mjs --regenerate-protocols

security: security-base $(addprefix security-,$(STACKS)) ## Секреты, уязвимости, CI, образы, лицензии
security-base:
	$(call tool,gitleaks,gitleaks git --no-banner --redact)
	$(call tool,osv-scanner,osv-scanner scan source --recursive .)
	$(call tool,uvx,uvx --python 3.13 --from semgrep==1.182.0 semgrep scan --config p/default --metrics off --error --quiet .)
	$(call tool,actionlint,actionlint)
	$(call tool,hadolint,find . -name Dockerfile -not -path '*/node_modules/*' -print0 | xargs -0 -r hadolint)

nightly: e2e security $(addprefix nightly-,$(STACKS)) ## Ночной прогон: мутации, полный e2e, сканирование зависимостей

deploy-preview: ## Превью вручную (обычно превью каждого PR создаёт интеграция хостинга)
	@if [ -n "$$VERCEL_TOKEN" ] && [ -d apps/web ]; then npx --yes vercel@65.5.0 deploy --yes --token "$$VERCEL_TOKEN"; else echo "deploy-preview: превью каждого PR создаёт интеграция хостинга; для ручного запуска нужен VERCEL_TOKEN"; fi
