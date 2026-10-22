// Deliberately invalid: the analyzer must skip this file with a warning, not crash.
import { a } from "../core/cycle/a";
export const oops = (;
