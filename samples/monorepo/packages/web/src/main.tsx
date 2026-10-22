import { Header } from "~/components/Header";
import { greet } from "@mono/shared";

export const App = () => <Header title={greet("web")} />;
