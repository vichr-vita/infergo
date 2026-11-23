package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/vichr-vita/infergo/internal/edit/protocol"
)

// eventOrder is the order in which a new stream receives the events that
// exist so far.
var eventOrder = []string{protocol.EventModel, protocol.EventHistory, protocol.EventCheck, protocol.EventValues}

// hub keeps the newest payload of each event and fans changes out to the open
// streams. A stream that falls behind skips to the newest payload of each
// event, so a slow page never holds up the server.
type hub struct {
	mu       sync.Mutex
	payloads map[string][]byte
	streams  map[*stream]struct{}
}

// stream is one connected page. pending lists, in order, the events it has
// not been sent since they last changed. signal wakes its handler.
type stream struct {
	pending []string
	signal  chan struct{}
}

func newHub() *hub {
	return &hub{payloads: map[string][]byte{}, streams: map[*stream]struct{}{}}
}

// publish stores value as the newest payload of the named event and queues it
// for every stream.
func (h *hub) publish(name string, value any) {
	data, err := json.Marshal(value)
	if err != nil {
		// Every event type encodes, so this is a programming error.
		panic(fmt.Sprintf("encode %s event: %v", name, err))
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.payloads[name] = data
	for s := range h.streams {
		s.queue(name)
	}
}

// subscribe opens a stream with every existing event queued in eventOrder.
func (h *hub) subscribe() *stream {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := &stream{signal: make(chan struct{}, 1)}
	for _, name := range eventOrder {
		if h.payloads[name] != nil {
			s.queue(name)
		}
	}
	h.streams[s] = struct{}{}
	return s
}

func (h *hub) unsubscribe(s *stream) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.streams, s)
}

// take returns the stream's queued events with their newest payloads and
// empties the queue.
func (h *hub) take(s *stream) (names []string, payloads [][]byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	names, s.pending = s.pending, nil
	for _, name := range names {
		payloads = append(payloads, h.payloads[name])
	}
	return names, payloads
}

// queue adds name unless it is already waiting, and wakes the handler. The
// caller holds the hub's lock.
func (s *stream) queue(name string) {
	if !slices.Contains(s.pending, name) {
		s.pending = append(s.pending, name)
	}
	select {
	case s.signal <- struct{}{}:
	default:
	}
}

// serveEvents streams server-sent events: on connect the model, the history,
// and the latest check, then each change as it happens.
func (s *Server) serveEvents(w http.ResponseWriter, r *http.Request) {
	controller := http.NewResponseController(w)
	header := w.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if err := controller.Flush(); err != nil {
		return
	}
	stream := s.hub.subscribe()
	defer s.hub.unsubscribe(stream)
	ticker := time.NewTicker(keepAlive)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if _, err := fmt.Fprint(w, ": keep-alive\n\n"); err != nil {
				return
			}
		case <-stream.signal:
			names, payloads := s.hub.take(stream)
			for i, name := range names {
				if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, payloads[i]); err != nil {
					return
				}
			}
		}
		// A failed flush means the page went away.
		if err := controller.Flush(); err != nil {
			return
		}
	}
}
