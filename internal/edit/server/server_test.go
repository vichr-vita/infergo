package server

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
	"sync/atomic"
	"testing"
	"time"

	"github.com/vichr-vita/infergo/internal/edit/protocol"
	"github.com/vichr-vita/infergo/internal/edit/source"
	"github.com/vichr-vita/infergo/internal/edit/workspace"
	"github.com/vichr-vita/infergo/internal/generate"
)

// bonusModule copies ruleset/bonus into a temporary module that uses this
// checkout through a replace directive, and returns its directory.
func bonusModule(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("GOWORK", "off")
	dir := t.TempDir()
	module := fmt.Sprintf("module example.com/bonus\n\ngo 1.26.0\n\nrequire github.com/vichr-vita/infergo v0.0.0\n\nreplace github.com/vichr-vita/infergo => %q\n", root)
	writeFile(t, filepath.Join(dir, "go.mod"), module)
	for _, name := range []string{"bonus.go", "bonus_test.go", "facts.go", "zz_infergo_gen.go"} {
		content, err := os.ReadFile(filepath.Join(root, "ruleset", "bonus", name))
		if err != nil {
			t.Fatal(err)
		}
		writeFile(t, filepath.Join(dir, name), string(content))
	}
	return dir
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

// testServer is a running server on a bonus copy.
type testServer struct {
	dir   string
	ws    *workspace.Workspace
	srv   *Server
	base  string
	token string
}

// start runs a server on dir until the test ends. A nil check uses the real
// generate.Check. The evaluator writer writes only when content differs, as
// infergen's does.
func start(t *testing.T, dir string, check func(generate.Config) (generate.Report, error)) *testServer {
	t.Helper()
	ws, err := workspace.Open(dir, workspace.Options{
		Config:    source.Config{RuleFiles: []string{"bonus.go"}, Inputs: "Inputs", Outputs: "Outputs"},
		Evaluator: "zz_infergo_gen.go",
		WriteEvaluator: func(path string, content []byte) (bool, error) {
			if existing, err := os.ReadFile(path); err == nil && bytes.Equal(existing, content) {
				return false, nil
			}
			return true, os.WriteFile(path, content, 0o644)
		},
		Logf: t.Logf,
	})
	if err != nil {
		t.Fatal(err)
	}
	listener, err := Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	srv, err := New(listener, Options{Workspace: ws, Log: testLog{t}})
	if err != nil {
		t.Fatal(err)
	}
	if check != nil {
		srv.check = check
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- srv.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("Run: %v", err)
		}
		if err := ws.Close(); err != nil {
			t.Error(err)
		}
	})
	return &testServer{dir: dir, ws: ws, srv: srv, base: "http://" + listener.Addr().String(), token: srv.token}
}

// testLog sends server log lines to the test log.
type testLog struct{ t *testing.T }

func (l testLog) Write(p []byte) (int, error) {
	l.t.Log(strings.TrimSpace(string(p)))
	return len(p), nil
}

// api returns the URL of an API path with the token.
func (s *testServer) api(path string) string {
	return s.base + path + "?" + protocol.TokenParam + "=" + s.token
}

// post sends body as JSON to an API path and decodes the reply into reply.
func (s *testServer) post(t *testing.T, path string, body any, reply any) int {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.Post(s.api(path), "application/json", bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if reply != nil {
		if err := json.NewDecoder(response.Body).Decode(reply); err != nil {
			t.Fatalf("decode %s reply: %v", path, err)
		}
	}
	return response.StatusCode
}

// event is one server-sent event.
type event struct {
	name string
	data []byte
}

// subscribe opens the event stream and returns its events in order. The
// stream closes when the test ends.
func (s *testServer) subscribe(t *testing.T) <-chan event {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.api(protocol.PathEvents), nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("events: %s %s", response.Status, response.Header.Get("Content-Type"))
	}
	events := make(chan event, 100)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		defer close(events)
		scanner := bufio.NewScanner(response.Body)
		scanner.Buffer(nil, 1<<22)
		var current event
		for scanner.Scan() {
			line := scanner.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				current.name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				current.data = []byte(strings.TrimPrefix(line, "data: "))
			case line == "" && current.name != "":
				events <- current
				current = event{}
			}
		}
	}()
	t.Cleanup(func() {
		cancel()
		response.Body.Close()
		<-finished
	})
	return events
}

