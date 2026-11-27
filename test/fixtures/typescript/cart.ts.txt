import { round } from "./math";

export const TAX_RATE = 0.2;

export interface Line {
  sku: string;
  price: number;
}

export type Total = { net: number; gross: number };

export function computeTotal(lines: Line[]): Total {
  const net = lines.reduce((sum, line) => sum + line.price, 0);
  return { net, gross: round(net * (1 + TAX_RATE)) };
}

export namespace shop {
  export class Cart {
    private items: Line[] = [];

    constructor(private readonly owner: string) {}

    add(line: Line): void {
      this.items.push(line);
    }

    get size(): number {
      return this.items.length;
    }

    static empty(): Cart {
      return new Cart("nobody");
    }
  }
}

export enum Mode {
  Fast,
  Slow,
}

const helper = <T,>(value: T): T => value;
