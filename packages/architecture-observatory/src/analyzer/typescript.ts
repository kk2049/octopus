import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import type {
  ArchitectureAnnotation,
  ArchitectureModuleDefinition,
  BackendModuleFact,
  CallFact,
  FileFact,
  FrontendModuleFact,
  ModuleContractFact,
  ModuleEcosystemFact,
  SourceLocation,
  SymbolFact,
} from "../shared/model.js";
import { parseArchitectureAnnotations } from "./annotations.js";
import { discoverBackendModules, discoverContracts, discoverFrontendModules } from "./module-ecosystem.js";
import { moduleForPath, normalizeRepoPath, packageForPath, relativeRepoPath, type WorkspacePackage } from "./paths.js";
import { formatScipSymbolLocator } from "../code-index/identity.js";

export interface ImportSite {
  sourcePath: string;
  specifier: string;
  line: number;
  typeOnly: boolean;
  dynamic: boolean;
}

export interface TypeScriptAnalysis {
  files: FileFact[];
  symbols: SymbolFact[];
  calls: CallFact[];
  annotations: ArchitectureAnnotation[];
  imports: ImportSite[];
  annotationErrors: Array<{ source: SourceLocation; message: string }>;
  frontendModules: FrontendModuleFact[];
  contractModules: ModuleContractFact[];
  backendModules: BackendModuleFact[];
  moduleDiscoveryIssues: ModuleEcosystemFact["issues"];
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export function discoverSourceFiles(root: string, sourceRoots: string[], excludes: string[] = []): string[] {
  const ignored = ["node_modules", "dist", ".git", ".generated", ".test-tmp", ...excludes];
  const isIgnored = (file: string): boolean => {
    const relative = normalizeRepoPath(path.relative(root, file));
    const segments = relative.split("/");
    return ignored.some((raw) => {
      const candidate = normalizeRepoPath(raw).replace(/^\/|\/$/g, "");
      return segments.includes(candidate) || relative === candidate || relative.startsWith(`${candidate}/`);
    });
  };
  const output = new Set<string>();
  for (const sourceRoot of sourceRoots) {
    const absolute = path.join(root, sourceRoot);
    if (!fs.existsSync(absolute)) continue;
    const stat = fs.statSync(absolute);
    if (stat.isFile()) {
      if (SOURCE_EXTENSIONS.includes(path.extname(absolute)) && !absolute.endsWith(".d.ts") && !isIgnored(absolute)) output.add(absolute);
      continue;
    }
    for (const file of ts.sys.readDirectory(absolute, SOURCE_EXTENSIONS, ignored, ["**/*"])) {
      if (!file.endsWith(".d.ts") && !isIgnored(file)) output.add(path.resolve(file));
    }
  }
  return [...output].sort();
}

function compilerOptions(root: string): ts.CompilerOptions {
  const configPath = path.join(root, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  const converted = ts.convertCompilerOptionsFromJson(read.config.compilerOptions ?? {}, root, configPath);
  if (converted.errors.length > 0) throw new Error(ts.formatDiagnostics(converted.errors, ts.createCompilerHost({})));
  return {
    ...converted.options,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
  };
}

export function codeLineCount(sourceText: string): number {
  // Keep this identical to capability-kernel's executable TCB budget. A second
  // counting dialect would make the review surface contradict the gate it explains.
  let count = 0;
  let inBlock = false;
  for (const raw of sourceText.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    if (line.startsWith("//") || line.startsWith("*")) continue;
    count += 1;
  }
  return count;
}

function excerpt(lines: string[], line: number, radius = 2): string[] {
  const start = Math.max(0, line - radius - 1);
  const end = Math.min(lines.length, line + radius);
  return lines.slice(start, end).map((text, index) => `${start + index + 1}: ${text}`);
}

function location(sourceFile: ts.SourceFile, node: ts.Node, filePath: string, lines: string[], symbol?: string): SourceLocation {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return { path: filePath, line: start, endLine: end, symbol, excerpt: excerpt(lines, start) };
}

function nodeName(node: ts.Node): string | null {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const named = node as ts.NamedDeclaration;
  if (!named.name) return null;
  if (ts.isIdentifier(named.name) || ts.isStringLiteral(named.name) || ts.isNumericLiteral(named.name)) return named.name.text;
  return named.name.getText();
}

function symbolKind(node: ts.Node): SymbolFact["kind"] | null {
  if (ts.isClassDeclaration(node) && node.name) return "class";
  if (ts.isFunctionDeclaration(node) && node.name && node.body) return "function";
  if (ts.isMethodDeclaration(node) && node.body) return "method";
  if ((ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.body) return "method";
  if (ts.isConstructorDeclaration(node) && node.body) return "constructor";
  if (ts.isVariableDeclaration(node) && node.name && node.initializer
    && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return "variable";
  if (ts.isPropertyDeclaration(node) && node.name && node.initializer
    && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return "method";
  return null;
}

function isExported(node: ts.Node): boolean {
  let candidate: ts.Node = node;
  if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)) candidate = node.parent.parent;
  return Boolean(ts.getCombinedModifierFlags(candidate as ts.Declaration) & ts.ModifierFlags.Export);
}

function enclosingClassName(node: ts.Node): string | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current) && current.name) return current.name.text;
    current = current.parent;
  }
  return null;
}