// next waits for the next event named name, skipping others, and decodes it.
func next[T any](t *testing.T, events <-chan event, name string, accept func(T) bool) T {
	t.Helper()
	deadline := time.After(30 * time.Second)
	for {
		select {
		case e, ok := <-events:
			if !ok {
				t.Fatalf("event stream ended while waiting for %s", name)
			}
			if e.name != name {
				continue
			}
			var value T
			if err := json.Unmarshal(e.data, &value); err != nil {
				t.Fatalf("decode %s: %v", name, err)
			}
			if accept == nil || accept(value) {
				return value
			}
		case <-deadline:
			t.Fatalf("no %s event", name)
		}
	}
}

// fakeCheck returns a check that reports a failure without a result, and
// counts its calls.
func fakeCheck(calls *atomic.Int32) func(generate.Config) (generate.Report, error) {
	return func(generate.Config) (generate.Report, error) {
		calls.Add(1)
		return generate.Report{}, nil
	}
}

func TestForeignHostIsRejected(t *testing.T) {
	s := start(t, bonusModule(t), fakeCheck(new(atomic.Int32)))
	port := s.base[strings.LastIndex(s.base, ":")+1:]
	for host, want := range map[string]int{
		"127.0.0.1:" + port: http.StatusOK,
		"localhost:" + port: http.StatusMisdirectedRequest,
		"evil.example":      http.StatusMisdirectedRequest,
	} {
		for _, path := range []string{"/", protocol.PathModel} {
			request, err := http.NewRequest(http.MethodGet, s.api(path), nil)
			if err != nil {
				t.Fatal(err)
			}
			request.Host = host
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != want {
				t.Errorf("Host %s, %s: status %d, want %d", host, path, response.StatusCode, want)
			}
		}
	}
}

func TestMissingTokenIsRejected(t *testing.T) {
	s := start(t, bonusModule(t), fakeCheck(new(atomic.Int32)))
	before := readFile(t, filepath.Join(s.dir, "bonus.go"))
	for _, url := range []string{s.base + protocol.PathModel, s.base + protocol.PathModel + "?token=wrong", s.base + protocol.PathEvents} {
		response, err := http.Get(url)
		if err != nil {
			t.Fatal(err)
		}
		var reply protocol.ErrorReply
		if err := json.NewDecoder(response.Body).Decode(&reply); err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusUnauthorized || reply.Error == "" {
			t.Errorf("%s: status %d, reply %+v", url, response.StatusCode, reply)
		}
	}
	body := `{"op":{"op":"add_read","rule":"ReviewRequired","fact":"financeRequired","type":"bool"}}`
	response, err := http.Post(s.base+protocol.PathApply, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Errorf("apply without token: status %d", response.StatusCode)
	}
	if readFile(t, filepath.Join(s.dir, "bonus.go")) != before {
		t.Fatal("a request without the token wrote")
	}
	// The page itself needs no token, since it reads the token from its URL.
	response, err = http.Get(s.base + "/")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/html") {
		t.Fatalf("page: %s %s", response.Status, response.Header.Get("Content-Type"))
	}
}

