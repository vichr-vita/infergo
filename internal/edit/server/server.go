// Package server serves the editor page and its HTTP API on the loopback
// interface. It turns requests into workspace operations, streams model,
// history, and check events to the page, runs the compiler check in the
// background after every revision, and keeps the generated evaluator current.
package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/vichr-vita/infergo/internal/edit/protocol"
	"github.com/vichr-vita/infergo/internal/edit/web"
	"github.com/vichr-vita/infergo/internal/edit/workspace"
	"github.com/vichr-vita/infergo/internal/generate"
)

// maxBodyBytes bounds a request body. The largest is a replace_source with one
// declaration's text.
const maxBodyBytes = 1 << 20

// shutdownGrace is how long Run lets requests finish after its context ends.
const shutdownGrace = time.Second

// keepAlive is how often an idle event stream sends a comment, so that a
// closed connection is noticed.
const keepAlive = 20 * time.Second

// Options configures New. Workspace is required. Assets serves the page; nil
// means the embedded build in web.Assets, and a directory is useful while
// developing the page. Log receives the lines a person running the command
// wants to see, such as an updated evaluator; nil discards them. Token is the
// session token; empty means a random one. Scenarios names the function that
// returns the saved scenarios; it is kept for the scenario runner, which is
// not built yet.
type Options struct {
	Workspace *workspace.Workspace
	Assets    fs.FS
	Log       io.Writer
	Token     string
	Scenarios string
}

// Server is the editor's HTTP server. New creates it on a listener, URL gives
// the page address with the token, and Run serves until its context ends.
type Server struct {
	ws       *workspace.Workspace
	listener net.Listener
	host     string
	token    string
	assets   fs.FS
	log      io.Writer
	hub      *hub
	// scenarios is Options.Scenarios, unused until live values exist.
	scenarios string
	// check is generate.Check, replaced in tests.
	check func(generate.Config) (generate.Report, error)

	checkMu      sync.Mutex
	checkWanted  bool
	checkRunning bool
	checkStopped bool
	checkDone    sync.WaitGroup
}

// Listen binds the loopback address 127.0.0.1 on port, where 0 picks a free
// port. The editor never listens on another interface.
func Listen(port int) (net.Listener, error) {
	return net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
}

// New prepares a server for the listener, which should come from Listen. The
// server accepts only requests whose Host is the listener's address.
func New(listener net.Listener, options Options) (*Server, error) {
	if options.Workspace == nil {
		return nil, errors.New("server: a workspace is required")
	}
	address, ok := listener.Addr().(*net.TCPAddr)
	if !ok || !address.IP.IsLoopback() {
		return nil, fmt.Errorf("server: %s is not a loopback TCP address", listener.Addr())
	}
	s := &Server{
		ws:        options.Workspace,
		listener:  listener,
		host:      address.String(),
		token:     options.Token,
		assets:    options.Assets,
		log:       options.Log,
		hub:       newHub(),
		scenarios: options.Scenarios,
		check:     generate.Check,
	}
	if s.token == "" {
		s.token = rand.Text()
	}
	if s.assets == nil {
		s.assets = web.Assets
	}
	if s.log == nil {
		s.log = io.Discard
	}
	return s, nil
}

// URL returns the page address including the session token.
func (s *Server) URL() string {
	return "http://" + s.host + "/?" + protocol.TokenParam + "=" + s.token
}

