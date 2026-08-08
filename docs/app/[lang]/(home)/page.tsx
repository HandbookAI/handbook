import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowRight, Boxes, GitCompareArrows, ScanSearch, ShieldCheck, Sparkles } from 'lucide-react';
import { appName, description, tagline } from '@/lib/shared';
import { siteMetadata } from '@/lib/seo';
import { i18n } from '@/lib/i18n';

export async function generateMetadata(props: PageProps<'/[lang]'>): Promise<Metadata> {
  const { lang } = await props.params;
  return { ...siteMetadata(lang), title: `${appName} — ${tagline}`, description };
}

const STEPS = [
  { n: '1', cmd: 'analyze', llm: false, what: 'Parse every file into a typed call graph.' },
  { n: '2', cmd: 'generate', llm: true, what: 'Cards, stages, prose, cross-stage state.' },
  { n: '3', cmd: 'render', llm: false, what: 'Markdown, HTML, agent index, llms.txt.' },
  { n: '4', cmd: 'skill', llm: false, what: 'Package it for your coding agent.' },
  { n: '5', cmd: 'plan', llm: true, what: 'Localize a change into byte-exact edits.' },
  { n: '6', cmd: 'apply', llm: false, what: 'All-or-nothing patch, with rollback.' },
  { n: '7', cmd: 'resync', llm: true, what: 'Roll the handbook forward. No rebuild.' },
];

const PILLARS = [
  {
    icon: ScanSearch,
    title: 'Facts come from a parser',
    body: 'tree-sitter builds the call graph: functions, resolved edges, boundary calls, and the calls it could not resolve — quarantined, never guessed. This layer never touches an LLM, so it is the same every run.',
  },
  {
    icon: Sparkles,
    title: 'Prose sits on top, and says so',
    body: 'An LLM writes what a file is for and how a subsystem hangs together, always anchored to the graph. Where it fails, the structure still ships with an empty description. A missing sentence beats an invented one.',
  },
  {
    icon: Boxes,
    title: 'Built for routing, not reading',
    body: 'The output answers "which files, functions and state does this change touch?" — including the scattered, non-obvious ones a text search misses. Then the planner reads the real source at every address.',
  },
  {
    icon: ShieldCheck,
    title: 'Applying is boring on purpose',
    body: 'Anchors must match byte-exactly and uniquely. Everything is verified before anything is written. Every touched file is backed up with its pre-patch hash, so rollback can prove what it is restoring.',
  },
  {
    icon: GitCompareArrows,
    title: 'It stays current incrementally',
    body: 'Resync diffs the old graph against the new one and regenerates only what actually changed. Touch three files, pay for three files. Documentation stops rotting because updating it stopped being expensive.',
  },
];

const FORMATS = [
  ['Markdown handbook', 'overview · index · one page per stage · state-register table'],
  ['Multi-page HTML site', 'sticky TOC, breadcrumbs, theme toggle — works over file://'],
  ['One self-contained page', 'a single .html you can email or attach to a ticket'],
  ['Agent locator index', 'duty · entry concepts · state · exemplars · co-change hints'],
  ['llms.txt + llms-full.txt', 'the llms.txt convention, plus the whole thing flattened'],
  ['Agent SKILL package', 'SKILL.md + references/ + a content hash per file'],
];

