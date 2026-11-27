package cart

import "errors"

// Max is the largest quantity of one line.
const (
	Max = 99
	Min = 1
)

var (
	ErrEmpty = errors.New("empty")
	ErrFull  = errors.New("full")
)

type Store interface {
	Get(id int) (Item, error)
	Put(item Item) error
}

type Item struct {
	ID    int
	Price int `json:"price"`
}

type Cart struct {
	Items []Item
	owner string
}

func New(owner string) *Cart {
	return &Cart{owner: owner}
}

func (c *Cart) Add(item Item) error {
	if len(c.Items) >= Max {
		return ErrFull
	}
	c.Items = append(c.Items, item)
	return nil
}

func (c Cart) Total() int {
	sum := 0
	for _, item := range c.Items {
		sum += item.Price
	}
	return sum
}

func (c *Cart) Reset(
	keep int,
) {
	c.Items = c.Items[:keep]
}
