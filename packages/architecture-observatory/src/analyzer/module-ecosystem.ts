import path from "node:path";
import ts from "typescript";

import type {
  BackendModuleFact,
  FrontendModuleFact,
  ModuleContractFact,
  ModuleEcosystemFact,
  SourceLocation,
} from "../shared/model.js";
import { packageForPath, relativeRepoPath, type WorkspacePackage } from "./paths.js";

interface StaticString {
  value: string;
  /** The declaration that supplied the value, used to identify a typed port's package. */
  declaration?: ts.Declaration;
}

export interface FrontendModuleDiscovery {
  modules: FrontendModuleFact[];
  issues: ModuleEcosystemFact["issues"];
}

export interface ContractDiscovery {
  contracts: ModuleContractFact[];
  issues: ModuleEcosystemFact["issues"];
}

export interface BackendModuleDiscovery {
  modules: BackendModuleFact[];
  issues: ModuleEcosystemFact["issues"];
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  if (
    ts.isCallExpression(current)
    && current.arguments.length === 1
    && ts.isPropertyAccessExpression(current.expression)
    && ts.isIdentifier(current.expression.expression)
    && current.expression.expression.text === "Object"
    && current.expression.name.text === "freeze"
  ) {
    return unwrapExpression(current.arguments[0]);
  }
  return current;
}

function valueDeclaration(checker: ts.TypeChecker, expression: ts.Expression): ts.Declaration | undefined {
  const token = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
  let symbol = checker.getSymbolAtLocation(token);
  if (!symbol) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      return undefined;
    }
  }
  return symbol.valueDeclaration ?? symbol.declarations?.[0];
}

function staticString(
  checker: ts.TypeChecker,
  input: ts.Expression,
  seen = new Set<ts.Declaration>(),
): StaticString | null {
  const expression = unwrapExpression(input);
  if (ts.isStringLiteralLike(expression)) return { value: expression.text };
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const part = staticString(checker, span.expression, seen);
      if (!part) return null;
      value += part.value + span.literal.text;
    }
    return { value };
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(checker, expression.left, seen);
    const right = staticString(checker, expression.right, seen);
    return left && right ? { value: left.value + right.value } : null;
  }
  if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) return null;
  const declaration = valueDeclaration(checker, expression);
  if (!declaration || seen.has(declaration)) return null;
  seen.add(declaration);
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const resolved = staticString(checker, declaration.initializer, seen);
    return resolved ? { value: resolved.value, declaration } : null;
  }
  if (ts.isPropertyAssignment(declaration)) {
    const resolved = staticString(checker, declaration.initializer, seen);
    return resolved ? { value: resolved.value, declaration } : null;
  }
  return null;
}

function staticStringArray(
  checker: ts.TypeChecker,
  input: ts.Expression,
  seen = new Set<ts.Declaration>(),
): StaticString[] | null {
  const expression = unwrapExpression(input);
  if (ts.isArrayLiteralExpression(expression)) {
    const values: StaticString[] = [];
    for (const element of expression.elements) {
      if (!ts.isExpression(element)) return null;
      const value = staticString(checker, element, new Set(seen));
      if (!value) return null;
      values.push(value);
    }
    return values;
  }
  if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) return null;
  const declaration = valueDeclaration(checker, expression);
  if (!declaration || seen.has(declaration)) return null;
  seen.add(declaration);
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    return staticStringArray(checker, declaration.initializer, seen);
  }
  return null;
}

function propertyName(name: ts.PropertyName): string {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : name.getText();
}

function objectExpression(
  checker: ts.TypeChecker,
  input: ts.Expression,
  seen = new Set<ts.Declaration>(),
): ts.ObjectLiteralExpression | null {
  const expression = unwrapExpression(input);
  if (ts.isObjectLiteralExpression(expression)) return expression;
  if (ts.isCallExpression(expression) && expression.arguments.length > 0) {
    const callee = ts.isIdentifier(expression.expression) ? expression.expression.text : "";
    if (callee === "declareContract" && ts.isExpression(expression.arguments[0])) {
      return objectExpression(checker, expression.arguments[0], seen);
    }
  }
  if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) return null;
  const declaration = valueDeclaration(checker, expression);
  if (!declaration || seen.has(declaration)) return null;
  seen.add(declaration);
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    return objectExpression(checker, declaration.initializer, seen);
  }
  if (ts.isPropertyAssignment(declaration)) return objectExpression(checker, declaration.initializer, seen);
  return null;
}

