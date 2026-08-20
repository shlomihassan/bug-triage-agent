import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTsGraph } from "../indexing/build-ts-graph";

describe("extractTsGraph", () => {
  it("extracts function symbols and call edges from a .ts file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-graph-test-"));
    const filePath = join(dir, "sample.ts");
    writeFileSync(
      filePath,
      `function helper(): number {\n  return 1;\n}\n\nfunction caller(): number {\n  return helper();\n}\n`,
    );

    const { symbols, edges } = extractTsGraph([filePath]);

    const names = symbols.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["helper", "caller"]));

    const callerSymbol = symbols.find((s) => s.name === "caller")!;
    const helperSymbol = symbols.find((s) => s.name === "helper")!;
    expect(edges).toContainEqual({
      fromSymbolId: callerSymbol.id,
      toSymbolId: helperSymbol.id,
      kind: "calls",
    });
  });

  it("extracts function symbols and call edges from a .js file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-graph-js-test-"));
    const filePath = join(dir, "sample.js");
    writeFileSync(
      filePath,
      "function helper() {\n  return 1;\n}\n\nfunction caller() {\n  return helper();\n}\n",
    );

    const { symbols, edges } = extractTsGraph([filePath]);

    const names = symbols.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["helper", "caller"]));

    const callerSymbol = symbols.find((s) => s.name === "caller")!;
    const helperSymbol = symbols.find((s) => s.name === "helper")!;
    expect(edges).toContainEqual({
      fromSymbolId: callerSymbol.id,
      toSymbolId: helperSymbol.id,
      kind: "calls",
    });
    // The Symbol.language enum (Task 1's schema) has no separate "javascript" value --
    // .js files are classified the same as .ts ("typescript") by languageForFile().
    expect(callerSymbol.language).toBe("typescript");
    expect(helperSymbol.language).toBe("typescript");
  });

  it("extracts a class method as a `method` symbol, called from another top-level function", () => {
    // Covers the MethodDeclaration extraction path, which had zero test coverage.
    // Note: call resolution only matches bare identifier call expressions
    // (`call.getExpression().getText()`), so a property/method-access call like
    // `g.greet()` does NOT produce a `calls` edge -- that's a known, accepted
    // limitation of this task's bare-name matching (not something this test asserts
    // against or that this task is fixing). This test only asserts that the method
    // SYMBOL itself is captured with the right shape.
    const dir = mkdtempSync(join(tmpdir(), "ts-graph-method-test-"));
    const filePath = join(dir, "sample.ts");
    writeFileSync(
      filePath,
      [
        "class Greeter {",
        "  greet(): string {",
        '    return "hi";',
        "  }",
        "}",
        "",
        "function run(): string {",
        "  const g = new Greeter();",
        "  return g.greet();",
        "}",
        "",
      ].join("\n"),
    );

    const { symbols, edges } = extractTsGraph([filePath]);

    const greetSymbol = symbols.find((s) => s.name === "greet");
    expect(greetSymbol).toBeDefined();
    expect(greetSymbol).toMatchObject({
      name: "greet",
      kind: "method",
      file: filePath,
      language: "typescript",
    });
    expect(greetSymbol!.startLine).toBeGreaterThan(0);
    expect(greetSymbol!.endLine).toBeGreaterThanOrEqual(greetSymbol!.startLine);

    const runSymbol = symbols.find((s) => s.name === "run");
    expect(runSymbol).toBeDefined();
    expect(runSymbol!.kind).toBe("function");

    // Expected/accepted: no edge for the `g.greet()` call, since it's not a bare
    // identifier call expression.
    expect(edges).not.toContainEqual(
      expect.objectContaining({ fromSymbolId: runSymbol!.id, toSymbolId: greetSymbol!.id }),
    );
  });

  it("extracts symbols from a .vue file's <script setup> block", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-graph-vue-test-"));
    const filePath = join(dir, "Sample.vue");
    writeFileSync(
      filePath,
      `<script setup lang="ts">\nfunction onClick(): void {\n  console.log("clicked");\n}\n</script>\n<template>\n  <button @click="onClick">Go</button>\n</template>\n`,
    );

    const { symbols } = extractTsGraph([filePath]);

    expect(symbols.map((s) => s.name)).toContain("onClick");
    expect(symbols[0].language).toBe("vue");
  });

  it("does not let a same-named function in a second file hijack the first file's call edges", () => {
    // Regression test for a symbol-scoping bug found in the Go equivalent extractor (Task 2):
    // if the name->id lookup used to resolve call targets is built globally across all files
    // instead of being scoped per file, two files that each define a function with the same
    // bare name (e.g. `validate`) can produce edges pointing at the WRONG file's symbol.
    const dir = mkdtempSync(join(tmpdir(), "ts-graph-collision-test-"));

    const fileAPath = join(dir, "a.ts");
    writeFileSync(
      fileAPath,
      [
        "export function validate(x: number): boolean {",
        "  return x > 0;",
        "}",
        "",
        "export function useA(): boolean {",
        "  return validate(1);",
        "}",
        "",
      ].join("\n"),
    );

    const fileBPath = join(dir, "b.ts");
    writeFileSync(
      fileBPath,
      [
        "export function validate(x: string): boolean {",
        "  return x.length > 0;",
        "}",
        "",
        "export function useB(): boolean {",
        "  return validate('x');",
        "}",
        "",
      ].join("\n"),
    );

    const { symbols, edges } = extractTsGraph([fileAPath, fileBPath]);

    const validateA = symbols.find((s) => s.name === "validate" && s.file === fileAPath)!;
    const validateB = symbols.find((s) => s.name === "validate" && s.file === fileBPath)!;
    const useA = symbols.find((s) => s.name === "useA")!;
    const useB = symbols.find((s) => s.name === "useB")!;

    expect(validateA).toBeDefined();
    expect(validateB).toBeDefined();
    expect(validateA.id).not.toBe(validateB.id);

    // useA (defined in a.ts) must call a.ts's validate, not b.ts's.
    expect(edges).toContainEqual({
      fromSymbolId: useA.id,
      toSymbolId: validateA.id,
      kind: "calls",
    });
    expect(edges).not.toContainEqual({
      fromSymbolId: useA.id,
      toSymbolId: validateB.id,
      kind: "calls",
    });

    // useB (defined in b.ts) must call b.ts's validate, not a.ts's.
    expect(edges).toContainEqual({
      fromSymbolId: useB.id,
      toSymbolId: validateB.id,
      kind: "calls",
    });
    expect(edges).not.toContainEqual({
      fromSymbolId: useB.id,
      toSymbolId: validateA.id,
      kind: "calls",
    });
  });

  it("does not create an order-dependent bogus edge when a call name only matches a symbol defined in a DIFFERENT file", () => {
    // This is the precise failure mode of a globally-scoped (not per-file-scoped) name->id
    // lookup map: if file A's `run()` calls something named `validateInput` that A itself
    // does NOT define, and an unrelated file B happens to define its own `validateInput`,
    // a global map would resolve A's call to B's symbol whenever B was processed before A
    // -- producing a false cross-file edge between two files with no import relationship,
    // and making the extractor's output depend on the order `filePaths` was passed in.
    // Confirmed against the brief's original draft (global map, symbol-build and
    // edge-resolution interleaved per file): passing [fileB, fileA] produced a bogus
    // `run -> validateInput` edge pointing into fileB, while [fileA, fileB] silently
    // dropped the call instead -- two different wrong answers depending only on order.
    // A correct extractor should never resolve a call to a symbol outside the file that
    // contains the call site (no import graph is tracked), regardless of file order.
    const dir = mkdtempSync(join(tmpdir(), "ts-graph-order-test-"));

    const fileAPath = join(dir, "a.ts");
    writeFileSync(
      fileAPath,
      [
        "function helper(): number { return 1; }",
        "function run(): number { return helper() + validateInput(5); }",
      ].join("\n"),
    );
    const fileBPath = join(dir, "b.ts");
    writeFileSync(fileBPath, "function validateInput(x: number): boolean { return x > 0; }\n");

    const resultAB = extractTsGraph([fileAPath, fileBPath]);
    const resultBA = extractTsGraph([fileBPath, fileAPath]);

    for (const { symbols, edges } of [resultAB, resultBA]) {
      const runSymbol = symbols.find((s) => s.name === "run")!;
      const helperSymbol = symbols.find((s) => s.name === "helper")!;
      const validateInputSymbol = symbols.find((s) => s.name === "validateInput")!;

      const edgesFromRun = edges.filter((e) => e.fromSymbolId === runSymbol.id);
      expect(edgesFromRun).toEqual([
        { fromSymbolId: runSymbol.id, toSymbolId: helperSymbol.id, kind: "calls" },
      ]);
      expect(edgesFromRun).not.toContainEqual({
        fromSymbolId: runSymbol.id,
        toSymbolId: validateInputSymbol.id,
        kind: "calls",
      });
    }
  });
});
