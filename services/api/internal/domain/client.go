// Package domain содержит предметный слой: сущности и правила, не зависящие от транспорта и хранилища.
package domain

import (
	"errors"
	"strings"
	"unicode/utf8"
)

// MaxNameLength — наибольшая допустимая длина имени клиента в символах.
const MaxNameLength = 200

// Ошибки проверки данных клиента.
var (
	ErrNameEmpty   = errors.New("имя клиента не задано")
	ErrNameTooLong = errors.New("имя клиента слишком длинное")
)

// Client — образец сущности предметного слоя: замените её сущностями проекта, сохранив устройство
// (конструктор проверяет инварианты, поля не меняются в обход конструктора).
type Client struct {
	name string
}

// NewClient создаёт клиента; пробелы по краям имени отбрасываются.
func NewClient(name string) (Client, error) {
	name = strings.TrimSpace(name)
	switch {
	case name == "":
		return Client{}, ErrNameEmpty
	case utf8.RuneCountInString(name) > MaxNameLength:
		return Client{}, ErrNameTooLong
	}
	return Client{name: name}, nil
}

// Name возвращает имя клиента.
func (c Client) Name() string { return c.name }

// Дополнительное пояснение.
