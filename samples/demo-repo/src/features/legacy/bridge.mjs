import path from "node:path";
import helper from "./helper.cjs";

export const legacyBridge = () => helper.greet(path.basename("/bridge"));
