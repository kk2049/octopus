import Button, { type ButtonProps } from "antd/es/button";
import styles from "./primitives.module.css";

export type UiButtonTone = "default" | "primary" | "danger" | "quiet";

export interface UiButtonProps extends Omit<ButtonProps, "type" | "danger" | "autoInsertSpace"> {
  tone?: UiButtonTone;
}

export function UiButton({
  tone = "default",
  className,
  children,
  loading,
  disabled,
  "aria-label": ariaLabel,
  ...props
}: UiButtonProps) {
  const legacyRequested = className?.split(/\s+/).find((name) => name === "primary" || name === "danger");
  const resolvedTone = tone === "default" && legacyRequested ? legacyRequested : tone;
  const toneClass = resolvedTone === "default" ? "" : styles[resolvedTone];
  // Keep the historical global primary/danger class as a stable inspection
  // hook even though tokens.css deliberately leaves Ant buttons to this adapter.
  const legacyToneClass = resolvedTone === "primary" || resolvedTone === "danger" ? resolvedTone : "";
  const classes = [styles.button, toneClass, legacyToneClass, className].filter(Boolean).join(" ");

  return (
    <Button
      type={resolvedTone === "primary" ? "primary" : resolvedTone === "quiet" ? "text" : "default"}
      danger={resolvedTone === "danger"}
      autoInsertSpace={false}
      aria-label={ariaLabel ?? (typeof children === "string" ? children : undefined)}
      loading={loading}
      disabled={disabled || Boolean(loading)}
      className={classes}
      {...props}
    >
      {children}
    </Button>
  );
}
