import { formatMoney } from "./format";

export function createStore() {
  let cents = 0;
  return { add: (c: number) => (cents += c), total: () => formatMoney(cents) };
}
