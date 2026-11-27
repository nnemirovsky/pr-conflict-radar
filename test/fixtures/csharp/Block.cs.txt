namespace Acme
{
    namespace Inner
    {
        public struct Point
        {
            public int X;

            public int Sum() { return X; }
        }

        public record Pair(int A, int B);
    }
}
