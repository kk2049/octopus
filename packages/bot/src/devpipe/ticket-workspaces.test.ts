import { expect, it } from "vitest";
import { ticketResourceOwner } from "./ticket-workspaces.js";
import type { TicketRunnerConfig } from "./runner-ticket.js";

const ownerRoots = [
  { device: "build-host", workspace_id: `ws_${"a".repeat(24)}`, label: "tools", default: true },
  { device: "source-host", workspace_id: `ws_${"b".repeat(24)}`, label: "source" },
];

it("routes every current ticket developer to an explicitly configured shared pool", () => {
  const config: TicketRunnerConfig = {
    targets: { lht: { device: "source-host", workspace_id: ownerRoots[1]!.workspace_id, workspaces: ownerRoots } },
    shared_pool: { owner: "lht", requesters: [], all_developers: true, source_devices: ["source-host"] },
  };
  for (const user of ["lilei", "new-contributor"]) {
    expect(ticketResourceOwner(config, user, () => true)).toBe("lht");
    expect(ticketResourceOwner(config, user, () => false)).toBe(user);
  }
});

it("honours an explicit requester list when the pool is not open to all developers", () => {
  const config: TicketRunnerConfig = {
    targets: { lht: { device: "source-host", workspace_id: ownerRoots[1]!.workspace_id, workspaces: ownerRoots } },
    shared_pool: { owner: "lht", requesters: ["lilei"], source_devices: [] },
  };
  expect(ticketResourceOwner(config, "lilei", () => true)).toBe("lht");
  expect(ticketResourceOwner(config, "other", () => true)).toBe("other");
});

it("shares nothing until the owner's target declares exact ticket roots", () => {
  const config: TicketRunnerConfig = {
    targets: { lht: { device: "source-host", workspace_id: ownerRoots[1]!.workspace_id } },
    shared_pool: { owner: "lht", requesters: [], all_developers: true, source_devices: [] },
  };
  expect(ticketResourceOwner(config, "lilei", () => true)).toBe("lilei");
  expect(ticketResourceOwner(undefined, "lilei", () => true)).toBe("lilei");
});
