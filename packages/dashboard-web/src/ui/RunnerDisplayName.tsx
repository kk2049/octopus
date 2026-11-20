import { useEffect, useRef, useState } from "react";
import { useDashboardLanguage } from "../i18n/react.js";
import { uiText } from "../i18n/ui-text.js";
import { api, errorText } from "../lib/api.js";
import { Dialog } from "./Dialog.js";
import { ErrorBox, useAction } from "./misc.js";
import { UiButton, UiInput } from "../ui-kit/primitives.js";

/** A label editor. Its owner/device target never changes with the entered name. */
export function RunnerDisplayName({ username, device, displayName, canEdit, onSaved }: {
  username: string; device: string; displayName?: string; canEdit: boolean;
  onSaved(): Promise<unknown>;
}) {
  useDashboardLanguage();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [save, saving] = useAction(async () => {
    setError("");
    try {
      await api("/api/runner-display-name", {
        method: "POST", json: { username, device, display_name: name },
      });
      if (!mounted.current) return;
      await onSaved();
      if (mounted.current) setOpen(false);
    } catch (failure) { if (mounted.current) setError(errorText(failure)); }
  });
  return <>
    <strong>{displayName || device}</strong>
    {canEdit ? <UiButton onClick={() => { setName(displayName || device); setError(""); setOpen(true); }}>
      {uiText("修改显示名")}
    </UiButton> : null}
    <Dialog open={open} title={uiText("修改设备显示名")} onOpenChange={(next) => { if (!saving) setOpen(next); }}
      footer={<>
        <UiButton disabled={saving} onClick={() => setOpen(false)}>{uiText("取消")}</UiButton>
        <UiButton tone="primary" disabled={!name.trim()} loading={saving} onClick={() => void save()}>
          {saving ? uiText("保存中…") : uiText("保存")}
        </UiButton>
      </>}>
      <UiInput aria-label={uiText("设备显示名")} value={name} maxLength={128} disabled={saving}
        onChange={(event) => setName(event.target.value)} />
      {error ? <ErrorBox>{error}</ErrorBox> : null}
    </Dialog>
  </>;
}
