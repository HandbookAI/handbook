---
'@handbooks/core': minor
'@handbooks/cli': minor
---

Three fixes to the one config layer that gets committed.

`llmExtraBody` is now declared secret: it is free-form, gateways do take auth in
the request body, and a key-name heuristic would pass whatever shape it was not
taught — so it loses its `--extra-body` flag (shell history, `ps`) and is
refused in a config file, leaving `OPENAI_EXTRA_BODY` /
`HANDBOOK_LLM_EXTRA_BODY` as the route. `llmBaseUrl` stays a flag and stays
welcome in a committed file, because a shared gateway URL is exactly what that
file is for; what is refused there is a URL carrying RFC 3986 userinfo
(`https://user:pass@gw.internal/v1`), which is a credential by position and so
needs no guessing.

`handbook config` no longer dies when the config **file** is the broken thing.
Unparseable YAML, a path that is a directory, a file the process cannot read —
each used to throw during bootstrap and take down the one command whose job is
to explain that situation. It now prints the file, the reason, and the rest of
the resolved configuration, and still exits 2 under `--check`. Every other
command still refuses to run rather than falling back to defaults.

An unknown config-file key is reported instead of silently doing nothing:
`generate: {readWorker: 4}` warns and names `generate.readWorkers`. A warning,
not a failure, so a file written for a newer Handbook keeps working — but
`handbook config --check` counts it as a problem and exits 2.
