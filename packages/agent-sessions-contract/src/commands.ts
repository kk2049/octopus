/** Shared action encoding for every Sessions port backed by proposals. */
import { ALL_SOURCES, SESSION_ACTIONS, SESSION_PARAMS } from './actions.js';
import type { FileAnnotation, SessionsPort, SessionsReply } from './index.js';

export function createSessionCommands(propose: (action: string, params: Record<string, string>) => Promise<SessionsReply>): Omit<SessionsPort, 'snapshot' | 'subscribe' | 'clearRefusal'> {
  const ROSTER_LIMIT = '200';
  const prompt = (
    action: string,
    resource: string,
    value: string,
    permissionProfile?: string,
    effort?: string,
    model?: string,
  ) =>
    propose(action, {
      [SESSION_PARAMS.resource]: resource,
      [SESSION_PARAMS.prompt]: value,
      ...(permissionProfile ? { [SESSION_PARAMS.permissionProfile]: permissionProfile } : {}),
      ...(effort ? { [SESSION_PARAMS.effort]: effort } : {}),
      ...(model ? { [SESSION_PARAMS.model]: model } : {}),
    });
  const terminal = (device: string, size: { cols: number; rows: number }) => ({
    [SESSION_PARAMS.device]: device,
    [SESSION_PARAMS.cols]: String(size.cols),
    [SESSION_PARAMS.rows]: String(size.rows),
  });

  return {
    refreshSessions: () =>
      propose(SESSION_ACTIONS.refreshSessions, {
        [SESSION_PARAMS.limit]: ROSTER_LIMIT,
        [SESSION_PARAMS.source]: ALL_SOURCES,
      }),
    browseSessions: (request) => propose(SESSION_ACTIONS.refreshSessions, {
      [SESSION_PARAMS.device]: request.device,
      [SESSION_PARAMS.source]: request.source,
      [SESSION_PARAMS.cursor]: request.cursor,
      [SESSION_PARAMS.limit]: "100",
    }),
    search: (query, limit, cursor) =>
      propose(SESSION_ACTIONS.search, {
        [SESSION_PARAMS.query]: query,
        [SESSION_PARAMS.limit]: String(limit),
        [SESSION_PARAMS.source]: ALL_SOURCES,
        ...(cursor ? { [SESSION_PARAMS.cursor]: cursor } : {}),
      }),
    readWindow: (request) =>
      propose(SESSION_ACTIONS.readWindow, {
        [SESSION_PARAMS.resource]: request.resource,
        [SESSION_PARAMS.limit]: String(request.limit),
        ...(request.offset == null ? {} : { [SESSION_PARAMS.offset]: String(request.offset) }),
      }),
    readBlock: (request) =>
      propose(SESSION_ACTIONS.readWindow, {
        [SESSION_PARAMS.resource]: request.resource,
        [SESSION_PARAMS.offset]: String(request.offset),
        [SESSION_PARAMS.block]: String(request.block),
        [SESSION_PARAMS.field]: request.field,
        [SESSION_PARAMS.charOffset]: String(request.charOffset),
      }),
    closeSession: (resource) => propose(SESSION_ACTIONS.closeSession, { [SESSION_PARAMS.resource]: resource }),
    listWorkspaces: (device) => propose(SESSION_ACTIONS.listWorkspaces, { [SESSION_PARAMS.device]: device }),

    // Launch facts only, no identity. The trusted Host rebinds owner, app,
    // scope and instance from its own record.
    start: (request) =>
      propose(SESSION_ACTIONS.start, {
        [SESSION_PARAMS.device]: request.device,
        ...(request.runtimeDevice
          ? { [SESSION_PARAMS.runtimeDevice]: request.runtimeDevice }
          : {}),
        [SESSION_PARAMS.directory]: request.directory,
        ...(request.workspaceId
          ? {
              [SESSION_PARAMS.workspaceId]: request.workspaceId,
              [SESSION_PARAMS.workspaceLabel]: request.workspaceLabel ?? "",
              [SESSION_PARAMS.workspaceDisplay]: request.workspaceDisplay ?? "",
            }
          : {}),
        ...(request.codexAccount ? { [SESSION_PARAMS.codexAccount]: request.codexAccount } : {}),
        [SESSION_PARAMS.source]: request.source,
        [SESSION_PARAMS.model]: request.model,
        [SESSION_PARAMS.effort]: request.effort,
        ...(request.permissionProfile
          ? { [SESSION_PARAMS.permissionProfile]: request.permissionProfile }
          : {}),
        // Only present when the bilingual lane was chosen; the trusted side
        // reads an absent param as the plain Claude lane.
        ...(request.translatePrompt ? { [SESSION_PARAMS.translatePrompt]: "true" } : {}),
        [SESSION_PARAMS.prompt]: request.prompt,
      }),
    append: (resource, value, permissionProfile, effort, model) =>
      prompt(SESSION_ACTIONS.append, resource, value, permissionProfile, effort, model),
    resume: (resource, value, permissionProfile, effort, model) =>
      prompt(SESSION_ACTIONS.resume, resource, value, permissionProfile, effort, model),
    takeover: (resource, value, permissionProfile, effort, model) =>
      prompt(SESSION_ACTIONS.takeover, resource, value, permissionProfile, effort, model),
    fallback: (resource, value, permissionProfile, effort, model) =>
      prompt(SESSION_ACTIONS.fallback, resource, value, permissionProfile, effort, model),
    interrupt: (resource) =>
      propose(SESSION_ACTIONS.interrupt, { [SESSION_PARAMS.resource]: resource }),
    releaseControl: (resource) =>
      propose(SESSION_ACTIONS.releaseControl, { [SESSION_PARAMS.resource]: resource }),
    respondInteraction: (resource, interactionId, response) =>
      propose(SESSION_ACTIONS.respondInteraction, {
        [SESSION_PARAMS.resource]: resource,
        [SESSION_PARAMS.interactionId]: interactionId,
        [SESSION_PARAMS.responseJson]: JSON.stringify(response),
      }),
    openTerminal: (device, workspaceId, size) =>
      propose(SESSION_ACTIONS.openTerminal, { ...terminal(device, size), [SESSION_PARAMS.workspaceId]: workspaceId }),
    readTerminal: (device, terminalId, size) =>
      propose(SESSION_ACTIONS.readTerminal, { ...terminal(device, size), [SESSION_PARAMS.terminalId]: terminalId }),
    sendTerminal: (device, terminalId, input, size) =>
      propose(SESSION_ACTIONS.sendTerminal, {
        ...terminal(device, size),
        [SESSION_PARAMS.terminalId]: terminalId,
        [SESSION_PARAMS.input]: input,
      }),
    closeTerminal: (device, terminalId) =>
      propose(SESSION_ACTIONS.closeTerminal, {
        [SESSION_PARAMS.device]: device,
        [SESSION_PARAMS.terminalId]: terminalId,
      }),
    pin: (resource) => propose(SESSION_ACTIONS.pin, { [SESSION_PARAMS.session]: resource }),
    setPinned: (resource, pinned) => propose(SESSION_ACTIONS.pin, {
      [SESSION_PARAMS.session]: resource,
      [SESSION_PARAMS.pinned]: pinned ? "true" : "false",
    }),
    saveFolder: (folder, name) => propose(SESSION_ACTIONS.saveFolder, {
      [SESSION_PARAMS.folder]: folder,
      [SESSION_PARAMS.name]: name,
    }),
    deleteFolder: (folder) => propose(SESSION_ACTIONS.deleteFolder, { [SESSION_PARAMS.folder]: folder }),
    fileSessions: (resources, folder) => propose(SESSION_ACTIONS.fileSessions, {
      [SESSION_PARAMS.sessions]: resources.join(","),
      [SESSION_PARAMS.folder]: folder,
    }),
    setTitle: (resource, title) =>
      propose(SESSION_ACTIONS.setTitle, {
        [SESSION_PARAMS.session]: resource,
        [SESSION_PARAMS.title]: title,
      }),
    readContinuation: resource => propose(SESSION_ACTIONS.readContinuation, { resource }),
    saveContinuation: (resource, prompt, revision) => propose(SESSION_ACTIONS.saveContinuation, { resource, prompt: prompt ?? "", revision }),
    markReviewed: (resource, completedAt) =>
      propose(SESSION_ACTIONS.markReviewed, {
        [SESSION_PARAMS.session]: resource,
        [SESSION_PARAMS.completedAt]: completedAt,
      }),
    setFileAnnotations: (fileKey, annotations) =>
      propose(SESSION_ACTIONS.setFileAnnotations, {
        [SESSION_PARAMS.annotationsPayload]: JSON.stringify({
          file_key: fileKey,
          annotations: annotations satisfies readonly FileAnnotation[],
        }),
      }),
    // Existing sessions use an opaque resource. A launch draft names its
    // execution device/workspace; the trusted Host binds owner and draft id,
    // and the Runner chooses the fresh attachment directory in both cases.
    attachFile: (input) =>
      propose(SESSION_ACTIONS.attachFile, {
        ...(input.resource ? { [SESSION_PARAMS.resource]: input.resource } : {}),
        ...(input.device ? { [SESSION_PARAMS.device]: input.device } : {}),
        ...(input.workspaceId ? { [SESSION_PARAMS.workspaceId]: input.workspaceId } : {}),
        [SESSION_PARAMS.name]: input.name,
        [SESSION_PARAMS.mediaType]: input.mediaType,
        [SESSION_PARAMS.chunkIndex]: String(input.chunkIndex),
        [SESSION_PARAMS.chunkCount]: String(input.chunkCount),
        [SESSION_PARAMS.data]: input.data,
        ...(input.uploadId ? { [SESSION_PARAMS.uploadId]: input.uploadId } : {}),
      }),
  };
}
