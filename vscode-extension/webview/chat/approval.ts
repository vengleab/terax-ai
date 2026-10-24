import type { ApprovalRequest } from "../../shared/chat";
import { button, el } from "./dom";

const KIND_LABEL: Record<ApprovalRequest["kind"], string> = {
  command: "Run command",
  write: "Write file",
  edit: "Edit file",
};

/**
 * The popup that asks before the agent runs a command or changes a file. It covers the page until the
 * person answers. Enter does not answer on its own, so a stray key press while typing cannot allow
 * anything: the buttons, Ctrl or Cmd + Enter (allow) and Escape (deny) are the ways to answer.
 */
export class ApprovalPopup {
  private readonly root: HTMLElement;
  private shownId: string | null = null;
  private returnFocus: HTMLElement | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly answer: (id: string, approved: boolean) => void,
  ) {
    this.root = el("div", { class: "approval-backdrop", attrs: { hidden: "" } });
    this.host.append(this.root);
    // A click on the dimmed area must not take the keyboard focus away from the popup.
    this.root.addEventListener("mousedown", (event) => {
      if (event.target === this.root) {
        event.preventDefault();
        this.dialog()?.focus();
      }
    });
  }

  private dialog(): HTMLElement | null {
    return this.root.querySelector<HTMLElement>(".approval");
  }

  /** Keys are handled for the whole page while the popup is open, wherever the focus happens to be. */
  private readonly onWindowKey = (event: KeyboardEvent): void => this.onKey(event);

  get isOpen(): boolean {
    return this.shownId !== null;
  }

  update(waiting: ApprovalRequest[]): void {
    const next = waiting[0];
    if (!next) {
      this.close();
      return;
    }
    if (next.id === this.shownId) {
      this.updateCount(waiting.length);
      return;
    }
    if (this.shownId === null) {
      const active = document.activeElement;
      this.returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    if (this.shownId === null) window.addEventListener("keydown", this.onWindowKey, true);
    this.shownId = next.id;
    this.root.replaceChildren(this.build(next, waiting.length));
    this.root.hidden = false;
    this.dialog()?.focus();
  }

  private updateCount(total: number): void {
    const count = this.root.querySelector(".approval-count");
    if (count) count.textContent = total > 1 ? `1 of ${total}` : "";
  }

  private close(): void {
    if (this.shownId === null) return;
    window.removeEventListener("keydown", this.onWindowKey, true);
    this.shownId = null;
    this.root.hidden = true;
    this.root.replaceChildren();
    const back = this.returnFocus;
    this.returnFocus = null;
    if (back?.isConnected) back.focus();
  }

  private decide(approved: boolean): void {
    if (this.shownId !== null) this.answer(this.shownId, approved);
  }

  private onKey(event: KeyboardEvent): void {
    if (this.shownId === null || event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.decide(false);
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      this.decide(true);
    } else if (event.key === "Tab") {
      // Keep Tab inside the popup while it is open.
      const focusable = [...this.root.querySelectorAll<HTMLElement>("button, .approval")].filter((n) => !n.hasAttribute("disabled"));
      if (focusable.length === 0) return;
      const index = focusable.indexOf(document.activeElement as HTMLElement); // -1 when the focus is outside
      const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : index === focusable.length - 1 ? 0 : index + 1;
      event.preventDefault();
      focusable[next].focus();
    }
  }

  private build(request: ApprovalRequest, total: number): HTMLElement {
    const titleId = `approval-title-${request.id}`;
    const detailId = `approval-detail-${request.id}`;
    const body = el("div", { class: "approval-body" });
    if (request.kind === "command") {
      body.append(el("pre", { class: "approval-command", attrs: { id: detailId } }, el("code", { text: request.detail })));
      if (request.cwd) body.append(el("div", { class: "approval-meta" }, el("span", { text: "in " }), el("code", { text: request.cwd })));
    } else {
      body.append(el("div", { class: "approval-path", attrs: { id: detailId }, text: request.detail }));
      if (request.diff && request.diff.length > 0) {
        const diff = el("div", { class: "diff", attrs: { role: "group", "aria-label": "Changes" } });
        for (const line of request.diff) {
          const mark = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
          diff.append(el("div", { class: `diff-line ${line.kind}` }, el("span", { class: "diff-mark", text: mark, attrs: { "aria-hidden": "true" } }), el("span", { class: "diff-text", text: line.text })));
        }
        if (request.diffTruncated) diff.append(el("div", { class: "diff-more", text: "… more changes are not shown" }));
        body.append(diff);
      } else {
        body.append(el("div", { class: "approval-meta", text: "No visible change." }));
      }
    }

    const allow = button(request.kind === "command" ? "Run" : "Allow", "approval-allow", () => this.decide(true), "Ctrl or Cmd + Enter");
    const deny = button("Deny", "approval-deny", () => this.decide(false), "Escape");
    return el(
      "div",
      { class: `approval for-${request.kind}`, attrs: { role: "alertdialog", "aria-modal": "true", "aria-labelledby": titleId, "aria-describedby": detailId, tabindex: "-1" } },
      el(
        "div",
        { class: "approval-head" },
        el("span", { class: "approval-kind", text: KIND_LABEL[request.kind] }),
        el("span", { class: "approval-title", text: "Terax wants to continue", attrs: { id: titleId } }),
        el("span", { class: "approval-count", text: total > 1 ? `1 of ${total}` : "" }),
      ),
      body,
      el("div", { class: "approval-actions" }, el("span", { class: "approval-hint", text: "Esc to deny" }), deny, allow),
    );
  }
}
