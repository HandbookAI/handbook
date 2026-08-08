---
'@handbook/analyzer': minor
---

Fix an analyze that died partway through large polyglot repositories, and recognize
assignment-style JavaScript function definitions.

**WASM lifetime.** Parsed trees own memory in one WASM instance shared by every grammar,
and the JavaScript garbage collector cannot reclaim it. Holding every tree for the whole
process exhausted the shared resource: on a 4,937-file repository, after C++ (566 files),
Dart (3,351), Java (510) and Kotlin (343), the first `new Parser()` Objective-C asked for
died with `RuntimeError: table index is out of bounds` and took the whole run with it.
Trees are now freed once pass 2 has read them — never before, since `extractCalls` walks
nodes that point into them — which bounds the peak to one language instead of the process.
Parsers are freed too. That repository now completes: 71,039 functions, 321,803 edges.

**Assignment-style definitions.** `res.send = function send() {}`,
`exports.f = function f() {}`, `module.exports.f = …`, `Thing.prototype.f = …` and
object-literal methods (`const api = { run() {} }`) were all invisible. Measured on
Express, whose entire public API is written that way: 11 of ~78 functions found in `lib/`,
2 of the 22 methods in `lib/response.js`. Now 141 functions and 76 edges where there were
55 and 8. What cannot be honestly named — `lookup[key] = fn`, `factory().f = fn` — is
still skipped rather than given an invented owner.

**Shell diagnostics.** The warning for files the grammar could not parse now names the
cause when it is the known bash one, because `case` is ubiquitous and "5 files skipped"
without a reason reads as "the tool found little" rather than "these functions are absent".