export default async function HomePage(props: PageProps<'/[lang]'>) {
  const { lang } = await props.params;
  // Every in-page link has to carry the locale, or clicking "Read the docs" in
  // Japanese silently drops you back into English.
  const p = lang === i18n.defaultLanguage ? '' : `/${lang}`;
  return (
    <main className="flex flex-1 flex-col">
      {/* ── hero ───────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b border-fd-border px-6 py-20 md:py-28">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-60 [background:radial-gradient(700px_380px_at_18%_-10%,rgba(45,212,191,.16),transparent_60%),radial-gradient(700px_380px_at_88%_10%,rgba(167,139,250,.16),transparent_60%)]"
        />
        <div className="relative mx-auto max-w-5xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card px-3.5 py-1.5 text-xs font-semibold tracking-wide text-fd-muted-foreground">
            <span className="size-1.5 rounded-full bg-teal-400" />
            18 LANGUAGES · ANY OPENAI-COMPATIBLE ENDPOINT · MIT
          </span>

          <h1 className="mt-7 text-balance text-4xl font-extrabold leading-[1.08] tracking-tight md:text-6xl">
            Turn any codebase into a handbook{' '}
            <span className="bg-gradient-to-r from-teal-400 via-sky-400 to-violet-400 bg-clip-text text-transparent">
              your agent can actually route with.
            </span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-fd-muted-foreground md:text-xl">
            Your coding agent greps for a symbol, finds three of the seven places that matter, and ships a
            half-change. That is a <strong>routing</strong> failure, not a reasoning one. Handbook gives it
            the map.
          </p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={`${p}/docs/getting-started/quickstart`}
              className="inline-flex items-center gap-2 rounded-lg bg-fd-primary px-5 py-3 text-sm font-semibold text-fd-primary-foreground transition-opacity hover:opacity-90"
            >
              Run the offline demo <ArrowRight className="size-4" />
            </Link>
            <Link
              href={`${p}/docs`}
              className="inline-flex items-center gap-2 rounded-lg border border-fd-border px-5 py-3 text-sm font-semibold transition-colors hover:bg-fd-accent"
            >
              Read the docs
            </Link>
          </div>

          <div className="mx-auto mt-10 max-w-xl overflow-x-auto rounded-xl border border-fd-border bg-fd-card p-5 text-left">
            <pre className="text-[13px] leading-relaxed">
              <code>
                <span className="text-fd-muted-foreground"># full pipeline, offline, no API key, ~30s</span>
                {'\n'}pnpm install && pnpm build{'\n'}pnpm demo
              </code>
            </pre>
          </div>
          <p className="mt-3 text-xs text-fd-muted-foreground">
            Bundled sample project, bundled mock LLM. Zero tokens spent.
          </p>
        </div>
      </section>

      {/* ── pipeline ───────────────────────────────────────────────────── */}
      <section className="border-b border-fd-border px-6 py-16">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-center text-2xl font-bold tracking-tight md:text-3xl">
            Seven commands, one loop
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-fd-muted-foreground">
            Teal steps are deterministic — no LLM, no network, free to re-run in CI. Amber steps talk to your
            endpoint, and cache what they learn.
          </p>

          <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s) => (
              <li
                key={s.cmd}
                className="rounded-xl border border-fd-border bg-fd-card p-5 transition-colors hover:border-fd-primary/40"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`grid size-6 place-items-center rounded-full text-[11px] font-extrabold text-[#0b1020] ${
                      s.llm ? 'bg-amber-400' : 'bg-teal-400'
                    }`}
                  >
                    {s.n}
                  </span>
                  <code className="font-mono text-base font-bold">{s.cmd}</code>
                  <span
                    className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide ${
                      s.llm
                        ? 'bg-amber-400/15 text-amber-500'
                        : 'bg-teal-400/15 text-teal-500 dark:text-teal-400'
                    }`}
                  >
                    {s.llm ? 'LLM' : 'NO LLM'}
                  </span>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-fd-muted-foreground">{s.what}</p>
              </li>
            ))}
            <li className="grid place-items-center rounded-xl border border-dashed border-fd-border p-5 text-center">
              <Link href={`${p}/docs/concepts/pipeline`} className="text-sm font-semibold hover:underline">
                How each phase works →
              </Link>
            </li>
          </ol>

          <figure className="mt-12">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/diagrams/pipeline.svg"
              alt="The Handbook pipeline: analyze, generate, render, skill, plan, apply, and the resync feedback loop"
              className="w-full rounded-xl border border-fd-border"
              width={1120}
              height={660}
            />
          </figure>
        </div>
      </section>

      {/* ── pillars ────────────────────────────────────────────────────── */}
      <section className="border-b border-fd-border px-6 py-16">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-center text-2xl font-bold tracking-tight md:text-3xl">
            Why you can trust what you read
          </h2>
          <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {PILLARS.map(({ icon: Icon, title, body }) => (
              <div key={title} className="rounded-xl border border-fd-border bg-fd-card p-6">
                <Icon className="size-6 text-fd-primary" />
                <h3 className="mt-4 text-base font-bold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">{body}</p>
              </div>
            ))}
            <div className="rounded-xl border border-dashed border-fd-border p-6">
              <h3 className="text-base font-bold">And it discloses its own limits</h3>
              <p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">
                Languages read by the config-driven analyzer are named in the overview, so &ldquo;best-effort
                call relations&rdquo; can never be read as &ldquo;exact&rdquo;.
              </p>
              <Link
                href={`${p}/docs/concepts/analysis-fidelity`}
                className="mt-4 inline-block text-sm font-semibold hover:underline"
              >
                Analysis fidelity →
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── outputs ────────────────────────────────────────────────────── */}
      <section className="border-b border-fd-border px-6 py-16">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-center text-2xl font-bold tracking-tight md:text-3xl">
            One run. Six shipping formats.
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-fd-muted-foreground">
            Generation is the expensive part and it happens once. Everything below is a deterministic
            re-render you can run on every commit.
          </p>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FORMATS.map(([title, body]) => (
              <div key={title} className="rounded-xl border border-fd-border bg-fd-card p-5">
                <h3 className="text-sm font-bold">{title}</h3>
                <p className="mt-1.5 text-sm text-fd-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── closing ────────────────────────────────────────────────────── */}
      <section className="px-6 py-20">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-2xl font-bold tracking-tight md:text-3xl">Start with the free command</h2>
          <p className="mt-4 text-fd-muted-foreground">
            <code className="rounded bg-fd-muted px-1.5 py-0.5 font-mono text-sm">handbook analyze</code>{' '}
            never needs an API key. Run it on your repo, look at the file and function counts, and decide
            whether the rest is worth a single token.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              href={`${p}/docs/getting-started/installation`}
              className="inline-flex items-center gap-2 rounded-lg bg-fd-primary px-5 py-3 text-sm font-semibold text-fd-primary-foreground transition-opacity hover:opacity-90"
            >
              Install <ArrowRight className="size-4" />
            </Link>
            <Link
              href={`${p}/docs/reference/cli`}
              className="inline-flex items-center gap-2 rounded-lg border border-fd-border px-5 py-3 text-sm font-semibold transition-colors hover:bg-fd-accent"
            >
              CLI reference
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
