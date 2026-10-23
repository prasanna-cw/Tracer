package store

type Store interface {
	Reserve(sku string, qty int) error
}