func TestCrossOriginPostIsRejected(t *testing.T) {
	s := start(t, bonusModule(t), fakeCheck(new(atomic.Int32)))
	before := readFile(t, filepath.Join(s.dir, "bonus.go"))
	body := `{"op":{"op":"add_read","rule":"ReviewRequired","fact":"financeRequired","type":"bool"}}`
	for _, header := range [][2]string{{"Sec-Fetch-Site", "cross-site"}, {"Origin", "http://evil.example"}} {
		request, err := http.NewRequest(http.MethodPost, s.api(protocol.PathApply), strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set(header[0], header[1])
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusForbidden {
			t.Errorf("%s: %s: status %d, want 403", header[0], header[1], response.StatusCode)
		}
	}
	if readFile(t, filepath.Join(s.dir, "bonus.go")) != before {
		t.Fatal("a cross-origin request wrote")
	}
	// The same request from the page's own origin gets through to the
	// workspace, which has nothing to undo.
	request, err := http.NewRequest(http.MethodPost, s.api(protocol.PathUndo), nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	request.Header.Set("Origin", s.base)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	var refusal protocol.Refusal
	if err := json.NewDecoder(response.Body).Decode(&refusal); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != protocol.RefusalStatus || refusal.Reason != protocol.ReasonNotFound {
		t.Fatalf("same-origin undo: status %d, %+v", response.StatusCode, refusal)
	}
}

func TestEventsStartWithModelHistoryAndCheck(t *testing.T) {
	s := start(t, bonusModule(t), fakeCheck(new(atomic.Int32)))
	// Wait for the first check on one stream, then connect another.
	next[protocol.Check](t, s.subscribe(t), protocol.EventCheck, nil)
	events := s.subscribe(t)
	var names []string
	for range 3 {
		select {
		case e := <-events:
			names = append(names, e.name)
		case <-time.After(5 * time.Second):
			t.Fatalf("events so far: %v", names)
		}
	}
	if got := strings.Join(names, ","); got != "model,history,check" {
		t.Fatalf("events on connect = %s", got)
	}
}

func TestOutsideEditReachesTheStream(t *testing.T) {
	s := start(t, bonusModule(t), fakeCheck(new(atomic.Int32)))
	events := s.subscribe(t)
	next[protocol.Check](t, events, protocol.EventCheck, nil)
	path := filepath.Join(s.dir, "bonus.go")
	writeFile(t, path, readFile(t, path)+"\n// Edited elsewhere.\n")
	// The model comes first so the graph redraws at once. The check follows.
	var names []string
	for len(names) < 3 {
		select {
		case e := <-events:
			names = append(names, e.name)
			switch e.name {
			case protocol.EventHistory:
				var history protocol.History
				if err := json.Unmarshal(e.data, &history); err != nil || len(history.Entries) != 1 || history.Entries[0].Source != protocol.SourceDisk {
					t.Fatalf("history = %s", e.data)
				}
			case protocol.EventCheck:
				var check protocol.Check
				if err := json.Unmarshal(e.data, &check); err != nil || check.Revision != 2 || check.OK || check.Evaluator != protocol.EvaluatorKept {
					t.Fatalf("check = %s", e.data)
				}
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("events so far: %v", names)
		}
	}
	if got := strings.Join(names, ","); got != "model,history,check" {
		t.Fatalf("events after an outside edit = %s", got)
	}
}

func TestChecksRunOneAtATimeAndDropOlderRevisions(t *testing.T) {
	dir := bonusModule(t)
	evaluator := filepath.Join(dir, "zz_infergo_gen.go")
	original := readFile(t, evaluator)
	release := make(chan struct{})
	started := make(chan struct{}, 10)
	var calls, running atomic.Int32
	check := func(generate.Config) (generate.Report, error) {
		if running.Add(1) > 1 {
			t.Error("two checks ran at once")
		}
		defer running.Add(-1)
		call := calls.Add(1)
		started <- struct{}{}
		if call == 1 {
			<-release
		}
		source := fmt.Sprintf("package bonus\n\n// Check %d.\n", call)
		return generate.Report{Result: &generate.Result{Source: []byte(source), Package: "example.com/bonus"}}, nil
	}
	s := start(t, dir, check)
	events := s.subscribe(t)
	<-started
	// Two outside edits while the first check runs collapse into one more
	// check of the newest revision.
	path := filepath.Join(dir, "bonus.go")
	writeFile(t, path, readFile(t, path)+"\n// One.\n")
	next(t, events, protocol.EventModel, func(m protocol.Model) bool { return m.Revision == 2 })
	writeFile(t, path, readFile(t, path)+"\n// Two.\n")
	next(t, events, protocol.EventModel, func(m protocol.Model) bool { return m.Revision == 3 })
	close(release)
	result := next[protocol.Check](t, events, protocol.EventCheck, nil)
	if result.Revision != 3 || !result.OK || result.Evaluator != protocol.EvaluatorUpdated {
		t.Fatalf("first published check = %+v", result)
	}
	// The first check's result is dropped. A third check may follow if the
	// second started before the last edit's request arrived.
	if calls.Load() < 2 {
		t.Fatalf("check ran %d times, want at least 2", calls.Load())
	}
	if got := readFile(t, evaluator); got == original || strings.Contains(got, "Check 1.") {
		t.Fatalf("evaluator = %q", got)
	}
}

func TestEvaluatorIsWrittenOnlyWhenValidAndDifferent(t *testing.T) {
	dir := bonusModule(t)
	evaluator := filepath.Join(dir, "zz_infergo_gen.go")
	info, err := os.Stat(evaluator)
	if err != nil {
		t.Fatal(err)
	}
	s := start(t, dir, nil)
	events := s.subscribe(t)
	check := next(t, events, protocol.EventCheck, func(c protocol.Check) bool { return c.Revision == 1 })
	if !check.OK || check.Evaluator != protocol.EvaluatorCurrent {
		t.Fatalf("first check = %+v", check)
	}
	if after, err := os.Stat(evaluator); err != nil || !after.ModTime().Equal(info.ModTime()) {
		t.Fatal("a current evaluator was rewritten")
	}

	// A requirement is part of the evaluator, so rewording one updates it.
	path := filepath.Join(dir, "bonus.go")
	writeFile(t, path, strings.Replace(readFile(t, path), "// TenureEligible ", "// TenureEligible (reworded) ", 1))
	check = next(t, events, protocol.EventCheck, func(c protocol.Check) bool { return c.Revision == 2 })
	if !check.OK || check.Evaluator != protocol.EvaluatorUpdated || !strings.Contains(readFile(t, evaluator), "(reworded)") {
		t.Fatalf("check after rewording = %+v", check)
	}
	updated := readFile(t, evaluator)

	// A type error keeps the last valid evaluator.
	writeFile(t, path, readFile(t, path)+"\nvar broken int = \"text\"\n")
	check = next(t, events, protocol.EventCheck, func(c protocol.Check) bool { return c.Revision == 3 })
	if check.OK || check.Evaluator != protocol.EvaluatorKept || readFile(t, evaluator) != updated {
		t.Fatalf("check after a type error = %+v", check)
	}
	if len(check.Diagnostics) == 0 || check.Diagnostics[0].Kind != protocol.KindGo || check.Diagnostics[0].File != "bonus.go" {
		t.Fatalf("diagnostics = %+v", check.Diagnostics)
	}
}

func TestUnloadablePackageIsOneDiagnostic(t *testing.T) {
	failing := func(generate.Config) (generate.Report, error) {
		return generate.Report{}, fmt.Errorf("example.com/bonus: load ruleset: no buildable files")
	}
	s := start(t, bonusModule(t), failing)
	check := next[protocol.Check](t, s.subscribe(t), protocol.EventCheck, nil)
	if check.OK || check.Evaluator != protocol.EvaluatorKept || len(check.Diagnostics) != 1 ||
		check.Diagnostics[0].Severity != protocol.SeverityError || !strings.Contains(check.Diagnostics[0].Message, "no buildable files") {
		t.Fatalf("check = %+v", check)
	}
}

func TestValuesAreNotBuilt(t *testing.T) {
	s := start(t, bonusModule(t), fakeCheck(new(atomic.Int32)))
	var reply protocol.ErrorReply
	if status := s.post(t, protocol.PathValues, protocol.ValuesRequest{Enabled: true}, &reply); status != http.StatusNotImplemented || reply.Error == "" {
		t.Fatalf("values: status %d, %+v", status, reply)
	}
}

func TestBadRequestsGetErrorReplies(t *testing.T) {
	s := start(t, bonusModule(t), fakeCheck(new(atomic.Int32)))
	var reply protocol.ErrorReply
	if status := s.post(t, protocol.PathApply, map[string]any{"op": map[string]any{"op": "add_read"}}, &reply); status != http.StatusBadRequest || reply.Error == "" {
		t.Fatalf("invalid op: status %d, %+v", status, reply)
	}
	response, err := http.Get(s.api(protocol.PathApply))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusMethodNotAllowed || !json.Valid(body) {
		t.Fatalf("GET apply: %d %s", response.StatusCode, body)
	}
}

func TestStreamsDoNotBlockOnSlowPages(t *testing.T) {
	h := newHub()
	slow := h.subscribe()
	var wait sync.WaitGroup
	wait.Add(1)
	go func() {
		defer wait.Done()
		for i := range 1000 {
			h.publish(protocol.EventModel, protocol.Model{Revision: i})
		}
	}()
	wait.Wait()
	names, payloads := h.take(slow)
	if len(names) != 1 || !bytes.Contains(payloads[0], []byte(`"revision":999`)) {
		t.Fatalf("slow stream got %v %s", names, payloads)
	}
}

func TestPreviewThenApply(t *testing.T) {
	s := start(t, bonusModule(t), fakeCheck(new(atomic.Int32)))
	events := s.subscribe(t)
	path := filepath.Join(s.dir, "bonus.go")
	before := readFile(t, path)
	request := protocol.OpRequest{Op: protocol.Op{Op: protocol.OpAddRead, Rule: "ReviewRequired", Fact: "financeRequired", Type: "bool"}}
	var preview protocol.PreviewReply
	if status := s.post(t, protocol.PathPreview, request, &preview); status != http.StatusOK || len(preview.Changes) != 1 ||
		!strings.Contains(preview.Changes[0].After, "financeRequired bool") {
		t.Fatalf("preview: status %d, %+v", status, preview)
	}
	if readFile(t, path) != before {
		t.Fatal("preview wrote")
	}
	var applied protocol.ApplyReply
	if status := s.post(t, protocol.PathApply, request, &applied); status != http.StatusOK || applied.Revision != 2 || applied.Receipt.ID != 1 {
		t.Fatalf("apply: status %d, %+v", status, applied)
	}
	model := next(t, events, protocol.EventModel, func(m protocol.Model) bool { return m.Revision == 2 })
	for _, rule := range model.Rules {
		if rule.ID == "ReviewRequired" && rule.Reads[len(rule.Reads)-1].Name != "financeRequired" {
			t.Fatalf("ReviewRequired reads %+v", rule.Reads)
		}
	}
	var undone protocol.ApplyReply
	if status := s.post(t, protocol.PathUndo, nil, &undone); status != http.StatusOK || undone.Revision != 3 {
		t.Fatalf("undo: status %d, %+v", status, undone)
	}
	if readFile(t, path) != before {
		t.Fatal("undo did not restore bonus.go")
	}
}

func TestReadThatClosesCycleIsRefused(t *testing.T) {
	s := start(t, bonusModule(t), fakeCheck(new(atomic.Int32)))
	path := filepath.Join(s.dir, "bonus.go")
	before := readFile(t, path)
	// FinanceRequired reads cappedBonusCents, so CappedBonus cannot read
	// financeRequired.
	request := protocol.OpRequest{Op: protocol.Op{Op: protocol.OpAddRead, Rule: "CappedBonus", Fact: "financeRequired", Type: "bool"}}
	for _, route := range []string{protocol.PathPreview, protocol.PathApply} {
		var refusal protocol.Refusal
		status := s.post(t, route, request, &refusal)
		if status != protocol.RefusalStatus || refusal.Reason != protocol.ReasonCycle || strings.Join(refusal.Related, ",") != "CappedBonus,FinanceRequired" {
			t.Errorf("%s: status %d, %+v", route, status, refusal)
		}
	}
	if readFile(t, path) != before {
		t.Fatal("a refused read wrote")
	}
}
