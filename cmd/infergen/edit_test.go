package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vichr-vita/infergo/internal/edit/protocol"
)

// editFixture copies ruleset/bonus into a temporary module, which becomes the
// current directory, and clears the settings environment.
func editFixture(t *testing.T) {
	t.Helper()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(t.TempDir())
	clearEnvironment(t)
	t.Setenv("INFERGEN_PORT", "")
	t.Setenv("INFERGEN_SCENARIOS", "")
	t.Setenv("GOWORK", "off")
	write(t, "go.mod", fmt.Sprintf("module example.com/bonus\n\ngo 1.26.0\n\nrequire github.com/vichr-vita/infergo v0.0.0\nreplace github.com/vichr-vita/infergo => %q\n", root))
	for _, name := range []string{"bonus.go", "bonus_test.go", "facts.go", "zz_infergo_gen.go"} {
		write(t, name, mustRead(t, filepath.Join(root, "ruleset", "bonus", name)))
	}
}

// lockedBuffer is a buffer that the command and the test can share.
type lockedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

// editRun is infergen edit running in the background.
type editRun struct {
	url    string
	stderr *lockedBuffer
	done   chan error
	cancel context.CancelFunc
}

// startEdit runs infergen edit with args and returns once it has printed its
// URL. The command stops when the test ends, if it has not already.
func startEdit(t *testing.T, open func(string) error, args ...string) *editRun {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	reader, writer := io.Pipe()
	run := &editRun{stderr: &lockedBuffer{}, done: make(chan error, 1), cancel: cancel}
	command := newCommandWithOpener(open)
	command.SetOut(writer)
	command.SetErr(run.stderr)
	command.SetArgs(append([]string{"edit"}, args...))
	go func() {
		err := command.ExecuteContext(ctx)
		writer.Close()
		run.done <- err
	}()
	lines := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(reader).ReadString('\n')
		lines <- strings.TrimSpace(line)
		io.Copy(io.Discard, reader)
	}()
	select {
	case run.url = <-lines:
	case <-time.After(30 * time.Second):
		t.Fatal("infergen edit printed no URL")
	}
	if !strings.HasPrefix(run.url, "http://127.0.0.1:") {
		err := <-run.done
		t.Fatalf("infergen edit printed %q, error %v, stderr:\n%s", run.url, err, run.stderr)
	}
	t.Cleanup(func() {
		cancel()
		<-run.done
	})
	return run
}

// stop interrupts the command and returns its error.
func (r *editRun) stop(t *testing.T) error {
	t.Helper()
	r.cancel()
	select {
	case err := <-r.done:
		r.done <- err
		return err
	case <-time.After(10 * time.Second):
		t.Fatal("infergen edit did not stop")
		return nil
	}
}

// api returns the URL of an API path with the token from the printed URL.
func (r *editRun) api(path string) string {
	base, query, _ := strings.Cut(r.url, "/?")
	return base + path + "?" + query
}

// firstCheck reads the event stream until the first check event.
func (r *editRun) firstCheck(t *testing.T) protocol.Check {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, r.api(protocol.PathEvents), nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(nil, 1<<22)
	name := ""
	for scanner.Scan() {
		line := scanner.Text()
		if value, ok := strings.CutPrefix(line, "event: "); ok {
			name = value
		}
		if data, ok := strings.CutPrefix(line, "data: "); ok && name == protocol.EventCheck {
			var check protocol.Check
			if err := json.Unmarshal([]byte(data), &check); err != nil {
				t.Fatal(err)
			}
			return check
		}
	}
	t.Fatalf("event stream ended without a check: %v", scanner.Err())
	return protocol.Check{}
}

// model fetches the model.
func (r *editRun) model(t *testing.T) protocol.Model {
	t.Helper()
	response, err := http.Get(r.api(protocol.PathModel))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var model protocol.Model
	if err := json.NewDecoder(response.Body).Decode(&model); err != nil {
		t.Fatal(err)
	}
	return model
}