function property(
  checker: ts.TypeChecker,
  object: ts.ObjectLiteralExpression,
  name: string,
  seen = new Set<ts.ObjectLiteralExpression>(),
): ts.Expression | undefined {
  if (seen.has(object)) return undefined;
  seen.add(object);
  for (const member of object.properties) {
    if (ts.isPropertyAssignment(member) && propertyName(member.name) === name) return member.initializer;
  }
  for (const member of [...object.properties].reverse()) {
    if (!ts.isSpreadAssignment(member)) continue;
    const inherited = objectExpression(checker, member.expression);
    if (!inherited) continue;
    const value = property(checker, inherited, name, seen);
    if (value) return value;
  }
  return undefined;
}

function objectKeys(checker: ts.TypeChecker, input: ts.Expression | undefined): string[] {
  if (!input) return [];
  const object = objectExpression(checker, input);
  if (!object) return [];
  const keys = new Set<string>();
  for (const member of object.properties) {
    if (ts.isPropertyAssignment(member) || ts.isMethodDeclaration(member) || ts.isShorthandPropertyAssignment(member)) {
      keys.add(propertyName(member.name));
    } else if (ts.isSpreadAssignment(member)) {
      for (const key of objectKeys(checker, member.expression)) keys.add(key);
    }
  }
  return [...keys].sort();
}

function namesType(type: ts.TypeNode | undefined, expected: string): boolean {
  if (!type) return false;
  return type.getText().replace(/<.*$/, "").split(".").at(-1) === expected;
}

