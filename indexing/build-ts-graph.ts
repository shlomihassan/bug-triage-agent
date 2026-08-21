// indexing/build-ts-graph.ts
import { Project, SyntaxKind, Node } from "ts-morph";
import { parse as parseVueSfc } from "@vue/compiler-sfc";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Symbol, Edge } from "../agent/lib/code-intelligence-schema";

export interface TsGraphOptions {
  /**
   * Bundler path-alias prefixes to resolve, mapping the alias to an absolute directory —
   * e.g. `{ "@/": "/abs/path/frontend/src/" }` for Vikunja's Vite `@ -> src` alias.
   * Specifiers that match no alias and are not relative are treated as third-party and
   * ignored.
   */
  aliases?: Record<string, string>;
}

/** Extensions Vite resolves for an extensionless import, in its own precedence order. */
const RESOLVE_EXTENSIONS = [".ts", ".vue", ".js", ".mjs", ".tsx", ".jsx"];

function resolveImportPath(
  specifier: string,
  importerFile: string,
  aliases: Record<string, string>,
  knownFiles: Set<string>,
): string | undefined {
  let base: string;
  if (specifier.startsWith(".")) {
    base = resolve(dirname(importerFile), specifier);
  } else {
    const alias = Object.keys(aliases).find((a) => specifier.startsWith(a));
    if (!alias) return undefined; // third-party module — not part of the indexed tree
    base = resolve(aliases[alias], specifier.slice(alias.length));
  }
  const candidates = [
    base,
    ...RESOLVE_EXTENSIONS.map((ext) => base + ext),
    ...RESOLVE_EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ];
  return candidates.find((c) => knownFiles.has(c));
}

interface FileFacts {
  /** Local name at the call site -> the name it was exported under in its own file. */
  importedNames: Map<string, { exportedName: string; specifier: string }>;
  symbolIdByName: Map<string, string>;
  calls: Array<{ fromId: string; calleeName: string }>;
}

function languageForFile(filePath: string): "typescript" | "vue" {
  return filePath.endsWith(".vue") ? "vue" : "typescript";
}

function scriptContentOf(filePath: string): { content: string; lineOffset: number } {
  if (!filePath.endsWith(".vue")) {
    return { content: readFileSync(filePath, "utf8"), lineOffset: 0 };
  }
  const source = readFileSync(filePath, "utf8");
  const { descriptor } = parseVueSfc(source);
  const block = descriptor.scriptSetup ?? descriptor.script;
  if (!block) return { content: "", lineOffset: 0 };
  const lineOffset = source.slice(0, block.loc.start.offset).split("\n").length - 1;
  return { content: block.content, lineOffset };
}

function nameOf(fn: Node): string {
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) return fn.getName() ?? "<anonymous>";
  const variable = fn.getParentIfKind(SyntaxKind.VariableDeclaration);
  if (variable) return variable.getName();
  // `props: route => (...)` — an arrow assigned to an object property. Vikunja's router
  // and store definitions put real logic in this position, so these need names and
  // symbols too, otherwise any call inside them has no enclosing symbol to be an edge
  // from. (This is exactly why getNextWeekDate's only caller was invisible: the call sits
  // inside a `props:` arrow in router/index.ts.)
  const property = fn.getParentIfKind(SyntaxKind.PropertyAssignment);
  if (property) return property.getName();
  return "<anonymous>";
}

