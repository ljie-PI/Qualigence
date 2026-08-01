import type { ReactNode } from "react";
import { ApiClientError } from "../api/errors.js";

/** Loading / error / empty presentational wrapper for a queried resource. */
export function DataState(props: {
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly isEmpty?: boolean;
  readonly emptyLabel?: string;
  readonly children: ReactNode;
}): ReactNode {
  if (props.isLoading) {
    return <p className="state state--loading">Loading…</p>;
  }
  if (props.error !== null && props.error !== undefined) {
    const message =
      props.error instanceof ApiClientError
        ? `${props.error.code}: ${props.error.message}`
        : "An unexpected error occurred.";
    return (
      <p className="state state--error" role="alert">
        {message}
      </p>
    );
  }
  if (props.isEmpty === true) {
    return <p className="state state--empty">{props.emptyLabel ?? "Nothing to show yet."}</p>;
  }
  return <>{props.children}</>;
}

/** A labelled status pill. */
export function StatusBadge(props: { readonly value: string }): ReactNode {
  return <span className={`badge badge--${props.value}`}>{props.value}</span>;
}

/** A simple key/value description list. */
export function DefinitionList(props: {
  readonly items: readonly (readonly [string, ReactNode])[];
}): ReactNode {
  return (
    <dl className="definition-list">
      {props.items.map(([term, value]) => (
        <div key={term} className="definition-list__row">
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
