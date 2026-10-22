import { formatTitle } from "~/lib/format";

export const Header = ({ title }: { title: string }) => <h1>{formatTitle(title)}</h1>;
