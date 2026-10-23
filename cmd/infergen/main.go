// Command infergen generates typed evaluators from named Go rule functions.
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/vichr-vita/infergo/internal/generate"
)

func main() {
	if err := newCommand().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "infergen:", err)
		os.Exit(1)
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
		Example:       "  infergen --rules rules.go\n  infergen --config infergen.yaml",
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

			source, err := generate.Generate(generate.Config{
				Dir: ".", RuleFiles: options.Rules, Inputs: options.Inputs,
				Outputs: options.Outputs, OutputFile: options.Out,
			})
			if err != nil {
				return err
			}
			return writeFile(options.Out, source)
		},
	}
	flags := command.Flags()
	flags.String("config", "", "configuration file (default: infergen.* in the current directory)")
	flags.StringSlice("rules", nil, "Go rule files in the current package (comma-separated or repeated)")
	flags.String("inputs", "Inputs", "external input struct type")
	flags.String("outputs", "Outputs", "requested output struct type")
	flags.String("out", "zz_infergo_gen.go", "generated Go file")
	return command
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
