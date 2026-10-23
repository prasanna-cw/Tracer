package main

import (
	"fmt"

	"acme.com/inventory/internal/store"
)

func main() {
	s := store.NewMemory()
	for _, sku := range []string{"a", "b"} {
		if err := s.Reserve(sku, 1); err != nil {
			fmt.Println(err)
		}
	}
}
