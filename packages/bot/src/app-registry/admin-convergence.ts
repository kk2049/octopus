/**
 * G5 equivalence adapter: today's rich trusted management view into the
 * provider-neutral `app-registry-admin/v1` projection.
 *
 * It is deliberately one-way and lossy. Even though today's trusted source
 * view contains build paths and asset metadata, this adapter reduces it to
 * digest/publisher/count/compatibility/health. Nothing here moves an active
 * pointer or changes the existing `/apps` route.
 */
import type { AppRegistryDirectoryProjection } from "@claude-bot/convergence-gates";
import type { AppRegistryDirectoryView } from "./admin-view.js";

export function convergenceRegistryProjection(
  view: AppRegistryDirectoryView,
  revision: number,
): AppRegistryDirectoryProjection {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("registry projection revision must be non-negative");
  return {
    revision,
    apps: view.apps.map((app) => {
      const active = app.releases.find((release) => release.active) ?? null;
      const unsupported = app.releases.some((release) => !release.supported);
      return {
        appId: app.stableAppId,
        publisher: app.publisher,
        activeDigest: app.activePackageDigest,
        releaseCount: app.releases.length,
        compatibility: unsupported ? "incompatible" : app.releases.length ? "supported" : "unknown",
        runtimeHealth: app.runtime
          ? app.runtime.state === "ready" ? "healthy" : app.runtime.state === "stopped" ? "offline" : "degraded"
          : active ? "unknown" : "offline",
      };
    }),
    reconcile: {
      activeUnusable: view.reconcile.activeUnusable.length,
      installedUnusable: view.reconcile.installedUnusable.length,
      undescribable: view.reconcile.undescribable.length,
      orphanContent: view.reconcile.orphanContent,
    },
  };
}
