---
'@handbook/pipeline': patch
---

Fix the bundled mock LLM server truncating any path that contains a space.

Every path was captured with `\S+`, which stops at the first space, so a card came back
naming `Example/Classes/Networking` for a file called
`Example/Classes/Networking Extensions/AFAppDotNetAPIClient.m`. The pipeline correctly
rejected the mismatched reply and recorded the miss — so the offline demo reported 62 of
80 files covered on a repository the real pipeline handles completely, which reads as a
flaw in the tool rather than in the mock. Paths are now captured up to their double-space
separator.
