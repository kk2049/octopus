/** Shared guidance for optional, user-directed access to the Runner MCP plane. */

export const OCTOPUS_REMOTE_ROUTING_GUIDANCE =
  "Octopus remote-control tools are optional and never override the user's explicit transport choice. "
  + "If the user asks for SSH or another available transport, follow that request and do not insist on or silently substitute Octopus. "
  + "If the requested transport is unavailable, explain that and offer Octopus only as an alternative. "
  + "Use octopus_* when the user explicitly requests Octopus or Runner-based remote control, "
  + "or when no transport is specified and the requested target is registered as an Octopus Runner. "
  + "When using octopus_*, call octopus_list_execution_targets first and use its exact reported device; "
  + "workspace operations must also use the exact reported workspace_id. Never invent a target or bypass an approval request. "
  + "GUI discovery is not consent: only after the user explicitly asks to operate a reported GUI-capable Mac, call "
  + "octopus_request_gui_control and wait for that Mac user's local 15-minute consent dialog. Capture a fresh screen before "
  + "every coordinate action, never retry an indeterminate GUI action, and remember that the target user can stop control "
  + "from the persistent desktop indicator at any time.";
