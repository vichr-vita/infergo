package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"

	"github.com/vichr-vita/infergo/internal/edit/server"
	"github.com/vichr-vita/infergo/internal/edit/source"
	"github.com/vichr-vita/infergo/internal/edit/workspace"
)

// newEditCommand builds infergen edit, which serves the rule editor for the
// ruleset in the current directory until interrupted. It shares the ruleset
// settings with generation. --open starts the page with open.
func newEditCommand(config *viper.Viper, open func(path string) error) *cobra.Command {
	edit := &cobra.Command{
		Use:     "edit [flags]",
		Short:   "Edit the rule graph and its Go source in the browser",
		Example: "  infergen edit --rules rules.go --open\n  infergen edit --config infergen.yaml --port 8123",
		Args:    cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			options, err := resolveSettings(config, command)
			if err != nil {
				return err
			}
			// --open and --assets read the flags alone, so a shared config can
			// neither open a browser nor swap the page.
			openPage, err := command.Flags().GetBool("open")
			if err != nil {
				return err
			}
			assets, err := command.Flags().GetString("assets")
			if err != nil {
				return err
			}
			ctx, stop := signal.NotifyContext(command.Context(), os.Interrupt, syscall.SIGTERM)
			defer stop()
			session := editSession{settings: options, assets: assets, stdout: command.OutOrStdout(), stderr: command.ErrOrStderr()}
			if openPage {
				session.open = open
			}
			return session.run(ctx)
		},
	}
	addRulesetFlags(edit)
	flags := edit.Flags()
	flags.Int("port", 0, "port on 127.0.0.1 to serve the editor on (0 picks a free port)")
	flags.Bool("open", false, "open the editor in the default browser (command line only)")
	flags.String("scenarios", "", "exported function in the ruleset package that returns the saved scenarios")
	flags.String("assets", "", "serve the editor page from this directory instead of the built-in copy")
	if err := flags.MarkHidden("assets"); err != nil {
		panic(err)
	}
	return edit
}

// editSession is one run of infergen edit: the resolved settings, where to
// print, and the opener for --open, nil without it.
type editSession struct {
	settings settings
	assets   string
	stdout   io.Writer
	stderr   io.Writer
	open     func(path string) error
}

// run opens the workspace on the current directory, prints the editor's URL
// with its token, and serves until ctx ends. It does not compile the ruleset
// first, because the editor is also for fixing a ruleset that does not build.
func (e editSession) run(ctx context.Context) (err error) {
	rules := make([]string, len(e.settings.Rules))
	for i, name := range e.settings.Rules {
		rules[i] = filepath.Clean(name)
	}
	ws, err := workspace.Open(".", workspace.Options{
		Config:    source.Config{RuleFiles: rules, Inputs: e.settings.Inputs, Outputs: e.settings.Outputs},
		Evaluator: filepath.Clean(e.settings.Out),
		WriteEvaluator: func(path string, content []byte) (bool, error) {
			return writeFile(path, content, 0o644)
		},
		Logf: func(format string, args ...any) { fmt.Fprintf(e.stderr, format+"\n", args...) },
	})
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, ws.Close()) }()
	listener, err := server.Listen(e.settings.Port)
	if err != nil {
		return err
	}
	var assets fs.FS
	if e.assets != "" {
		assets = os.DirFS(e.assets)
	}
	editor, err := server.New(listener, server.Options{Workspace: ws, Assets: assets, Log: e.stderr, Scenarios: e.settings.Scenarios})
	if err != nil {
		listener.Close()
		return err
	}
	fmt.Fprintln(e.stdout, editor.URL())
	if e.open != nil {
		// The URL is printed, so a browser that fails to start is not fatal.
		if err := e.open(editor.URL()); err != nil {
			fmt.Fprintf(e.stderr, "infergen: open the editor: %v\n", err)
		}
	}
	return editor.Run(ctx)
}
