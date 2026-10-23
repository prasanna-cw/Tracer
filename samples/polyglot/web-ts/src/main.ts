import { fetchOrders } from "./api";

export async function start() {
  const orders = await fetchOrders();
  return orders.length;
}
