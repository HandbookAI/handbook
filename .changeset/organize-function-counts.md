---
'@handbook/pipeline': patch
---

Take `organization`'s `nFunctions` from the call graph instead of the card.

It was read off `card.functions`, which only a **deep** card carries — so in the default
`--detail brief` it was 0 for every file. Measured across seventeen real repositories:
0 for all 8,489 files, while the graph knew gson alone had 3,123 functions.

That number is load-bearing. The agent locator index picks each group's exemplar as its
highest-function-count file and emits the field only when one exists, so a permanent 0
deleted the **Exemplar** section from every page it ever rendered (0 of 156 measured) and
printed "(0 fns)" beside every core file. On gson the fix takes exemplars from 0/7 stage
pages to 7/7 and restores real counts (up to 161 functions in a file).

Synthetic nodes are excluded from the count: they are implicit constructors that appear
in no source file, so counting them would promise a reader functions they would not find.