function isExported(node: { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function manifestDeclaration(declaration: ts.VariableDeclaration): boolean {
  const statement = declaration.parent.parent;
  if (!ts.isVariableStatement(statement) || !isExported(statement)) return false;
  if (namesType(declaration.type, "AgentModuleManifest")) return true;
  let initializer = declaration.initializer;
  while (initializer && (ts.isParenthesizedExpression(initializer) || ts.isAsExpression(initializer))) {
    initializer = initializer.expression;
  }
  return Boolean(initializer && ts.isSatisfiesExpression(initializer) && namesType(initializer.type, "AgentModuleManifest"));
}

function sourceLocation(root: string, sourceFile: ts.SourceFile, node: ts.Node): SourceLocation {
  return {
    path: relativeRepoPath(root, sourceFile.fileName),
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
  };
}

function packageOfDeclaration(
  root: string,
  declaration: ts.Declaration | undefined,
  packages: WorkspacePackage[],
): WorkspacePackage | undefined {
  if (!declaration) return undefined;
  return packageForPath(relativeRepoPath(root, declaration.getSourceFile().fileName), packages);
}

const SLOT_LABEL: Readonly<Record<string, string>> = {
  navigation: "导航区",
  primary: "主工作区",
  secondary: "辅助工作区",
  bottom: "底部状态区",
  overlay: "浮层工作区",
};

function frontendSummary(title: string, slots: string[], opens: string[]): string {
  const placement = slots.map((slot) => SLOT_LABEL[slot] ?? slot).join("、");
  if (opens.length > 0) {
    return `用于打开 ${opens.join("、")} 资源的「${title}」视图，可放在${placement || "工作区"}。`;
  }
  return `提供「${title}」交互视图，可组合到${placement || "工作区"}。`;
}

function previewKind(input: { id: string; title: string; opens: string[] }): FrontendModuleFact["preview"] {
  const words = `${input.id} ${input.title} ${input.opens.join(" ")}`.toLowerCase();
  if (/search|搜索/.test(words)) return "search";
  if (/chat|会话正文|聊天/.test(words)) return "chat";
  if (/form|session\.new|启动|表单/.test(words)) return "form";
  if (/board|grid|盘面|棋/.test(words)) return "board";
  if (/deck\.slide|幻灯片编辑/.test(words)) return "slides";
  if (/editor|file-viewer|crdt\.note|deck\.typst|文件内容|编辑器|源码|协作文档/.test(words)) return "document";
  if (/roster|tree|list|outline|directory|doc-list|工作区文件|目录|列表|大纲|会话/.test(words)) return "tree";
  if (/detail|详情/.test(words)) return "detail";
  if (/operation|status|状态/.test(words)) return "status";
  return "panel";
}

function isSourceCandidate(root: string, rootNames: ReadonlySet<string>, sourceFile: ts.SourceFile): boolean {
  const absolute = path.resolve(sourceFile.fileName);
  if (sourceFile.isDeclarationFile || !rootNames.has(absolute)) return false;
  const filePath = relativeRepoPath(root, absolute);
  return !/(?:^|\/)[^/]+\.(?:test|spec)\.[^.]+$/.test(filePath) && !filePath.includes("/e2e/");
}

/** Discover browser contributions from the existing AgentModuleManifest source of truth. */
export function discoverFrontendModules(args: {
  root: string;
  program: ts.Program;
  rootNames: ReadonlySet<string>;
  packages: WorkspacePackage[];
}): FrontendModuleDiscovery {
  const checker = args.program.getTypeChecker();
  const modules: FrontendModuleFact[] = [];
  const issues: ModuleEcosystemFact["issues"] = [];

  for (const sourceFile of args.program.getSourceFiles()) {
    if (!isSourceCandidate(args.root, args.rootNames, sourceFile)) continue;
    const filePath = relativeRepoPath(args.root, sourceFile.fileName);
    const pkg = packageForPath(filePath, args.packages);

    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && manifestDeclaration(node)) {
        const source = sourceLocation(args.root, sourceFile, node);
        const expression = node.initializer ? objectExpression(checker, node.initializer) : null;
        if (!pkg || !expression) {
          issues.push({ message: "AgentModuleManifest 不是可静态读取的对象字面量", source });
          ts.forEachChild(node, visit);
          return;
        }
        const readString = (name: string): string | null => {
          const value = property(checker, expression, name);
          return value ? staticString(checker, value)?.value ?? null : null;
        };
        const readArray = (name: string): StaticString[] | null => {
          const value = property(checker, expression, name);
          return value ? staticStringArray(checker, value) : null;
        };
        const id = readString("id");
        const title = readString("title");
        const version = readString("version");
        const implementation = readString("implementation");
        const slots = readArray("slots");
        const ports = readArray("ports");
        const opens = readArray("opens");
        if (!id || !title || !version || !implementation || !slots || !ports || !opens) {
          const name = ts.isIdentifier(node.name) ? node.name.text : "<anonymous>";
          issues.push({ message: `无法静态读取前端模组 ${name} 的必需字段`, source });
        } else {
          const slotIds = slots.map((entry) => entry.value);
          const openKinds = opens.map((entry) => entry.value);
          modules.push({
            id,
            title,
            version,
            implementation,
            packageId: pkg.id,
            packagePath: pkg.path,
            slots: slotIds,
            ports: ports.map((entry) => ({
              id: entry.value,
              ...(packageOfDeclaration(args.root, entry.declaration, args.packages)?.id
                ? { packageId: packageOfDeclaration(args.root, entry.declaration, args.packages)!.id }
                : {}),
            })),
            opens: openKinds,
            summary: frontendSummary(title, slotIds, openKinds),
            preview: previewKind({ id, title, opens: openKinds }),
            configKeys: objectKeys(checker, property(checker, expression, "config")),
            source,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const seen = new Map<string, FrontendModuleFact>();
  for (const module of modules) {
    const previous = seen.get(module.id);
    if (previous) {
      issues.push({
        message: `前端模组 id ${module.id} 同时由 ${previous.packageId} 与 ${module.packageId} 声明`,
        source: module.source,
      });
    } else {
      seen.set(module.id, module);
    }
  }
  return {
    modules: modules.sort((a, b) => a.packageId.localeCompare(b.packageId) || a.id.localeCompare(b.id)),
    issues,
  };
}

function contractDeclaration(declaration: ts.VariableDeclaration): boolean {
  const statement = declaration.parent.parent;
  if (!ts.isVariableStatement(statement) || !isExported(statement)) return false;
  if (namesType(declaration.type, "ContractDeclaration")) return true;
  return ts.isIdentifier(declaration.name) && declaration.name.text.endsWith("_DECLARATION");
}

function contractActions(checker: ts.TypeChecker, expression: ts.Expression | undefined): ModuleContractFact["actions"] {
  if (!expression) return [];
  const object = objectExpression(checker, expression);
  if (!object) return [];
  const actions: ModuleContractFact["actions"] = [];
  for (const member of object.properties) {
    if (!ts.isPropertyAssignment(member)) continue;
    const spec = objectExpression(checker, member.initializer);
    if (!spec) continue;
    const summaryExpression = property(checker, spec, "summary");
    const operationExpression = property(checker, spec, "operation");
    const summary = summaryExpression ? staticString(checker, summaryExpression)?.value : undefined;
    const operation = operationExpression ? staticString(checker, operationExpression)?.value : undefined;
    actions.push({
      id: propertyName(member.name),
      summary: summary ?? "该动作尚无可静态读取的中文说明。",
      ...(operation ? { operation } : {}),
    });
  }
  return actions;
}

/** Discover typed contract descriptions and action vocabularies from declareContract data. */
export function discoverContracts(args: {
  root: string;
  program: ts.Program;
  rootNames: ReadonlySet<string>;
  packages: WorkspacePackage[];
}): ContractDiscovery {
  const checker = args.program.getTypeChecker();
  const contracts: ModuleContractFact[] = [];
  const issues: ModuleEcosystemFact["issues"] = [];
  for (const sourceFile of args.program.getSourceFiles()) {
    if (!isSourceCandidate(args.root, args.rootNames, sourceFile)) continue;
    const pkg = packageForPath(relativeRepoPath(args.root, sourceFile.fileName), args.packages);
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && contractDeclaration(node) && node.initializer) {
        const source = sourceLocation(args.root, sourceFile, node);
        const object = objectExpression(checker, node.initializer);
        const idExpression = object ? property(checker, object, "contract") : undefined;
        const summaryExpression = object ? property(checker, object, "summary") : undefined;
        const id = idExpression ? staticString(checker, idExpression)?.value : undefined;
        if (id) {
          contracts.push({
            id,
            ...(pkg ? { packageId: pkg.id, packagePath: pkg.path } : {}),
            summary: summaryExpression
              ? staticString(checker, summaryExpression)?.value ?? "该契约尚无可静态读取的中文说明。"
              : "该契约尚无可静态读取的中文说明。",
            actions: contractActions(checker, object ? property(checker, object, "actions") : undefined),
            source,
            provision: "app-or-host",
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  const byId = new Map<string, ModuleContractFact>();
  for (const contract of contracts) {
    const prior = byId.get(contract.id);
    if (!prior || contract.actions.length > prior.actions.length || contract.summary.length > prior.summary.length) {
      byId.set(contract.id, contract);
    }
  }
  return { contracts: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), issues };
}

const CONTRACT_ID = /^[a-z][a-z0-9.-]*\/v[0-9]+$/;

function providerContracts(checker: ts.TypeChecker, declaration: ts.FunctionDeclaration): string[] {
  const values = new Set<string>();
  const inspect = (expression: ts.Expression): void => {
    const object = objectExpression(checker, expression);
    if (object) {
      const contract = property(checker, object, "contract");
      const value = contract ? staticString(checker, contract)?.value : undefined;
      if (value && CONTRACT_ID.test(value)) values.add(value);
      return;
    }
    const current = unwrapExpression(expression);
    if (ts.isCallExpression(current)) {
      for (const argument of current.arguments) {
        if (!ts.isExpression(argument)) continue;
        const value = staticString(checker, argument)?.value;
        if (value && CONTRACT_ID.test(value)) values.add(value);
      }
    }
  };
  if (declaration.body) {
    const visit = (node: ts.Node): void => {
      if (ts.isReturnStatement(node) && node.expression) inspect(node.expression);
      ts.forEachChild(node, visit);
    };
    visit(declaration.body);
  }
  return [...values].sort();
}

function functionIdentity(declaration: ts.FunctionDeclaration): string {
  return `${declaration.getSourceFile().fileName}:${declaration.pos}`;
}

/** Discover exported trusted Provider factories and whether production composition registers them. */
export function discoverBackendModules(args: {
  root: string;
  program: ts.Program;
  rootNames: ReadonlySet<string>;
  packages: WorkspacePackage[];
}): BackendModuleDiscovery {
  const checker = args.program.getTypeChecker();
  const issues: ModuleEcosystemFact["issues"] = [];
  const byDeclaration = new Map<string, BackendModuleFact[]>();
  for (const sourceFile of args.program.getSourceFiles()) {
    if (!isSourceCandidate(args.root, args.rootNames, sourceFile)) continue;
    const pkg = packageForPath(relativeRepoPath(args.root, sourceFile.fileName), args.packages);
    const visit = (node: ts.Node): void => {
      if (
        ts.isFunctionDeclaration(node)
        && node.name
        && isExported(node)
        && namesType(node.type, "ResourceProviderDefinition")
      ) {
        const source = sourceLocation(args.root, sourceFile, node);
        const contracts = providerContracts(checker, node);
        if (!pkg || contracts.length === 0) {
          issues.push({ message: `无法静态读取 Provider factory ${node.name.text} 的 contract`, source });
        } else {
          const lines = sourceFile.getLineAndCharacterOfPosition(sourceFile.getEnd()).line + 1;
          byDeclaration.set(functionIdentity(node), contracts.map((contract) => ({
            id: `${pkg.id}#${node.name!.text}:${contract}`,
            name: node.name!.text,
            summary: `为 ${contract} 提供可信后端实现；由部署显式注册并封存。`,
            packageId: pkg.id,
            path: source.path,
            files: 1,
            loc: lines,
            kind: "provider",
            contracts: [contract],
            actions: [],
            registered: false,
            dependencies: [],
            source,
          })));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  for (const sourceFile of args.program.getSourceFiles()) {
    if (!isSourceCandidate(args.root, args.rootNames, sourceFile)) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "register"
        && node.arguments.length > 0
      ) {
        const argument = unwrapExpression(node.arguments[0]);
        if (ts.isCallExpression(argument)) {
          const declaration = valueDeclaration(checker, argument.expression);
          if (declaration && ts.isFunctionDeclaration(declaration)) {
            for (const module of byDeclaration.get(functionIdentity(declaration)) ?? []) module.registered = true;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return {
    modules: [...byDeclaration.values()].flat().sort((a, b) => a.id.localeCompare(b.id)),
    issues,
  };
}

function frontendNodeId(module: FrontendModuleFact): string {
  return `frontend:${module.packageId}:${module.id}`;
}

function contractNodeId(contractId: string): string {
  return `contract:${contractId}`;
}

function backendNodeId(providerId: string): string {
  return `backend:${providerId}`;
}

/** Build the semantic ecosystem graph. Raw package imports are intentionally excluded. */
export function buildModuleEcosystem(discovery: {
  frontend: FrontendModuleDiscovery;
  contracts: ContractDiscovery;
  backend: BackendModuleDiscovery;
}): ModuleEcosystemFact {
  const contractById = new Map(discovery.contracts.contracts.map((contract) => [contract.id, { ...contract }]));
  const portPackages = new Map<string, { id?: string; path?: string }>();
  for (const module of discovery.frontend.modules) {
    for (const port of module.ports) {
      if (!portPackages.has(port.id)) portPackages.set(port.id, { id: port.packageId });
    }
  }
  for (const provider of discovery.backend.modules) {
    for (const contract of provider.contracts) if (!portPackages.has(contract)) portPackages.set(contract, {});
  }
  for (const [id, provenance] of portPackages) {
    if (contractById.has(id)) continue;
    contractById.set(id, {
      id,
      ...(provenance.id ? { packageId: provenance.id } : {}),
      summary: "这是前端声明需要的版本化类型接口；当前源码没有可静态读取的契约摘要。",
      actions: [],
      provision: "app-or-host",
    });
  }

  const providers = discovery.backend.modules.map((provider): BackendModuleFact => {
    const contracts = provider.contracts.map((id) => contractById.get(id)).filter((row): row is ModuleContractFact => Boolean(row));
    const actions = contracts.flatMap((contract) => contract.actions);
    const summary = contracts[0]?.summary
      ? `可信后端：${contracts[0].summary}`
      : provider.summary;
    return { ...provider, summary, actions };
  });
  const providerContracts = new Set(providers.flatMap((provider) => provider.contracts));
  const contracts = [...contractById.values()]
    .map((contract): ModuleContractFact => ({
      ...contract,
      provision: providerContracts.has(contract.id) ? "trusted-provider" : "app-or-host",
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const dependencies: ModuleEcosystemFact["dependencies"] = [];
  const dedupe = new Set<string>();
  const add = (edge: ModuleEcosystemFact["dependencies"][number]): void => {
    const key = `${edge.kind}\0${edge.from}\0${edge.to}\0${edge.label}`;
    if (!dedupe.has(key)) {
      dedupe.add(key);
      dependencies.push(edge);
    }
  };
  for (const module of discovery.frontend.modules) {
    for (const port of module.ports) {
      add({ from: frontendNodeId(module), to: contractNodeId(port.id), kind: "requires", label: port.id });
    }
  }
  for (const provider of providers) {
    for (const contract of provider.contracts) {
      add({ from: contractNodeId(contract), to: backendNodeId(provider.id), kind: "provides", label: "可信实现" });
    }
    for (const dependency of provider.dependencies) {
      add({ from: backendNodeId(provider.id), to: backendNodeId(dependency), kind: "provider", label: "Provider 依赖" });
    }
  }

  return {
    frontend: discovery.frontend.modules,
    contracts,
    backend: providers,
    dependencies: dependencies.sort((a, b) =>
      a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.label.localeCompare(b.label)),
    issues: [...discovery.frontend.issues, ...discovery.contracts.issues, ...discovery.backend.issues],
  };
}
