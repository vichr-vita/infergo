// Command infergen generates typed evaluators from named Go rule functions.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/vichr-vita/infergo/internal/generate"
)

func main() {
	rules := flag.String("rules", "", "comma-separated Go rule files in the current package")
	inputs := flag.String("inputs", "Inputs", "external input struct type")
	outputs := flag.String("outputs", "Outputs", "requested output struct type")
	out := flag.String("out", "zz_infergo_gen.go", "generated Go file")
	flag.Parse()
	if *rules == "" || flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "usage: infergen -rules bonus.go [-inputs Inputs] [-outputs Outputs] [-out zz_infergo_gen.go]")
		os.Exit(2)
	}
	files := strings.Split(*rules, ",")
	for i := range files {
		files[i] = strings.TrimSpace(files[i])
	}
	source, err := generate.Generate(generate.Config{
		Dir: ".", RuleFiles: files, Inputs: *inputs, Outputs: *outputs, OutputFile: *out,
	})
	if err == nil {
		err = writeFile(*out, source)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "infergen:", err)
		os.Exit(1)
	}
}

// Replace the generated file only after generation and the full write succeed.
func writeFile(path string, source []byte) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".infergen-*.go")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.Write(source); err != nil {
		return err
	}
	if err := file.Chmod(0o644); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}
