package ingest

// HTTPSource replays a fixed batch, which is all the demo needs: the point is
// that it satisfies Source, not that it speaks HTTP.
type HTTPSource struct {
	pending []Sample
	cursor  int
}

func NewHTTPSource(samples []Sample) *HTTPSource {
	return &HTTPSource{pending: samples}
}

func (h *HTTPSource) Next() (Sample, bool) {
	if h.cursor >= len(h.pending) {
		return Sample{}, false
	}
	sample := h.pending[h.cursor]
	h.cursor++
	return sample, true
}

func (h *HTTPSource) Kind() SourceKind {
	return KindHTTP
}

// Remaining exists so the CLI can report progress without draining.
func (h *HTTPSource) Remaining() int {
	return len(h.pending) - h.cursor
}
