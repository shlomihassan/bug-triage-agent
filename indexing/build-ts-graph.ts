// indexing/build-ts-graph.ts
import { Project, SyntaxKind, Node } from "ts-morph";
import { parse as parseVueSfc } from "@vue/compiler-sfc";
import { readFileSync } from "node:fs";
import type { Symbol, Edge } from "../agent/lib/code-intelligence-schema";

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
  return Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)
    ? (fn.getName() ?? "<anonymous>")
    : (fn.getParentIfKind(SyntaxKind.VariableDeclaration)?.getName() ?? "<anonymous>");
}

export function extractTsGraph(filePaths: string[]): { symbols: Symbol[]; edges: Edge[] } {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  const symbols: Symbol[] = [];
  const edges: Edge[] = [];

  // NOTE: this map is intentionally re-created for EVERY file (declared inside the loop
  // below, not hoisted above it). A single map shared across all files would key call
  // targets by bare function/method name only, so two files that each define a
  // same-named function (e.g. both export a `validate`) would silently let the second
  // file's symbol overwrite the first's in the map, producing edges that point at the
  // wrong file's symbol. Scoping the map per file means a call to `validate` inside
  // a.ts can only resolve to a.ts's own `validate`, never b.ts's.
  for (const filePath of filePaths) {
    const { content, lineOffset } = scriptContentOf(filePath);
    if (!content) continue;
    const language = languageForFile(filePath);
    const sourceFile = project.createSourceFile(`${filePath}.virtual.ts`, content, { overwrite: true });

    const fnLikeNodes = [
      ...sourceFile.getFunctions(),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction).filter((n) => Node.isVariableDeclaration(n.getParent())),
    ];

    const symbolIdByNameInFile = new Map<string, string>();

    for (const fn of fnLikeNodes) {
      const name = nameOf(fn);
      const startLine = fn.getStartLineNumber() + lineOffset;
      const endLine = fn.getEndLineNumber() + lineOffset;
      const id = `${filePath}:${name}:${startLine}`;
      symbolIdByNameInFile.set(name, id);
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

    for (const fn of fnLikeNodes) {
      const name = nameOf(fn);
      const fromId = symbolIdByNameInFile.get(name);
      if (!fromId) continue;
      const callExpressions = fn.getDescendantsOfKind(SyntaxKind.CallExpression);
      for (const call of callExpressions) {
        const calleeName = call.getExpression().getText();
        const toId = symbolIdByNameInFile.get(calleeName);
        if (!toId || toId === fromId) continue;
        edges.push({ fromSymbolId: fromId, toSymbolId: toId, kind: "calls" });
      }
    }

    project.removeSourceFile(sourceFile);
  }

  return { symbols, edges };
}