// Run serves until ctx ends, then closes the event streams, stops accepting
// requests, and waits for a running check to finish so that it cannot write
// the evaluator after Run returns. The caller closes the workspace afterwards.
func (s *Server) Run(ctx context.Context) error {
	ctx, stop := context.WithCancel(ctx)
	defer stop()
	s.hub.publish(protocol.EventModel, s.ws.Model())
	s.hub.publish(protocol.EventHistory, s.ws.History())
	forwarded := make(chan struct{})
	go func() {
		defer close(forwarded)
		s.forward(ctx)
	}()
	s.requestCheck()

	server := &http.Server{
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	served := make(chan error, 1)
	go func() { served <- server.Serve(s.listener) }()
	var err error
	select {
	case <-ctx.Done():
	case err = <-served:
	}
	// Cancelling ctx ends the event streams, which would otherwise keep
	// Shutdown waiting. Shutdown also waits for connections that were opened
	// but never carried a request, as browsers open ahead of time, so after
	// in-flight requests have had a moment the rest are closed.
	stop()
	shutdown, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	if shutdownErr := server.Shutdown(shutdown); errors.Is(shutdownErr, context.DeadlineExceeded) {
		if closeErr := server.Close(); err == nil {
			err = closeErr
		}
	} else if err == nil {
		err = shutdownErr
	}
	<-forwarded
	s.stopChecks()
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	return err
}

// forward relays workspace events to the event streams and schedules a check
// for every new revision.
func (s *Server) forward(ctx context.Context) {
	events := s.ws.Events()
	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-events:
			if !ok {
				return
			}
			if event.Model != nil {
				s.hub.publish(protocol.EventModel, *event.Model)
			}
			if event.History != nil {
				s.hub.publish(protocol.EventHistory, *event.History)
			}
			if event.Model != nil {
				s.requestCheck()
			}
		}
	}
}

// Handler returns the server's routes behind the Host check. The page assets
// need no token. Every /api route needs the token, and state-changing routes
// also pass cross-origin protection.
func (s *Server) Handler() http.Handler {
	api := http.NewServeMux()
	api.HandleFunc(protocol.PathModel, s.only(http.MethodGet, s.serveModel))
	api.HandleFunc(protocol.PathEvents, s.only(http.MethodGet, s.serveEvents))
	api.HandleFunc(protocol.PathPreview, s.only(http.MethodPost, s.servePreview))
	api.HandleFunc(protocol.PathApply, s.only(http.MethodPost, s.serveApply))
	api.HandleFunc(protocol.PathUndo, s.only(http.MethodPost, s.serveUndo))
	api.HandleFunc(protocol.PathRedo, s.only(http.MethodPost, s.serveRedo))
	api.HandleFunc(protocol.PathValues, s.only(http.MethodPost, s.serveValues))
	api.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "no such API route: "+r.URL.Path)
	})
	protection := http.NewCrossOriginProtection()
	protection.SetDenyHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusForbidden, "cross-origin request refused")
	}))

	root := http.NewServeMux()
	root.Handle("/api/", protection.Handler(s.requireToken(api)))
	root.HandleFunc("/", s.serveAsset)
	return s.requireHost(root)
}