func TestHelpListsEdit(t *testing.T) {
	commandFixture(t)
	var output bytes.Buffer
	command := newCommand()
	command.SetOut(&output)
	command.SetArgs([]string{"--help"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "edit ") {
		t.Fatalf("help does not list edit:\n%s", &output)
	}
}

func TestEditServesUntilInterrupted(t *testing.T) {
	editFixture(t)
	info, err := os.Stat("zz_infergo_gen.go")
	if err != nil {
		t.Fatal(err)
	}
	run := startEdit(t, refuseOpen(t), "--rules", "bonus.go")
	response, err := http.Get(run.url)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("page: %s", response.Status)
	}
	if model := run.model(t); len(model.Rules) != 26 || model.Revision != 1 {
		t.Fatalf("model: %d rules, revision %d", len(model.Rules), model.Revision)
	}
	check := run.firstCheck(t)
	if !check.OK || check.Evaluator != protocol.EvaluatorCurrent {
		t.Fatalf("check = %+v", check)
	}
	if after, err := os.Stat("zz_infergo_gen.go"); err != nil || !after.ModTime().Equal(info.ModTime()) {
		t.Fatal("a current evaluator was rewritten")
	}
	if err := run.stop(t); err != nil {
		t.Fatalf("edit returned %v after an interrupt", err)
	}
	if _, err := http.Get(run.url); err == nil {
		t.Fatal("the server still answers after the command returned")
	}
}

func TestEditRegeneratesStaleEvaluator(t *testing.T) {
	editFixture(t)
	write(t, "zz_infergo_gen.go", mustRead(t, "zz_infergo_gen.go")+"\n// Stale.\n")
	run := startEdit(t, refuseOpen(t), "--rules", "bonus.go")
	if check := run.firstCheck(t); !check.OK || check.Evaluator != protocol.EvaluatorUpdated {
		t.Fatalf("check = %+v", check)
	}
	if !strings.Contains(run.stderr.String(), "infergen: example.com/bonus: updated zz_infergo_gen.go (26 rules)") {
		t.Fatalf("stderr:\n%s", run.stderr)
	}
	if err := run.stop(t); err != nil {
		t.Fatal(err)
	}
	// Generation's own check mode agrees that the evaluator is current.
	if stderr, err := execute(t, "--rules", "bonus.go", "--check"); err != nil {
		t.Fatalf("check mode: %v\n%s", err, stderr)
	}
}

func TestEditStartsWhenRulesetDoesNotCompile(t *testing.T) {
	editFixture(t)
	write(t, "bonus.go", mustRead(t, "bonus.go")+"\nvar broken int = \"text\"\n")
	evaluator := mustRead(t, "zz_infergo_gen.go")
	run := startEdit(t, refuseOpen(t), "--rules", "bonus.go")
	if model := run.model(t); len(model.Rules) != 26 {
		t.Fatalf("model has %d rules", len(model.Rules))
	}
	check := run.firstCheck(t)
	if check.OK || check.Evaluator != protocol.EvaluatorKept || len(check.Diagnostics) == 0 {
		t.Fatalf("check = %+v", check)
	}
	if mustRead(t, "zz_infergo_gen.go") != evaluator {
		t.Fatal("a failing check changed the evaluator")
	}
}

func TestEditOpenStartsTheBrowser(t *testing.T) {
	editFixture(t)
	opened := make(chan string, 1)
	run := startEdit(t, func(url string) error {
		opened <- url
		return nil
	}, "--rules", "bonus.go", "--open")
	select {
	case url := <-opened:
		if url != run.url {
			t.Fatalf("opened %s, printed %s", url, run.url)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("--open did not open the page")
	}
}

func TestEditUsesSharedConfiguration(t *testing.T) {
	editFixture(t)
	write(t, "infergen.yaml", "rules: [bonus.go]\n")
	run := startEdit(t, refuseOpen(t))
	if model := run.model(t); len(model.Rules) != 26 {
		t.Fatalf("model has %d rules", len(model.Rules))
	}
}

func TestEditAssetsDirectory(t *testing.T) {
	editFixture(t)
	assets := t.TempDir()
	for _, name := range []string{"editor.html", "editor.js", "editor.css"} {
		write(t, filepath.Join(assets, name), "development "+name)
	}
	run := startEdit(t, refuseOpen(t), "--rules", "bonus.go", "--assets", assets)
	base, _, _ := strings.Cut(run.url, "/?")
	response, err := http.Get(base + "/editor.js")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || string(body) != "development editor.js" {
		t.Fatalf("editor.js = %q, %v", body, err)
	}
}
