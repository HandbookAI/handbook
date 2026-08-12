---
'@handbooks/pipeline': minor
---

Discard "state registers" that touch fewer than two stages.

A register is defined as state that flows **across** stages — `register.md` calls it
"cross-stage state" and its whole purpose is answering "which stages does this change fan
out to". One that lists a single stage answers nothing and dilutes the ones that do.

Measured against real repositories generated with a live endpoint: **47% of ripgrep's 73
registers, 27% of cobra's and 25% of requests'** listed exactly one stage. The cause was
partly the prompt itself — it asked for cross-stage state while its own worked example
showed `"stages": ["stage-5"]`, and the stage-fill pass told the model to "pick 1-5". Both
are corrected, and the rule is now enforced in code rather than requested in prose.

Registers whose stages could not be determined at all are discarded for the same reason:
a register that cannot be placed cannot answer the question the table exists to answer.
The count of dropped entries is logged.
