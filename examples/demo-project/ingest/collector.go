// Package ingest pulls raw samples off the wire and hands them on.
package ingest

import "fmt"

// SourceKind is a defined type, not an alias: a plain string must not be usable
// where a kind is expected.
type SourceKind string

const (
	KindHTTP  SourceKind = "http"
	KindStdin SourceKind = "stdin"
)

// Sample is one measurement as it arrived, before any validation.
type Sample struct {
	Metric string
	Value  float64
	Kind   SourceKind
}

// Source is anything a collector can drain.
type Source interface {
	Next() (Sample, bool)
	Kind() SourceKind
}

// Collector drains one source until it is empty, dropping samples it cannot
// trust rather than repairing them.
type Collector struct {
	source  Source
	dropped int
}

func NewCollector(source Source) *Collector {
	return &Collector{source: source}
}

// Drain returns every sample that passed validation. A rejected sample is
// counted, never silently corrected.
func (c *Collector) Drain() []Sample {
	var kept []Sample
	for {
		sample, ok := c.source.Next()
		if !ok {
			return kept
		}
		if !valid(sample) {
			c.dropped++
			continue
		}
		kept = append(kept, sample)
	}
}

// Dropped reports how many samples were refused, so a caller can tell an empty
// result from a rejected one.
func (c *Collector) Dropped() int {
	return c.dropped
}

func valid(s Sample) bool {
	return s.Metric != "" && s.Value == s.Value // NaN fails the self-comparison
}

func (c *Collector) Describe() string {
	return fmt.Sprintf("collector(%s, dropped=%d)", c.source.Kind(), c.dropped)
}
