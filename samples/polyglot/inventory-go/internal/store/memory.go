package store

type Memory struct{ stock map[string]int }

func NewMemory() *Memory { return &Memory{stock: map[string]int{}} }

func (m *Memory) Reserve(sku string, qty int) error {
	m.stock[sku] -= qty
	return nil
}
