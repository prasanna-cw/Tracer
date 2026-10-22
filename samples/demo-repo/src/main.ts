import { startApp } from "./app";
import { slugify } from "@utils";
import { legacyBridge } from "./features/legacy/bridge.mjs";

startApp(slugify("Demo App"));
legacyBridge();
