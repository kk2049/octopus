import type {
  ArchitectureAnnotation,
  ArchitectureModuleDefinition,
  FlowDefinition,
  FlowFact,
  FlowStepFact,
} from "../shared/model.js";
import { adjacency, stronglyConnectedComponents } from "./graph.js";
import { moduleForPath } from "./paths.js";

export interface FlowBuildIssue {
  message: string;
  annotation?: ArchitectureAnnotation;
}
function list(value?: string): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function humanize(value: string): string {
  return value.replaceAll("-", " ").replaceAll("_", " ").replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function orderFlowSteps(flowId: string, values: FlowStepFact[], issues: FlowBuildIssue[]): { steps: FlowStepFact[]; cycles: string[][] } {
  const insertionOrder = new Map(values.map((step, index) => [step.id, index]));
  const edges = values.flatMap((step) => (step.after ?? []).map((predecessor) => ({ from: predecessor, to: step.id })));
  const graph = adjacency(edges, values.map((step) => step.id));
  const cycles = stronglyConnectedComponents(graph).filter((component) => component.length > 1
    || graph.get(component[0])?.has(component[0]));
  for (const cycle of cycles) issues.push({ message: `flow "${flowId}" contains a cycle: ${cycle.join(" → ")}` });

  const indegree = new Map(values.map((step) => [step.id, 0]));
  for (const edge of edges) {
    if (indegree.has(edge.to) && indegree.has(edge.from)) indegree.set(edge.to, indegree.get(edge.to)! + 1);
  }
  const queue = values.filter((step) => indegree.get(step.id) === 0).map((step) => step.id);
  const ordered: string[] = [];
  while (queue.length > 0) {
    queue.sort((a, b) => insertionOrder.get(a)! - insertionOrder.get(b)!);
    const current = queue.shift()!;
    ordered.push(current);
    for (const target of graph.get(current) ?? []) {
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) queue.push(target);
    }
  }
  for (const step of values) if (!ordered.includes(step.id)) ordered.push(step.id);
  const byId = new Map(values.map((step) => [step.id, step]));
  return { steps: ordered.map((id) => byId.get(id)!), cycles };
}

export function buildFlows(args: {
  definitions: FlowDefinition[];
  annotations: ArchitectureAnnotation[];
  modules: ArchitectureModuleDefinition[];
}): { flows: FlowFact[]; issues: FlowBuildIssue[] } {
  const definitions = new Map(args.definitions.map((flow) => [flow.id, flow]));
  const modules = new Map(args.modules.map((module) => [module.id, module]));
  const issues: FlowBuildIssue[] = [];
  const discovered = new Map<string, Map<string, FlowStepFact[]>>();
  const invalidAttributes = new Map<string, string[]>();

  for (const annotation of args.annotations) {
    const flowId = annotation.attributes.flow;
    if (!flowId) continue;
    const definition = definitions.get(flowId);
    if (!definition) {
      issues.push({ message: `annotation references unknown flow "${flowId}"`, annotation });
      continue;
    }
    const stepId = annotation.attributes.step;
    if (!stepId) {
      issues.push({ message: `flow annotation for "${flowId}" has no step`, annotation });
      continue;
    }
    const moduleId = annotation.attributes.module ?? moduleForPath(annotation.source.path, args.modules);
    const zone = annotation.attributes.zone ?? modules.get(moduleId)?.zone ?? "unmapped";
    const attributeErrors: string[] = [];
    if (annotation.attributes.terminal !== undefined && !["true", "false"].includes(annotation.attributes.terminal)) {
      attributeErrors.push(`step "${stepId}" terminal must be true or false`);
    }
    if (definition.coverage?.mode === "critical-branches") {
      for (const attribute of ["condition", "outcome", "authority"] as const) {
        if (!annotation.attributes[attribute]) attributeErrors.push(`step "${stepId}" needs ${attribute} metadata`);
      }
    } else if (annotation.attributes.terminal === "true" && !annotation.attributes.outcome) {
      attributeErrors.push(`terminal step "${stepId}" needs an outcome`);
    }
    for (const message of attributeErrors) issues.push({ message: `flow "${flowId}" ${message}`, annotation });
    if (attributeErrors.length > 0) {
      invalidAttributes.set(flowId, [...(invalidAttributes.get(flowId) ?? []), ...attributeErrors]);
    }
    const step: FlowStepFact = {
      id: stepId,
      label: annotation.attributes.label ?? humanize(stepId),
      description: annotation.attributes.description,
      zone,
      module: moduleId,
      after: list(annotation.attributes.after),
      role: annotation.attributes.role,
      condition: annotation.attributes.condition,
      outcome: annotation.attributes.outcome,
      authority: annotation.attributes.authority,
      terminal: annotation.attributes.terminal === undefined ? undefined : annotation.attributes.terminal === "true",
      source: annotation.source,
      annotationId: annotation.id,
      anchorRequired: true,
      enforces: list(annotation.attributes.enforces),
    };
    const byStep = discovered.get(flowId) ?? new Map<string, FlowStepFact[]>();
    const values = byStep.get(stepId) ?? [];
    values.push(step);
    byStep.set(stepId, values);
    discovered.set(flowId, byStep);
  }

  const flows = args.definitions.map((definition): FlowFact => {
    const byStep = discovered.get(definition.id) ?? new Map<string, FlowStepFact[]>();
    const steps = new Map<string, FlowStepFact>();
    const missingAnchors: string[] = [];
    const duplicateAnchors: string[] = [];
    const missingPredecessors: Array<{ stepId: string; predecessorId: string }> = [];
    for (const seed of definition.entrySteps ?? []) {
      steps.set(seed.id, { ...seed, after: seed.after ?? [], enforces: [] });
      if (seed.anchorRequired === true && !seed.source) missingAnchors.push(seed.id);
    }
    for (const [stepId, candidates] of byStep) {
      if (candidates.length > 1) duplicateAnchors.push(stepId);
      const candidate = candidates[0];
      const seed = steps.get(stepId);
      steps.set(stepId, {
        ...seed,
        ...candidate,
        label: candidate.label || seed?.label || humanize(stepId),
        description: candidate.description ?? seed?.description,
        after: candidate.after?.length ? candidate.after : (seed?.after ?? []),
        condition: candidate.condition ?? seed?.condition,
        outcome: candidate.outcome ?? seed?.outcome,
        authority: candidate.authority ?? seed?.authority,
        terminal: candidate.terminal ?? seed?.terminal,
        enforces: [...new Set([...(seed?.enforces ?? []), ...candidate.enforces])],
      });
      const missingIndex = missingAnchors.indexOf(stepId);
      if (missingIndex >= 0) missingAnchors.splice(missingIndex, 1);
    }
    for (const step of steps.values()) {
      for (const predecessor of step.after ?? []) {
        if (!steps.has(predecessor)) {
          missingPredecessors.push({ stepId: step.id, predecessorId: predecessor });
          issues.push({ message: `flow "${definition.id}" step "${step.id}" follows missing step "${predecessor}"` });
        }
      }
    }
    const ordered = orderFlowSteps(definition.id, [...steps.values()], issues);
    return {
      ...definition,
      steps: ordered.steps,
      missingAnchors: missingAnchors.sort(),
      duplicateAnchors: duplicateAnchors.sort(),
      missingPredecessors,
      cycles: ordered.cycles,
      invalidAttributes: invalidAttributes.get(definition.id) ?? [],
    };
  });
  return { flows, issues };
}
