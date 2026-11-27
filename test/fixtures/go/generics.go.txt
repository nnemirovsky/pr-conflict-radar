//go:build linux

package cart

type Box[T any] struct {
	value T
}

func (b *Box[T]) Get() T {
	return b.value
}