function complexityOf(node: ts.Node): number {
  if (ts.isClassDeclaration(node)) return 0;
  let score = 1;
  const root = node;
  const visit = (child: ts.Node): void => {
    if (child !== root && symbolKind(child)) return;
    if (
      ts.isIfStatement(child)
      || ts.isForStatement(child)
      || ts.isForInStatement(child)
      || ts.isForOfStatement(child)
      || ts.isWhileStatement(child)
      || ts.isDoStatement(child)
      || ts.isCaseClause(child)
      || ts.isCatchClause(child)
      || ts.isConditionalExpression(child)
    ) score += 1;
    if (ts.isBinaryExpression(child)
      && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(child.operatorToken.kind)) {
      score += 1;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return score;
}

function importSites(sourceFile: ts.SourceFile, filePath: string): ImportSite[] {
  const output: ImportSite[] = [];
  const add = (node: ts.Node, specifier: string, typeOnly: boolean, dynamic: boolean): void => {
    output.push({
      sourcePath: filePath,
      specifier,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      typeOnly,
      dynamic,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const allNamedTypeOnly = named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((item) => item.isTypeOnly);
      add(node, node.moduleSpecifier.text, Boolean(clause?.isTypeOnly || allNamedTypeOnly), false);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node, node.moduleSpecifier.text, node.isTypeOnly, false);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      add(node, node.arguments[0].text, false, true);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      add(node, node.argument.literal.text, true, false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return output;
}

function targetDeclaration(checker: ts.TypeChecker, expression: ts.Expression): ts.Declaration | undefined {
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

export function analyzeTypeScript(args: {
  root: string;
  sourceRoots: string[];
  repoSha: string;
  rootNames?: readonly string[];
  skipModuleDiscovery?: boolean;
  excludes?: string[];
  modules: ArchitectureModuleDefinition[];
  packages: WorkspacePackage[];
  git: Map<string, { touches: number; additions: number; deletions: number; lastChangedAt?: string }>;
}): TypeScriptAnalysis {
  const rootNames = (args.rootNames
    ? args.rootNames.map((file) => path.resolve(args.root, file))
    : discoverSourceFiles(args.root, args.sourceRoots, args.excludes)).sort();
  const rootNameSet = new Set(rootNames);
  const program = ts.createProgram({ rootNames, options: compilerOptions(args.root) });
  const checker = program.getTypeChecker();
  const files: FileFact[] = [];
  const symbols: SymbolFact[] = [];
  const imports: ImportSite[] = [];
  const annotations: ArchitectureAnnotation[] = [];
  const annotationErrors: TypeScriptAnalysis["annotationErrors"] = [];
  const symbolByNode = new Map<ts.Node, SymbolFact>();

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const absolute = path.resolve(sourceFile.fileName);
    if (!absolute.startsWith(path.resolve(args.root) + path.sep)) continue;
    const filePath = relativeRepoPath(args.root, absolute);
    if (!rootNameSet.has(absolute)) continue;
    const text = sourceFile.getFullText();
    const lines = text.split(/\r?\n/);
    const moduleId = moduleForPath(filePath, args.modules);
    const pkg = packageForPath(filePath, args.packages);
    const fileSymbols: SymbolFact[] = [];
    const ranges: Array<{ fact: SymbolFact; fullStart: number; end: number; startLine: number }> = [];

    const collect = (node: ts.Node): void => {
      const kind = symbolKind(node);
      const name = kind ? nodeName(node) : null;
      if (kind && name) {
        const className = enclosingClassName(node);
        const qualifiedName = className && kind !== "class" ? `${className}.${name}` : name;
        const source = location(sourceFile, node, filePath, lines, qualifiedName);
        const fact: SymbolFact = {
          id: formatScipSymbolLocator({ repoSha: args.repoSha, path: filePath, qualifiedName }),
          name,
          qualifiedName,
          kind,
          moduleId,
          fileId: filePath,
          source,
          exported: isExported(node),
          loc: Math.max(1, (source.endLine ?? source.line) - source.line + 1),
          complexity: complexityOf(node),
          annotations: [],
        };
        symbols.push(fact);
        fileSymbols.push(fact);
        symbolByNode.set(node, fact);
        ranges.push({
          fact,
          fullStart: node.getFullStart(),
          end: node.getEnd(),
          startLine: source.line,
        });
      }
      ts.forEachChild(node, collect);
    };
    collect(sourceFile);
    imports.push(...importSites(sourceFile, filePath));

    const parsed = parseArchitectureAnnotations(text, filePath, (line) => excerpt(lines, line));
    for (const annotation of parsed.annotations) {
      const position = sourceFile.getPositionOfLineAndCharacter(annotation.source.line - 1, 0);
      const containing = ranges
        .filter((range) => range.fullStart <= position && range.end >= position)
        .sort((a, b) => (a.end - a.fullStart) - (b.end - b.fullStart))[0];
      const nearest = containing ?? ranges
        .filter((range) => range.startLine >= annotation.source.line && range.startLine - annotation.source.line <= 12)
        .sort((a, b) => a.startLine - b.startLine)[0];
      if (nearest) {
        annotation.symbolId = nearest.fact.id;
        annotation.source.symbol = nearest.fact.qualifiedName;
        nearest.fact.annotations.push(annotation.id);
      }
      annotations.push(annotation);
    }
    annotationErrors.push(...parsed.errors.map((error) => ({
      source: { path: filePath, line: error.line, excerpt: excerpt(lines, error.line) },
      message: error.message,
    })));
    const git = args.git.get(filePath) ?? { touches: 0, additions: 0, deletions: 0 };
    files.push({
      id: filePath,
      path: filePath,
      moduleId,
      packageId: pkg?.id,
      isTest: /(?:^|\/)[^/]+\.(?:test|spec)\.[^.]+$/.test(filePath) || filePath.includes("/e2e/"),
      loc: lines.length,
      codeLoc: codeLineCount(text),
      git,
      declarationCount: fileSymbols.length,
      complexity: fileSymbols.reduce((sum, symbol) => sum + symbol.complexity, 0),
    });
  }

  const callMap = new Map<string, CallFact>();
  for (const sourceFile of program.getSourceFiles()) {
    const absolute = path.resolve(sourceFile.fileName);
    if (!absolute.startsWith(path.resolve(args.root) + path.sep) || sourceFile.isDeclarationFile) continue;
    let current: SymbolFact | undefined;
    const visit = (node: ts.Node): void => {
      const previous = current;
      const own = symbolByNode.get(node);
      if (own) current = own;
      if (current && (ts.isCallExpression(node) || ts.isNewExpression(node))) {
        const declaration = targetDeclaration(checker, node.expression);
        let candidate: ts.Node | undefined = declaration;
        while (candidate && !symbolByNode.has(candidate)) candidate = candidate.parent;
        const target = candidate ? symbolByNode.get(candidate) : undefined;
        if (target) {
          const key = `${current.id}->${target.id}`;
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          const sample = {
            path: current.source.path,
            line,
            symbol: current.qualifiedName,
            excerpt: excerpt(sourceFile.getFullText().split(/\r?\n/), line),
          };
          const existing = callMap.get(key);
          if (existing) {
            existing.count += 1;
            if (existing.samples.length < 3) existing.samples.push(sample);
          } else {
            callMap.set(key, { id: key, from: current.id, to: target.id, count: 1, samples: [sample] });
          }
        }
      }
      ts.forEachChild(node, visit);
      current = previous;
    };
    visit(sourceFile);
  }

  const discoveryArgs = {
    root: args.root,
    program,
    rootNames: new Set(rootNames.map((file) => path.resolve(file))),
    packages: args.packages,
  };
  const frontend = args.skipModuleDiscovery ? { modules: [], issues: [] } : discoverFrontendModules(discoveryArgs);
  const contracts = args.skipModuleDiscovery ? { contracts: [], issues: [] } : discoverContracts(discoveryArgs);
  const backend = args.skipModuleDiscovery ? { modules: [], issues: [] } : discoverBackendModules(discoveryArgs);

  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    symbols: symbols.sort((a, b) => a.id.localeCompare(b.id)),
    calls: [...callMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    annotations: annotations.sort((a, b) => a.id.localeCompare(b.id)),
    imports,
    annotationErrors,
    frontendModules: frontend.modules,
    contractModules: contracts.contracts,
    backendModules: backend.modules,
    moduleDiscoveryIssues: [...frontend.issues, ...contracts.issues, ...backend.issues],
  };
}
