// Deliberate cycle: c -> a -> b -> c.
import { a } from "./a";
export const c = (): string => (Math.random() > 2 ? a() : "c");
