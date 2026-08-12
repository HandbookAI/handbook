---
'@handbooks/cli': patch
---

Add `HANDBOOK_ENV_FILE` as a collision-free equivalent of `--env-file`.

Node 20.6 introduced its own `--env-file` flag, and node pre-scans the entire command
line for it — including the part after the script path, where it does not apply the
file. A path that exists therefore reaches the CLI untouched, but a path that does not
exist kills the process first:

    $ handbook --env-file /gone.env config
    node: /gone.env: not found        # node, exit 9, before main.ts runs

which is precisely the case `--env-file` is documented to report loudly. An environment
variable cannot be intercepted, so `HANDBOOK_ENV_FILE` is now the reliable route. The
flag keeps working whenever the file is actually there, and still wins when both are set.
