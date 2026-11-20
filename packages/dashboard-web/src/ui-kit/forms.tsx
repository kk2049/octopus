import { forwardRef, type MutableRefObject, type ReactNode, type Ref } from "react";
import Checkbox from "antd/es/checkbox/Checkbox";
import type { CheckboxProps } from "antd/es/checkbox/Checkbox";
import Input from "antd/es/input/Input";
import type { InputProps, InputRef } from "antd/es/input/Input";
import Password from "antd/es/input/Password";
import type { PasswordProps } from "antd/es/input/Password";
import Radio from "antd/es/radio";
import type { RadioProps } from "antd/es/radio";
import TextArea from "antd/es/input/TextArea";
import type { TextAreaProps, TextAreaRef } from "antd/es/input/TextArea";
import Select from "antd/es/select";
import type { SelectProps } from "antd/es/select";
import styles from "./primitives.module.css";

export type UiInputRef = HTMLInputElement;
export type UiTextAreaRef = HTMLTextAreaElement;

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as MutableRefObject<T | null>).current = value;
}

export const UiInput = forwardRef<HTMLInputElement, InputProps>(function UiInput(
  { className, ...props },
  ref,
) {
  return (
    <Input
      ref={(handle: InputRef | null) => assignRef(ref, handle?.input ?? null)}
      className={[styles.control, className].filter(Boolean).join(" ")}
      {...props}
    />
  );
});

export const UiPasswordInput = forwardRef<HTMLInputElement, PasswordProps>(function UiPasswordInput(
  { className, ...props },
  ref,
) {
  return (
    <Password
      ref={(handle: InputRef | null) => assignRef(ref, handle?.input ?? null)}
      className={[styles.control, className].filter(Boolean).join(" ")}
      {...props}
    />
  );
});

export const UiTextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function UiTextArea(
  { className, ...props },
  ref,
) {
  return (
    <TextArea
      ref={(handle: TextAreaRef | null) => assignRef(ref, handle?.resizableTextArea?.textArea ?? null)}
      className={[styles.control, className].filter(Boolean).join(" ")}
      {...props}
    />
  );
});

export interface UiSelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface UiSelectProps extends Omit<SelectProps<string>, "options" | "onChange"> {
  options: UiSelectOption[];
  onValueChange?: (value: string) => void;
  /** Let long choices use the available width and wrap in both trigger and list. */
  wrapLabels?: boolean;
}

export function UiSelect({ className, onValueChange, wrapLabels = false, ...props }: UiSelectProps) {
  return (
    <Select<string>
      className={[styles.select, wrapLabels && styles.selectWrap, className].filter(Boolean).join(" ")}
      virtual={wrapLabels ? false : undefined}
      optionRender={wrapLabels ? (option) => <span className={styles.selectOptionLabel}>{option.label}</span> : undefined}
      onChange={(value) => onValueChange?.(value)}
      {...props}
    />
  );
}

export function UiCheckbox({ className, ...props }: CheckboxProps) {
  return <Checkbox className={[styles.checkbox, className].filter(Boolean).join(" ")} {...props} />;
}

export function UiRadio({ className, ...props }: RadioProps) {
  return <Radio className={[styles.checkbox, className].filter(Boolean).join(" ")} {...props} />;
}
