using System;

namespace Acme.Shop;

public interface IPriced
{
    decimal Price { get; }
}

public enum Mode
{
    Fast,
    Slow,
}

public delegate void Changed(int count);

public partial class Cart : IPriced
{
    private readonly int[] items = new int[4];
    public static int Created, Destroyed;

    public Cart(string owner)
    {
        Owner = owner;
    }

    ~Cart()
    {
    }

    public string Owner { get; }

    public decimal Price => 1m;

    public int this[int index]
    {
        get { return items[index]; }
    }

    public event Changed? OnChange;

    public int Total(int a)
    {
        int Twice(int x) => x * 2;
        return Twice(a);
    }

    public int Total(int a, int b) => a + b;

    public static Cart operator +(Cart left, Cart right)
    {
        return left;
    }

    public static implicit operator int(Cart cart)
    {
        return 0;
    }

    public class Line
    {
        public void Print()
        {
            Console.WriteLine("line");
        }
    }
}

public partial class Cart
{
    public void Clear()
    {
        Array.Clear(items);
    }
}
