import { CURRENCY } from "./config";

export const formatMoney = (cents: number): string => `${CURRENCY} ${(cents / 100).toFixed(2)}`;
