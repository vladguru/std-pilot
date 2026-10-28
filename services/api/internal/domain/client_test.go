package domain

import (
	"errors"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestNewClient(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		wantName string
		wantErr  error
	}{
		{name: "обычное имя", input: "Иван Петров", wantName: "Иван Петров"},
		{name: "пробелы по краям отбрасываются", input: "  Иван  ", wantName: "Иван"},
		{name: "пустое имя", input: "", wantErr: ErrNameEmpty},
		{name: "только пробелы", input: " \t\n", wantErr: ErrNameEmpty},
		{name: "граница длины допустима", input: strings.Repeat("я", MaxNameLength), wantName: strings.Repeat("я", MaxNameLength)},
		{name: "длина больше границы", input: strings.Repeat("я", MaxNameLength+1), wantErr: ErrNameTooLong},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, err := NewClient(tt.input)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("NewClient(%q): ошибка %v, ожидалась %v", tt.input, err, tt.wantErr)
			}
			if c.Name() != tt.wantName {
				t.Fatalf("NewClient(%q): имя %q, ожидалось %q", tt.input, c.Name(), tt.wantName)
			}
		})
	}
}

// FuzzNewClient проверяет инвариант: созданный клиент всегда имеет непустое имя без пробелов по краям
// и не длиннее границы; иначе возвращается одна из двух известных ошибок.
func FuzzNewClient(f *testing.F) {
	for _, seed := range []string{"", " ", "Иван", strings.Repeat("я", MaxNameLength+1)} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, input string) {
		c, err := NewClient(input)
		if err != nil {
			if !errors.Is(err, ErrNameEmpty) && !errors.Is(err, ErrNameTooLong) {
				t.Fatalf("неизвестная ошибка: %v", err)
			}
			return
		}
		name := c.Name()
		if name == "" || name != strings.TrimSpace(name) || utf8.RuneCountInString(name) > MaxNameLength {
			t.Fatalf("нарушен инвариант для %q: получено %q", input, name)
		}
	})
}
