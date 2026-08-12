---
'@handbooks/cli': patch
---

Take `handbook --version` from the CLI's own manifest instead of a second copy of it.

It was `.version('0.1.0')`, a literal, while the manifests had moved to `1.1.0` — so
the flag whose only job is to say which version is installed named one that had not
existed for two minor releases. That is worse than unhelpful in a bug report: a
version string is what a maintainer trusts to decide whether a fix is already present.

The cause is structural, not a typo. `changeset version` rewrites `package.json` and
nothing else, so any literal elsewhere drifts by one release every time the tool does
its job — which is why the fix reads the manifest rather than correcting the number.
`rootDir` is `src` and `outDir` is `dist`, so `../package.json` is the manifest both
from source and from the published tarball; npm includes it regardless of `files`.

An unreadable or versionless manifest yields `0.0.0-unknown` rather than throwing:
`--version` is built at module load, so a damaged install must not take every other
command down with it, and a deliberately implausible string cannot be mistaken for a
real release. `scripts/smoke-install.mjs` already compared the two — it is what caught
this, against a real `npm install` of the packed tarballs — but only under
`check:all`; the drift now also fails `pnpm check`.
