// indexing/go-callgraph-extractor/main.go
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"golang.org/x/tools/go/callgraph/cha"
	"golang.org/x/tools/go/callgraph/vta"
	"golang.org/x/tools/go/packages"
	"golang.org/x/tools/go/ssa"
	"golang.org/x/tools/go/ssa/ssautil"
)

type Symbol struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	File      string `json:"file"`
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
	Language  string `json:"language"`
}

type Edge struct {
	FromSymbolID string `json:"fromSymbolId"`
	ToSymbolID   string `json:"toSymbolId"`
	Kind         string `json:"kind"`
}

type Output struct {
	Symbols []Symbol `json:"symbols"`
	Edges   []Edge   `json:"edges"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: go-callgraph-extractor <module-dir>")
		os.Exit(1)
	}
	dir := os.Args[1]

	cfg := &packages.Config{
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedCompiledGoFiles |
			packages.NeedImports | packages.NeedDeps | packages.NeedTypes |
			packages.NeedSyntax | packages.NeedTypesInfo,
		Dir: dir,
	}
	pkgs, err := packages.Load(cfg, "./...")
	if err != nil {
		fmt.Fprintln(os.Stderr, "load error:", err)
		os.Exit(1)
	}
	if packages.PrintErrors(pkgs) > 0 {
		fmt.Fprintln(os.Stderr, "package errors above are non-fatal; continuing")
	}

	prog, _ := ssautil.AllPackages(pkgs, 0)
	prog.Build()

	// ssautil.AllFunctions returns every function reachable in the built SSA program,
	// which includes the full transitive dependency closure (stdlib, runtime internals,
	// etc.), not just the module we were asked to analyze. Restrict the symbol/edge
	// output to functions belonging to the packages actually loaded from the target
	// module, identified by import path.
	loadedPkgPaths := map[string]bool{}
	for _, p := range pkgs {
		loadedPkgPaths[p.PkgPath] = true
	}

	symbolsByFunc := map[*ssa.Function]string{}
	symbols := []Symbol{}
	fset := prog.Fset

	allFuncs := ssautil.AllFunctions(prog)

	for fn := range allFuncs {
		if fn == nil || fn.Syntax() == nil {
			continue
		}
		if fn.Pkg == nil || fn.Pkg.Pkg == nil || !loadedPkgPaths[fn.Pkg.Pkg.Path()] {
			continue
		}
		pos := fset.Position(fn.Pos())
		endPos := fset.Position(fn.Syntax().End())
		id := fmt.Sprintf("%s:%s:%d", pos.Filename, fn.Name(), pos.Line)
		kind := "function"
		if fn.Signature.Recv() != nil {
			kind = "method"
		}
		symbolsByFunc[fn] = id
		symbols = append(symbols, Symbol{
			ID: id, Name: fn.Name(), Kind: kind,
			File: pos.Filename, StartLine: pos.Line, EndLine: endPos.Line,
			Language: "go",
		})
	}

	// Vikunja dispatches nearly all of its permission checks through interfaces
	// (web.CRUDable / web.Rights), e.g. handler.DoDelete calls obj.CanDelete(...) on an
	// interface value. static.CallGraph only resolves *statically* dispatched calls, so
	// against the real codebase it reported ZERO callers for TaskAttachment.CanDelete and
	// only 3 callers across all 23 CanDelete implementations — useless for blast radius.
	//
	// VTA (variable type analysis), seeded with a CHA call graph, resolves interface
	// dispatch by tracking which concrete types can actually flow to each call site. On
	// the real Vikunja pkg/ tree it finds the true caller (handler.DoDelete) while staying
	// far more precise than CHA alone (~20k in-scope edges vs CHA's ~39k, which links every
	// interface call to every type implementing the method).
	cg := vta.CallGraph(allFuncs, cha.CallGraph(prog))
	edges := []Edge{}
	seen := map[Edge]bool{}
	for fn, node := range cg.Nodes {
		fromID, ok := symbolsByFunc[fn]
		if !ok {
			continue
		}
		for _, e := range node.Out {
			toID, ok := symbolsByFunc[e.Callee.Func]
			if !ok {
				continue
			}
			edge := Edge{FromSymbolID: fromID, ToSymbolID: toID, Kind: "calls"}
			if seen[edge] {
				continue
			}
			seen[edge] = true
			edges = append(edges, edge)
		}
	}

	if err := json.NewEncoder(os.Stdout).Encode(Output{Symbols: symbols, Edges: edges}); err != nil {
		fmt.Fprintln(os.Stderr, "encode error:", err)
		os.Exit(1)
	}
}
