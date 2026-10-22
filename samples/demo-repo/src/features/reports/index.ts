import { createStore } from "@core";
import { a } from "../../core/cycle/a";
import { renderChart } from "./chart.js";

export const report = () => renderChart(createStore().total() + a());
