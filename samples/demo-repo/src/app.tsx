import { Button } from "@ui";
import { createStore } from "@core/store";
import { Widget } from "./features/widgets/Widget";

export function startApp(name: string) {
  const store = createStore();
  // Loaded lazily, only when the user opens reports.
  const openReports = () => import("./features/reports/index");
  return <main title={name}><Widget /><Button label="Reports" onClick={openReports} total={store.total()} /></main>;
}
