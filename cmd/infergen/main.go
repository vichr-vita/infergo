// Command infergen generates typed evaluators from named Go rule functions.
package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/vichr-vita/infergo/internal/generate"
)

func main() {
	if err := newCommand().Execute(); err != nil {
		printError(os.Stderr, err)
		os.Exit(1)
	}
}

// printError prefixes each error of a joined report with the program name.
func printError(w io.Writer, err error) {
	failures := []error{err}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		failures = joined.Unwrap()
	}
	for _, failure := range failures {
		fmt.Fprintln(w, "infergen:", failure)
	}
}

func newCommand() *cobra.Command {
	config := viper.New()
	config.SetEnvPrefix("INFERGEN")
	config.AutomaticEnv()
	config.SetConfigName("infergen")
	config.AddConfigPath(".")

	command := &cobra.Command{
		Use:           "infergen [flags]",
		Short:         "Generate typed evaluators from named Go rule functions",
		Example:       "  infergen --rules rules.go\n  infergen --config infergen.yaml\n  INFERGEN_CHECK=true go generate ./...",
		Args:          cobra.NoArgs,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(command *cobra.Command, _ []string) error {
			if err := config.BindPFlags(command.Flags()); err != nil {
				return err
			}
			configFile := config.GetString("config")
			if configFile != "" {
				config.SetConfigFile(configFile)
			}
			if err := config.ReadInConfig(); err != nil {
				var missing viper.ConfigFileNotFoundError
				if configFile != "" || !errors.As(err, &missing) {
					return fmt.Errorf("read config: %w", err)
				}
			}
			var options struct {
				Rules   []string
				Inputs  string
				Outputs string
				Out     string
				Check   bool
			}
			if err := config.Unmarshal(&options); err != nil {
				return fmt.Errorf("decode config: %w", err)
			}
			if len(options.Rules) == 0 {
				return fmt.Errorf("rule files are required; set --rules, INFERGEN_RULES, or rules in a config file")
			}
			for i := range options.Rules {
				options.Rules[i] = strings.TrimSpace(options.Rules[i])
				if options.Rules[i] == "" {
					return fmt.Errorf("rule file names must not be empty")
				}
			}

			result, err := generate.Generate(generate.Config{
				Dir: ".", RuleFiles: options.Rules, Inputs: options.Inputs,
				Outputs: options.Outputs, OutputFile: options.Out,
			})
			if err != nil {
				return err
			}
			stderr := command.ErrOrStderr()
			for _, note := range result.Notes {
				fmt.Fprintln(stderr, "infergen: warning:", note)
			}
			if options.Check {
				return checkFile(options.Out, result)
			}
			updated, err := writeFile(options.Out, result.Source)
			if err != nil {
				return err
			}
			if updated {
				fmt.Fprintf(stderr, "infergen: updated %s (%s)\n", options.Out, ruleCount(result.Rules))
			}
			return nil
		},
	}
	flags := command.Flags()
	flags.String("config", "", "configuration file (default: infergen.* in the current directory)")
	flags.StringSlice("rules", nil, "Go rule files in the current package (comma-separated or repeated)")
	flags.String("inputs", "Inputs", "external input struct type")
	flags.String("outputs", "Outputs", "requested output struct type")
	flags.String("out", "zz_infergo_gen.go", "generated Go file")
	flags.Bool("check", false, "fail if the generated file is missing or out of date, and write nothing")
	return command
}

func ruleCount(rules int) string {
	if rules == 1 {
		return "1 rule"
	}
	return fmt.Sprintf("%d rules", rules)
}

// checkFile fails unless path already holds the generated source. It never
// writes. The package path identifies the failure in go generate ./... output.
func checkFile(path string, result generate.Result) error {
	existing, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("%s: %s is missing; run go generate", result.Package, path)
	}
	if err != nil {
		return fmt.Errorf("read generated file: %w", err)
	}
	if !bytes.Equal(existing, result.Source) {
		return fmt.Errorf("%s: %s is out of date; run go generate", result.Package, path)
	}
	return nil
}

// writeFile reports whether it changed path. It leaves a current file alone and
// replaces any other only after the full write succeeds.
func writeFile(path string, source []byte) (bool, error) {
	existing, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("read generated file: %w", err)
	}
	if err == nil && bytes.Equal(existing, source) {
		return false, nil
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".infergen-*.go")
	if err != nil {
		return false, err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.Write(source); err != nil {
		return false, err
	}
	if err := file.Chmod(0o644); err != nil {
		return false, err
	}
	if err := file.Close(); err != nil {
		return false, err
	}
	return true, os.Rename(file.Name(), path)
}
