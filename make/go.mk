STACKS += go

# Сервис Go лежит в services/api; рабочее пространство — go.work в корне.
GO_DIR := services/api
GOVULNCHECK := golang.org/x/vuln/cmd/govulncheck@v1.9.0
GO_LICENSES := github.com/google/go-licenses/v2@v2.0.1
GREMLINS := github.com/go-gremlins/gremlins/cmd/gremlins@v0.6.0
# Детектор гонок требует компилятора C; без него тесты идут без -race (в CI компилятор есть).
GO_RACE := $(shell command -v gcc >/dev/null 2>&1 && echo -race)

.PHONY: deps-go lint-go test-go build-go security-go nightly-go docs-generate-go

deps-go:
	cd $(GO_DIR) && go mod download

lint-go:
	cd $(GO_DIR) && test -z "$$(gofmt -l .)" || { gofmt -l .; echo "gofmt: отформатируйте файлы (gofmt -w)"; exit 1; }
	cd $(GO_DIR) && go vet ./...
	cd $(GO_DIR) && golangci-lint run ./...

test-go:
	cd $(GO_DIR) && go test $(GO_RACE) -count=1 -coverprofile=coverage.out ./...
	cd $(GO_DIR) && go tool cover -func=coverage.out | awk '/^total:/ { sub("%", "", $$3); if ($$3 + 0 < $(COVERAGE_MIN)) { print "покрытие " $$3 "% ниже порога $(COVERAGE_MIN)%"; exit 1 } else { print "покрытие " $$3 "% (порог $(COVERAGE_MIN)%)" } }'

build-go:
	cd $(GO_DIR) && go build -trimpath -o ../../bin/api ./cmd/api

security-go:
	cd $(GO_DIR) && go run $(GOVULNCHECK) ./...
	cd $(GO_DIR) && go run $(GO_LICENSES) check ./... --disallowed_types=forbidden,restricted --ignore $$(go list -m)

nightly-go:
	cd $(GO_DIR) && go run $(GREMLINS) unleash --threshold-efficacy $(MUTATION_MIN)

docs-generate-go:
	@true
