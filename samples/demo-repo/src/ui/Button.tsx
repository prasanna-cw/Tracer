import React from "react";
import { formatMoney } from "@core/format";

export function Button(props: { label: string; total?: string; onClick?: () => void }) {
  return <button onClick={props.onClick}>{props.label} {props.total ?? formatMoney(0)}</button>;
}
export default React;
