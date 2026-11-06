// Command infergen generates typed evaluators from named Go rule functions.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/vichr-vita/infergo"
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

// settings are the resolved flags, environment variables, and config file values.
type settings struct {
	Rules   []string
	Inputs  string
	Outputs string
	Out     string
	Check   bool
	HTML    string
}

// compile resolves the settings for command, compiles the ruleset, and prints its
// warnings. It writes no files.
func compile(config *viper.Viper, command *cobra.Command) (settings, generate.Result, error) {
	var options settings
	if err := config.BindPFlags(command.Flags()); err != nil {
		return options, generate.Result{}, err
	}
	configFile := config.GetString("config")
	if configFile != "" {
		config.SetConfigFile(configFile)
	}
	if err := config.ReadInConfig(); err != nil {
		var missing viper.ConfigFileNotFoundError
		if configFile != "" || !errors.As(err, &missing) {
			return options, generate.Result{}, fmt.Errorf("read config: %w", err)
		}
	}
	if err := config.Unmarshal(&options); err != nil {
		return options, generate.Result{}, fmt.Errorf("decode config: %w", err)
	}
	if len(options.Rules) == 0 {
		return options, generate.Result{}, fmt.Errorf("rule files are required; set --rules, INFERGEN_RULES, or rules in a config file")
	}
	for i := range options.Rules {
		options.Rules[i] = strings.TrimSpace(options.Rules[i])
		if options.Rules[i] == "" {
			return options, generate.Result{}, fmt.Errorf("rule file names must not be empty")
		}
	}
	result, err := generate.Generate(generate.Config{
		Dir: ".", RuleFiles: options.Rules, Inputs: options.Inputs,
		Outputs: options.Outputs, OutputFile: options.Out,
	})
	if err != nil {
		return options, generate.Result{}, err
	}
	for _, note := range result.Notes {
		fmt.Fprintf(command.ErrOrStderr(), "infergen: %s: warning: %s\n", result.Package, note)
	}
	return options, result, nil
}

// addRulesetFlags declares the settings that generation and view share.
func addRulesetFlags(command *cobra.Command) {
	flags := command.Flags()
	flags.String("config", "", "configuration file (default: infergen.* in the current directory)")
	flags.StringSlice("rules", nil, "Go rule files in the current package (comma-separated or repeated)")
	flags.String("inputs", "Inputs", "external input struct type")
	flags.String("outputs", "Outputs", "requested output struct type")
	flags.String("out", "zz_infergo_gen.go", "generated Go file")
}

func newCommand() *cobra.Command {
	return newCommandWithOpener(openFile)
}

// newCommandWithOpener builds the CLI. view --open passes an absolute path to
// open, which must start the opener without waiting for it.
func newCommandWithOpener(open func(path string) error) *cobra.Command {
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
			options, result, err := compile(config, command)
			if err != nil {
				return err
			}
			if options.Check {
				return checkFile(options.Out, result)
			}
			updated, err := writeFile(options.Out, result.Source, 0o644)
			if err != nil {
				return fmt.Errorf("%s: write %s: %w", result.Package, options.Out, err)
			}
			if updated {
				fmt.Fprintf(command.ErrOrStderr(), "infergen: %s: updated %s (%s)\n", result.Package, options.Out, ruleCount(result.Rules))
			}
			return nil
		},
	}
	addRulesetFlags(command)
	command.Flags().Bool("check", false, "fail if the generated file is missing or out of date, and write nothing")
	// view is the only listed subcommand. completion keeps working but stays out
	// of --help, and help stays an unknown command.
	command.CompletionOptions.HiddenDefaultCmd = true
	command.SetHelpCommand(&cobra.Command{Hidden: true})

	view := &cobra.Command{
		Use:     "view [flags]",
		Short:   "Export the rule graph as an offline HTML page without generating code",
		Example: "  infergen view --rules rules.go --open\n  infergen view --html graph.html",
		Args:    cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			options, result, err := compile(config, command)
			if err != nil {
				return err
			}
			// With no cases, ExportHTML never calls the evaluator or runs a rule.
			html, err := infergo.ExportHTML[struct{}, struct{}](command.Context(), result.PackageName, result.Ruleset, nil, nil)
			if err != nil {
				return err
			}
			path := options.HTML
			if path == "" {
				directory, err := filepath.Abs(".")
				if err != nil {
					return err
				}
				path = defaultHTMLPath(result.PackageName, directory)
			}
			if err := checkHTMLPath(path); err != nil {
				return err
			}
			// The page embeds rule source, and the default directory is often
			// shared, so an unchanged page must still end up private.
			const pageMode = 0o600
			updated, err := writeFile(path, []byte(html), pageMode)
			if err != nil {
				return err
			}
			if !updated {
				if err := enforceMode(path, pageMode); err != nil {
					return err
				}
			}
			fmt.Fprintln(command.OutOrStdout(), path)
			// --open reads the flag alone, so a shared config can't open a browser.
			openPage, err := command.Flags().GetBool("open")
			if err != nil {
				return err
			}
			if !openPage {
				return nil
			}
			absolute, err := filepath.Abs(path)
			if err != nil {
				return fmt.Errorf("open %s: %w", path, err)
			}
			if err := open(absolute); err != nil {
				return fmt.Errorf("open %s: %w", path, err)
			}
			return nil
		},
	}
	addRulesetFlags(view)
	view.Flags().String("html", "", "output .html or .htm file (default: infergo-<package>-<hash>.html in the system temporary directory)")
	view.Flags().Bool("open", false, "open the HTML file with the platform's default application (command line only)")
	command.AddCommand(view)
	return command
}

