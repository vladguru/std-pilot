STACKS += web

# Веб-интерфейс лежит в apps/web; рабочее пространство pnpm — в корне.
WEB := pnpm --filter web
WEB_FORBIDDEN_LICENSES := GPL;AGPL;LGPL;CC-BY-NC

.PHONY: deps-web lint-web test-web build-web security-web nightly-web docs-generate-web

deps-web:
	pnpm install

lint-web:
	$(WEB) exec eslint --max-warnings 0 .
	$(WEB) exec tsc --noEmit
	pnpm exec prettier --check apps tests --ignore-unknown

test-web:
	$(WEB) exec vitest run --coverage

build-web:
	$(WEB) build

security-web:
	pnpm audit --audit-level=high
	pnpm exec license-checker-rseidelsohn --production --excludePrivatePackages --failOn "$(WEB_FORBIDDEN_LICENSES)"

# Мутационное тестирование слоя lib (настройка — apps/web/stryker.config.json).
nightly-web:
	$(WEB) exec stryker run

docs-generate-web:
	@true