export function extractTsGraph(
  filePaths: string[],
  options: TsGraphOptions = {},
): { symbols: Symbol[]; edges: Edge[] } {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  const symbols: Symbol[] = [];
  const aliases = options.aliases ?? {};
  const knownFiles = new Set(filePaths);
  const factsByFile = new Map<string, FileFacts>();

  // Pass 1: parse each file once, recording its own symbols, its imports, and its
  // unresolved call sites. Resolution is deliberately deferred to pass 2 so that it can
  // never depend on the order files were passed in.
  for (const filePath of filePaths) {
    const { content, lineOffset } = scriptContentOf(filePath);
    if (!content) continue;
    const language = languageForFile(filePath);
    const sourceFile = project.createSourceFile(`${filePath}.virtual.ts`, content, { overwrite: true });

    const isNamedPosition = (n: Node) =>
      Node.isVariableDeclaration(n.getParent()) || Node.isPropertyAssignment(n.getParent());
    const fnLikeNodes = [
      ...sourceFile.getFunctions(),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction).filter(isNamedPosition),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression).filter(isNamedPosition),
    ];

    const symbolIdByName = new Map<string, string>();
    // Identity-keyed, so a call site's OWN enclosing function is always the edge source.
    // Looking the source up by name instead was silently wrong whenever a file declared
    // the same name more than once — every `props:` arrow in router/index.ts collapsed
    // onto whichever one happened to be declared last, so edges were reported against a
    // function hundreds of lines away from the actual call.
    const idByNode = new Map<Node, string>();

    for (const fn of fnLikeNodes) {
      const name = nameOf(fn);
      const startLine = fn.getStartLineNumber() + lineOffset;
      const endLine = fn.getEndLineNumber() + lineOffset;
      const id = `${filePath}:${name}:${startLine}`;
      symbolIdByName.set(name, id);
      idByNode.set(fn, id);
      symbols.push({
        id,
        name,
        kind: Node.isMethodDeclaration(fn) ? "method" : "function",
        file: filePath,
        startLine,
        endLine,
        language,
      });
    }

    const importedNames = new Map<string, { exportedName: string; specifier: string }>();
    for (const decl of sourceFile.getImportDeclarations()) {
      const specifier = decl.getModuleSpecifierValue();
      for (const named of decl.getNamedImports()) {
        const exportedName = named.getName();
        // `import {a as b}` is called as `b()` locally but declared as `a` over there.
        importedNames.set(named.getAliasNode()?.getText() ?? exportedName, { exportedName, specifier });
      }
      const defaultImport = decl.getDefaultImport();
      if (defaultImport) {
        importedNames.set(defaultImport.getText(), { exportedName: "default", specifier });
      }
    }

    const calls: Array<{ fromId: string; calleeName: string }> = [];
    for (const fn of fnLikeNodes) {
      const fromId = idByNode.get(fn);
      if (!fromId) continue;
      for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        calls.push({ fromId, calleeName: call.getExpression().getText() });
      }
    }

    factsByFile.set(filePath, { importedNames, symbolIdByName, calls });
    project.removeSourceFile(sourceFile);
  }

  // Pass 2: resolve each call site.
  //
  // A call is resolved ONLY against symbols the call site can actually see: the ones its
  // own file defines, or the ones it explicitly imports. It is never resolved by bare name
  // against a global index — two files that each define their own `validate` must not have
  // their edges cross, and a call to a name this file neither defines nor imports must
  // stay unresolved rather than latch onto some unrelated file that happens to export that
  // name. (Both failure modes were real regressions in earlier drafts of this extractor.)
  //
  // Following imports matters: without it, the extractor found only intra-file edges, so
  // e.g. `getNextWeekDate` — which has exactly one caller, in a different file — looked
  // like dead code with zero callers, which is precisely the wrong answer for a
  // blast-radius query.
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const [filePath, facts] of factsByFile) {
    for (const { fromId, calleeName } of facts.calls) {
      let toId = facts.symbolIdByName.get(calleeName);
      if (!toId) {
        const imported = facts.importedNames.get(calleeName);
        if (!imported) continue;
        const targetFile = resolveImportPath(imported.specifier, filePath, aliases, knownFiles);
        if (!targetFile) continue;
        toId = factsByFile.get(targetFile)?.symbolIdByName.get(imported.exportedName);
      }
      if (!toId || toId === fromId) continue;
      const key = `${fromId} ${toId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ fromSymbolId: fromId, toSymbolId: toId, kind: "calls" });
    }
  }

  return { symbols, edges };
}
