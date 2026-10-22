// Three imports that cannot resolve: a missing relative file, a missing alias target, a missing .js file.
import "./does-not-exist";
import { nope } from "@core/nope";
import { ghost } from "../features/ghost.js";

export const broken = [nope, ghost];
