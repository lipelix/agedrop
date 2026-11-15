/** A tiny DOM builder. Text always goes in as text nodes, so repository content cannot inject markup. */

type Child = Node | string | false | null | undefined;
type Attributes = Record<string, string | boolean | undefined | ((event: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") element.addEventListener(name.slice(2), value);
    else element.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === false || child === null || child === undefined) continue;
    element.append(child);
  }
  return element;
}

/** Formats an ISO date as `YYYY-MM-DD`, the way `agedrop ls` does. */
export function day(iso: string): string {
  return iso.slice(0, 10);
}
