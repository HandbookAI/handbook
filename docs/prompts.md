# Prompt catalogue

Every LLM touchpoint in the toolchain. All JSON-producing calls run at temperature 0
(dropped automatically for reasoning-style models). Chinese narration (`--narrate-lang zh`)
keeps JSON keys, enum values, ids and file paths in English; only prose values change.

| #   | Prompt (module)                              | Phase         | Purpose                                                                                                                                                                                                                    | Output contract                                                              |
| --- | -------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | brief card rules (`pipeline/cards.ts`)       | 2a            | 1–2 sentence plain-language purpose + role enum + lifecycle hint per batched file                                                                                                                                          | `{"purposes":[{file,purpose,role,lifecycle}]}`                               |
| 2   | deep card rules (`pipeline/cards.ts`)        | 2a            | full-file walkthrough (120–300 words) + per-function purpose / data_flow / relations keyed by exact qualname; graph facts declared authoritative                                                                           | adds `description`, `functions[]`                                            |
| 3   | chunk fallback (`pipeline/cards.ts`)         | 2a            | same deep rules over one function-chunk of an oversized file                                                                                                                                                               | one `purposes` entry covering the chunk                                      |
| 4   | skeleton synthesis (`pipeline/skeleton.ts`)  | 2b            | ordered narrative spine from directory rollups + entry points; lifecycle order mandated; crosscuts after main flow                                                                                                         | `{"metadata":{archetype},"stages":[{id,title,description,parent,crosscut}]}` |
| 5   | file assignment (`pipeline/assign.ts`)       | 2b            | one primary stage per file from a fixed menu; `also` 0–2; `unassigned` escape for vendored/dead code                                                                                                                       | `{"assignments":[{file,stage,also}]}`                                        |
| 6   | doctor actor (`pipeline/doctor.ts`)          | 2b            | ≤3 structural changes (add_stage / remove_stage / merge_stages / split_stage), prioritized: unassigned → overload → starvation → dead                                                                                      | `{"changes":[…],"rationale"}`                                                |
| 7   | critic roles (`llm/critic.ts`)               | 2b            | role-played review (engineer / architect / reader / editor) of a proposal against ground-truth evidence; APPROVE generously, REJECT only when unfixable                                                                    | `{"decision","concerns","suggested_revision","rationale"}`                   |
| 8   | revise prompt (`llm/critic.ts`)              | 2b            | actor revision addressing aggregated `[role] concern` bullets                                                                                                                                                              | same schema as the original proposal                                         |
| 9   | stage organization (`pipeline/organize.ts`)  | 2c            | 2–8 ordered sub-groups per stage; every file exactly once; narrative order respecting call hints                                                                                                                           | `{"groups":[{title,summary,files}]}`                                         |
| 10  | member classification (`pipeline/member.ts`) | 2b (member)   | assign individual functions/methods to the user-authored stages                                                                                                                                                            | `{"assignments":[{member,stage}]}`                                           |
| 11  | stage rollup (`pipeline/narrate.ts`)         | 3             | 100–200-word non-expert stage overview from child overviews + file one-liners                                                                                                                                              | plain prose only (no JSON, no headers)                                       |
| 12  | system rollup (`pipeline/narrate.ts`)        | 3             | 200–350-word system overview threading the top-level stages                                                                                                                                                                | plain prose only                                                             |
| 13  | register extraction (`pipeline/narrate.ts`)  | 3 round 1     | cross-stage state registers (id + one-line semantics + touched stages) from stage overviews + data_model cards                                                                                                             | `{"registers":[{id,semantics,stages}]}`                                      |
| 14  | register gap pass (`pipeline/narrate.ts`)    | 3 rounds 2+   | ONLY the missing registers given the found list; empty array when dry (loop stops after 2 dry rounds)                                                                                                                      | same schema, new entries only                                                |
| 15  | planner system prompt (`planner/prompt.ts`)  | plan          | route with the handbook → read real source → emit byte-exact EDIT blocks + declarations JSON; executor-trusts-blindly rules (uniqueness, no overlap, smallest span)                                                        | markdown plan ending in one `{"will_modify","will_add","will_remove"}` block |
| 16  | planner tool protocol (`planner/prompt.ts`)  | plan          | one JSON action per turn: `list_dir` / `read_file` / `grep` / `finish`                                                                                                                                                     | `{"tool": …}` action block                                                   |
| 17  | resync evolution label (`studio/server.ts`)  | studio resync | one ≤40-char sentence naming WHICH capabilities/modules a change touched, from touched-file purposes; guessing intent is forbidden (studio's resync has no diff); falls back to a deterministic file list without a client | plain prose, one line (rendered dimmed + tagged `auto`)                      |

## Design rules the prompts share

- **Facts are injected, never asked for.** Function inventories, line ranges and call
  relations come from the graph and are marked as ground truth; the model writes prose
  _around_ them and is told not to re-list them.
- **Menus are closed.** Assignment and classification prompts enumerate valid stage ids
  and instruct "never invent"; anything outside the menu is coerced to `unassigned` on
  parse, so prompt drift cannot corrupt artifacts.
- **Every JSON contract has a mechanical validator** on the consuming side (zod or
  hand-rolled checks); dropped/malformed entries are backfilled deterministically and
  counted in coverage artifacts rather than silently patched.
- **Output-only-JSON / output-only-prose** endings keep parsing unambiguous; the JSON
  extractor tolerates fenced blocks and balanced-brace scans but prompts still ask for a
  single fenced block.
- **Critic prompts push back against rubber-stamping in both directions**: approve
  correct-enough proposals (no vacuous REVISE — those are normalized to APPROVE), but a
  broken critic call counts as REJECT so infrastructure failures never approve changes.
