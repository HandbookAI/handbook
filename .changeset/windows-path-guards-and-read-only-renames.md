---
'@handbook/patcher': patch
'@handbook/studio': patch
---

Fix three path guards that were quietly platform-dependent, all found by running the
suite on Windows for the first time in a while.

`apply`'s "the parent path is a regular file" refusal never ran on Windows. It split the
edit's path on `/` after `path.normalize`, which hands back NATIVE separators there, so
`blocker/child.py` became one segment, the ancestor loop had nothing to walk, and the
refusal the caller was owed arrived as a raw `EEXIST: mkdir` thrown out of the write
phase — a `not-a-file` outcome on every other platform. Plan paths are POSIX by rule
(`parse` rejects a backslash as "must use forward slashes"), so the path is converted
back with `toPosix` rather than split on both separators: on POSIX a backslash is a legal
filename character and must not split.

`apply` also could not patch a read-only file on Windows. A rename needs a writable
PARENT directory on POSIX, and the file's own mode is irrelevant; Windows additionally
consults the destination's read-only attribute and refuses with `EPERM`, so one
`mode 444` file failed the entire apply — after staging, mid-rename, reported as an
errno rather than an outcome. The write bit is now added only after the OS has actually
refused, and the recorded mode is restored either way, so the file's mode is unchanged
by the time `apply` returns and no platform pays for the extra syscalls on the path
where the rename works.

Studio's registry accepted a work dir whose symlink target does not exist yet — the
normal case, since studio creates the work dir AFTER the entry is accepted, and the run
that creates it is exactly the run that would drop artifacts inside the source tree.
`realpath` fails on a dangling link, and the containment check fell back to comparing the
link's own path, which turns every overlap test in that file back into the string
comparison it exists to replace. It now reads the link and resolves its target (bounded,
so a link pointing at itself cannot spin). Windows reached the same fallback for a link
that was NOT dangling: a file-typed symlink to a directory does not resolve there at all.
