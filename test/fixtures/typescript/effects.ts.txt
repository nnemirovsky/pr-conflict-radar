import { writeFileSync } from "node:fs";

writeFileSync(process.env.EFFECT_MARKER ?? "/nonexistent/marker", "ran");
throw new Error("top-level side effect");

export function never() {
  return 1;
}
