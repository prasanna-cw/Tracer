import { routes } from "~/routes";
import { greet } from "@mono/shared";

export const start = () => [greet("api"), ...routes];
