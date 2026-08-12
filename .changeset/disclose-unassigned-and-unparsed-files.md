---
'@handbook/analyzer': minor
'@handbook/pipeline': minor
'@handbook/renderer': minor
'@handbook/core': minor
---

Stop dropping two things the pipeline already knew: files no stage claims, and files the
parser could not read.

**Files in no stage.** `assignment.coverage.unassigned` was part of `HandbookModel` and
no renderer read it. Every page is built from `assignment.buckets`, which excludes those
files by construction, while the headline count is `coverage.nFiles`, which includes
them — so a handbook could say "300 files", contain 260 cards, and name the other 40
nowhere at all: no page, no `llms.txt`, no agent index. The markdown stage index, the
HTML overview (and the single-page render), the agent locator index and `llms-full.txt`
now list them explicitly with a one-line explanation, `llms.txt` discloses the split, the
HTML search index resolves those paths instead of dead-ending, and any printed total now
reads `assigned / total` rather than a number the pages themselves contradict.

**Files the parser could not read.** The adapter driver had two silent `continue`s — an
unreadable file and a null parse tree — and nothing anywhere consulted
`rootNode.hasError`. All three left the file in `graph.metadata.scannedFiles` with zero
functions, so the cards pass described it as "a file with 0 functions" and
`_coverage.json` counted it as fully described: the handbook asserted, as a parser fact,
something no parser had seen. Analyses now carry `unparsedFiles` (`unreadable` /
`unparsable` / `partial`, each with its real cause), phase 1 writes them to
`phase1/scan-coverage.json` beside `dropped-calls.json` and stamps them into
`graph.metadata`, files that yielded no facts are kept out of `scannedFiles`, partially
parsed files stay but are disclosed as incomplete, and phase 1 closes with a line naming
the gap.