// requireHost refuses a request whose Host header is not the address the
// server listens on, which defeats DNS rebinding.
func (s *Server) requireHost(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != s.host {
			writeError(w, http.StatusMisdirectedRequest, "unexpected Host "+strconv.Quote(r.Host))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// requireToken refuses an API request without the session token, comparing
// in constant time.
func (s *Server) requireToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := r.URL.Query().Get(protocol.TokenParam)
		if subtle.ConstantTimeCompare([]byte(token), []byte(s.token)) != 1 {
			writeError(w, http.StatusUnauthorized, "missing or wrong session token; open the URL infergen edit printed")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// only refuses methods other than method with an ErrorReply.
func (s *Server) only(method string, handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != method {
			w.Header().Set("Allow", method)
			writeError(w, http.StatusMethodNotAllowed, r.Method+" is not allowed on "+r.URL.Path)
			return
		}
		handler(w, r)
	}
}

// assetNames maps the page's paths to files in the assets.
var assetNames = map[string]string{"/": "editor.html", "/editor.js": "editor.js", "/editor.css": "editor.css"}

// assetTypes is the content type of each asset, fixed here so that the
// system's MIME tables cannot change it.
var assetTypes = map[string]string{
	"editor.html": "text/html; charset=utf-8",
	"editor.js":   "text/javascript; charset=utf-8",
	"editor.css":  "text/css; charset=utf-8",
}

// serveAsset serves the page and its script and stylesheet.
func (s *Server) serveAsset(w http.ResponseWriter, r *http.Request) {
	name, ok := assetNames[r.URL.Path]
	if !ok {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	content, err := fs.ReadFile(s.assets, name)
	if err != nil {
		fmt.Fprintf(s.log, "infergen: read editor asset %s: %v\n", name, err)
		http.Error(w, "editor asset unavailable", http.StatusInternalServerError)
		return
	}
	header := w.Header()
	header.Set("Content-Type", assetTypes[name])
	header.Set("Cache-Control", "no-store")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("X-Frame-Options", "DENY")
	// The page URL carries the token, which must not leak to other origins.
	header.Set("Referrer-Policy", "no-referrer")
	if r.Method == http.MethodHead {
		return
	}
	w.Write(content)
}

func (s *Server) serveModel(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.ws.Model())
}

func (s *Server) servePreview(w http.ResponseWriter, r *http.Request) {
	op, ok := s.readOp(w, r)
	if !ok {
		return
	}
	changes, err := s.ws.Preview(op)
	if err != nil {
		s.writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, protocol.PreviewReply{Changes: changes})
}

func (s *Server) serveApply(w http.ResponseWriter, r *http.Request) {
	op, ok := s.readOp(w, r)
	if !ok {
		return
	}
	s.writeReceipt(w)(s.ws.Apply(op))
}

func (s *Server) serveUndo(w http.ResponseWriter, r *http.Request) {
	s.writeReceipt(w)(s.ws.Undo())
}

func (s *Server) serveRedo(w http.ResponseWriter, r *http.Request) {
	s.writeReceipt(w)(s.ws.Redo())
}

// serveValues accepts the request shape and answers 501, because the scenario
// runner is not built yet.
func (s *Server) serveValues(w http.ResponseWriter, r *http.Request) {
	var request protocol.ValuesRequest
	if !readJSON(w, r, &request) {
		return
	}
	writeError(w, http.StatusNotImplemented, "live values are not built yet")
}

// readOp decodes and validates the operation in the body, and refuses an
// add_read that would close a cycle. It writes the failure itself and reports
// whether the caller should go on.
func (s *Server) readOp(w http.ResponseWriter, r *http.Request) (protocol.Op, bool) {
	var request protocol.OpRequest
	if !readJSON(w, r, &request) {
		return protocol.Op{}, false
	}
	if err := request.Op.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return protocol.Op{}, false
	}
	if refusal, closes := cycleRefusal(s.ws.Model(), request.Op); closes {
		writeJSON(w, protocol.RefusalStatus, refusal)
		return protocol.Op{}, false
	}
	return request.Op, true
}

// writeReceipt returns a function that writes the reply of apply, undo, or
// redo. The revision is read after the write, so a change that lands in
// between makes it newer than the write's own; the page then also receives
// that newer model.
func (s *Server) writeReceipt(w http.ResponseWriter) func(protocol.Receipt, error) {
	return func(receipt protocol.Receipt, err error) {
		if err != nil {
			s.writeFailure(w, err)
			return
		}
		writeJSON(w, http.StatusOK, protocol.ApplyReply{Revision: s.ws.Revision(), Receipt: receipt})
	}
}

// writeFailure sends a refusal with RefusalStatus and any other error as a 500,
// which it also logs, since it means the editor itself failed.
func (s *Server) writeFailure(w http.ResponseWriter, err error) {
	if refusal, ok := protocol.AsRefusal(err); ok {
		writeJSON(w, protocol.RefusalStatus, refusal)
		return
	}
	fmt.Fprintf(s.log, "infergen: %v\n", err)
	writeError(w, http.StatusInternalServerError, err.Error())
}

// readJSON decodes a size-limited JSON body that has no unknown fields. It
// writes a 400 on failure and reports whether decoding succeeded.
func readJSON(w http.ResponseWriter, r *http.Request, value any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		writeError(w, http.StatusBadRequest, "bad request body: "+err.Error())
		return false
	}
	return true
}

// writeJSON sends value as the JSON body with status.
func writeJSON(w http.ResponseWriter, status int, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "encode reply: "+err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	w.Write(body)
}

// writeError sends an ErrorReply with status.
func writeError(w http.ResponseWriter, status int, message string) {
	// A struct holding one string always encodes.
	body, _ := json.Marshal(protocol.ErrorReply{Error: message})
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	w.Write(body)
}
