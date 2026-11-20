import { useEffect, useRef, type ReactNode } from "react";

export function Dialog({
  title,
  close,
  children,
}: {
  title: string;
  close(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null),
    dismiss = useRef(close);
  dismiss.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null,
      element = ref.current;
    if (!element) return;
    const focusable = () => [
      ...element.querySelectorAll<HTMLElement>(
        'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
      ),
    ];
    (focusable()[0] ?? element).focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        dismiss.current();
      }
      if (event.key === "Tab") {
        const items = focusable(),
          first = items[0],
          last = items.at(-1);
        if (!first) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    element.addEventListener("keydown", key);
    return () => {
      element.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      ref={ref}
      className="rv-dialog-shade"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
    >
      {children}
    </div>
  );
}
