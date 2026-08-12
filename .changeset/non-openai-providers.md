---
'@handbooks/llm': minor
'@handbooks/core': minor
'@handbooks/cli': minor
'@handbooks/studio': minor
---

Support endpoints that are not OpenAI-compatible: `--provider anthropic` and
`--provider gemini` alongside the default `openai`. A provider supplies only its
wire format (URL and headers, request body, response parse); retries, deadlines,
cancellation, permanent-error classification and usage metering stay shared.
