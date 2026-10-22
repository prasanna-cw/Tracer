// A ".js" specifier that resolves to a ".ts" file (TypeScript's ESM convention).
import { formatMoney } from "../../core/format.js";

export const renderChart = (label) => `[chart ${label} ${formatMoney(0)}]`;
