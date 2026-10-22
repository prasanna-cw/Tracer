import { Button } from "./Button";

export function Card({ title }) {
  return <section><h2>{title}</h2><Button label="Open" /></section>;
}
