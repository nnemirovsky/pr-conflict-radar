import * as React from "react";

export function Badge({ label }: { label: string }) {
  return <span className="badge">{label}</span>;
}

export const Panel = ({ title }: { title: string }) => {
  const heading = <h2>{title}</h2>;
  return <section>{heading}</section>;
};
