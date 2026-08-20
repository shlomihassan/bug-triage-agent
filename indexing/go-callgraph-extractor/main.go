// indexing/go-callgraph-extractor/main.go
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"golang.org/x/tools/go/callgraph/static"
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

	for fn := range ssautil.AllFunctions(prog) {
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

	cg := static.CallGraph(prog)
	edges := []Edge{}
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
			edges = append(edges, Edge{FromSymbolID: fromID, ToSymbolID: toID, Kind: "calls"})
		}
	}

	if err := json.NewEncoder(os.Stdout).Encode(Output{Symbols: symbols, Edges: edges}); err != nil {
		fmt.Fprintln(os.Stderr, "encode error:", err)
		os.Exit(1)
	}
}
