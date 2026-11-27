export const identity = <T>(value: T): T => value;

export const pair = <A, B>(a: A, b: B): [A, B] => {
  return [a, b];
};
