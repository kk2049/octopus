/** Keep popup DOM inside the same App CSS/token scope as its trigger. */
export function appPopupContainer(trigger: HTMLElement): HTMLElement {
  return trigger.closest<HTMLElement>("[data-app-surface]") ?? trigger.ownerDocument.body;
}
