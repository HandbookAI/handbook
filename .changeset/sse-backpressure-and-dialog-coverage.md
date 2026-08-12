---
'@handbook/studio': patch
---

Studio's SSE job stream no longer lets a subscriber that stopped reading grow the
server's memory without bound.

`res.write()` never refuses, so a subscriber that connects and then stops reading —
a browser tab throttled in the background, a paused debugger, a `curl` piped into
something slow, a half-open socket — made Node buffer every log line in the studio
process for as long as the job ran. Measured: one non-reading loopback socket held
8 MB after 4000 lines and would have kept going, and a `generate` on a large repo
emits thousands.

Writes now stop the moment the response reports backpressure, live lines queue into
a bounded buffer (512 lines / 1 MB), and once it is full the OLDEST are dropped and
the gap is disclosed as its own `dropped` SSE event, in the position it happened —
the drawer prints "N log lines dropped … reload to see the full log", in all eight
locales. The two alternatives were both worse: pausing the producer slows a run down
for a spectator, and hanging up on the subscriber makes this UI report a job that is
still running as finished. The full log is still kept on the job and re-fetchable,
which is what makes a gap in the live view affordable.

Two details this depends on: the backlog replay walks `job.log` by index rather than
being queued, so a healthy subscriber — whose multi-megabyte replay trips
backpressure within its first ~30 lines — still receives all of it; and `progress` is
coalesced rather than queued, because a progress event is a snapshot and an older one
is worthless.
