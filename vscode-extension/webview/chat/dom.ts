type Child = Node | string | null | undefined | false;

type Props = {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
};

/** Builds an element. Text always goes in as text, never as markup. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  for (const [name, value] of Object.entries(props.attrs ?? {})) node.setAttribute(name, value);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

export function button(label: string, className: string, onClick: (event: MouseEvent) => void, title?: string): HTMLButtonElement {
  const node = el("button", { class: className, text: label, title, attrs: { type: "button" } });
  node.addEventListener("click", onClick);
  return node;
}