// openerCommand returns the program and arguments that open path on goos.
func openerCommand(goos, path string) (string, []string) {
	switch goos {
	case "darwin":
		return "open", []string{path}
	case "windows":
		return "rundll32", []string{"url.dll,FileProtocolHandler", path}
	default:
		return "xdg-open", []string{path}
	}
}

func openFile(path string) error {
	name, args := openerCommand(runtime.GOOS, path)
	return startProgram(name, args...)
}

// startProgram starts a program without waiting for it, so an opener that stays
// running can't hold the command. It reports only a failure to start.
func startProgram(name string, args ...string) error {
	program := exec.Command(name, args...)
	if err := program.Start(); err != nil {
		return err
	}
	// The program is running, so a failed release changes nothing for the caller.
	_ = program.Process.Release()
	return nil
}

// defaultHTMLPath keeps same-named packages from sharing a page. The hash of
// the absolute ruleset directory gives each directory one stable path.
func defaultHTMLPath(packageName, directory string) string {
	hash := sha256.Sum256([]byte(directory))
	return filepath.Join(os.TempDir(), fmt.Sprintf("infergo-%s-%x.html", packageName, hash[:4]))
}

// pageDataOpening starts the data script of every page that ExportHTML produces.
const pageDataOpening = `<script id="infergo-data" type="application/json">`

// savedCases returns the scenarios in a page's data script. ok is false if
// content is not an ExportHTML page. encoding/json escapes "<", so the first
// </script> after the opening tag always ends the data.
func savedCases(content []byte) (cases []json.RawMessage, ok bool) {
	_, rest, found := bytes.Cut(content, []byte(pageDataOpening))
	if !found {
		return nil, false
	}
	data, _, found := bytes.Cut(rest, []byte("</script>"))
	if !found {
		return nil, false
	}
	var page struct {
		Cases []json.RawMessage `json:"cases"`
	}
	if err := json.Unmarshal(data, &page); err != nil || page.Cases == nil {
		return nil, false
	}
	return page.Cases, true
}

// checkHTMLPath keeps view from replacing a file it can't recreate. It accepts
// a path only with an HTML extension, and an existing file only if that file is
// a topology page: a regular file holding an ExportHTML page with no saved
// scenarios. A symbolic link is refused, because the rename would replace the
// link rather than its target.
func checkHTMLPath(path string) error {
	const advice = "choose another path with --html"
	if extension := strings.ToLower(filepath.Ext(path)); extension != ".html" && extension != ".htm" {
		return fmt.Errorf("%s does not end in .html or .htm; %s", path, advice)
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("cannot check existing file %s: %w; %s", path, err, advice)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("refusing to replace %s, which is not a regular file; %s", path, advice)
	}
	existing, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("cannot check existing file %s: %w; %s", path, err, advice)
	}
	cases, isPage := savedCases(existing)
	if !isPage {
		return fmt.Errorf("refusing to replace %s, which is not an Infergo page; %s", path, advice)
	}
	if len(cases) > 0 {
		return fmt.Errorf("refusing to replace %s, which holds saved scenarios; %s", path, advice)
	}
	return nil
}

func ruleCount(rules int) string {
	if rules == 1 {
		return "1 rule"
	}
	return fmt.Sprintf("%d rules", rules)
}

// sameSource reports whether a file on disk holds the generated source. It
// ignores CRLF, so that an autocrlf checkout counts as current.
func sameSource(existing, source []byte) bool {
	return bytes.Equal(bytes.ReplaceAll(existing, []byte("\r\n"), []byte("\n")), source)
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
	if !sameSource(existing, result.Source) {
		return fmt.Errorf("%s: %s is out of date; run go generate", result.Package, path)
	}
	return nil
}

// writeFile reports whether it changed path's content. It leaves a current file
// alone, so the file keeps its mode and modification time, and a read-only mount
// doesn't fail a run that changes nothing. It replaces any other file only after
// the full write succeeds, and gives the replacement mode. A file it cannot read
// counts as changed, because replacing it doesn't need read access.
func writeFile(path string, content []byte, mode os.FileMode) (bool, error) {
	if existing, err := os.ReadFile(path); err == nil && sameSource(existing, content) {
		return false, nil
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".infergen-*"+filepath.Ext(path))
	if err != nil {
		return false, err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.Write(content); err != nil {
		return false, err
	}
	if err := file.Chmod(mode); err != nil {
		return false, err
	}
	if err := file.Close(); err != nil {
		return false, err
	}
	return true, os.Rename(file.Name(), path)
}

// enforceMode changes path only when needed, so a correct file that belongs to
// someone else doesn't fail.
func enforceMode(path string, mode os.FileMode) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Mode().Perm() == mode {
		return nil
	}
	return os.Chmod(path, mode)
}
