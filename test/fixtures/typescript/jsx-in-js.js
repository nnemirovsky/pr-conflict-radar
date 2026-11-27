export function render(items) {
  return <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>;
}
