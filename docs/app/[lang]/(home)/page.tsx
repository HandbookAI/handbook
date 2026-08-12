import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowRight, Boxes, GitCompareArrows, ScanSearch, ShieldCheck, Sparkles } from 'lucide-react';
import { siteMetadata } from '@/lib/seo';
import { i18n } from '@/lib/i18n';
import { home } from '@/lib/home-strings';

/**
 * No title or description of its own.
 *
 * `siteMetadata(lang)` already carries both, per locale. Overriding them here
 * with the module-level English constants is what made every non-English page
 * ship an English `<title>` and an English unfurl — the same bug as the body
 * copy, one layer up. One producer only.
 *
 * `title` is dropped rather than passed through, because the layout above
 * already sets `title.default` plus a `%s · Handbook` template for its children.
 * A page that supplies ANY title counts as such a child, so the template wraps
 * it and the wordmark lands twice — `Handbook — … · Handbook`, which is what
 * this page's `<title>` has always said. With no title here, the layout's
 * default is used verbatim and the template does not apply to it.
 */
export async function generateMetadata(props: PageProps<'/[lang]'>): Promise<Metadata> {
  const { lang } = await props.params;
  const meta = siteMetadata(lang);
  delete meta.title;
  return meta;
}

/**
 * The pipeline, structurally: the order, the command names and which steps reach
 * a model. Nothing here is language-dependent — the command names are the CLI's
 * own, and translating one would make it wrong to type. The sentence under each
 * comes from the strings table, keyed by `cmd`.
 */
const STEPS = [
  { n: '1', cmd: 'analyze', llm: false },
  { n: '2', cmd: 'generate', llm: true },
  { n: '3', cmd: 'render', llm: false },
  { n: '4', cmd: 'skill', llm: false },
  { n: '5', cmd: 'plan', llm: true },
  { n: '6', cmd: 'apply', llm: false },
  { n: '7', cmd: 'resync', llm: true },
] as const;

/** Which icon illustrates which pillar. The copy is keyed by the same name. */
const PILLARS = [
  { icon: ScanSearch, key: 'parser' },
  { icon: Sparkles, key: 'prose' },
  { icon: Boxes, key: 'routing' },
  { icon: ShieldCheck, key: 'applying' },
  { icon: GitCompareArrows, key: 'incremental' },
] as const;

export default async function HomePage(props: PageProps<'/[lang]'>) {
  const { lang } = await props.params;
  const t = home(lang);
  // Every in-page link has to carry the locale, or clicking "Read the docs" in
  // Japanese silently drops you back into English.
  const p = lang === i18n.defaultLanguage ? '' : `/${lang}`;
  // The diagram is a picture of a page full of words, and there is a translated
  // one per locale in `assets/` — the same convention the MDX pages follow. The
  // English file has no suffix, so its slot in this expression is empty.
  const diagram = `/diagrams/pipeline${lang === i18n.defaultLanguage ? '' : `.${lang}`}.svg`;

  const FORMATS: readonly { title: string; body: string }[] = [
    t.formats.markdown,
    t.formats.html,
    t.formats.single,
    t.formats.agent,
    // Both halves of this title are file names, so it has no translated form.
    { title: 'llms.txt + llms-full.txt', body: t.formats.llms.body },
    t.formats.skill,
  ];

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
            {t.badgeLanguages} · {t.badgeEndpoint} · MIT
          </span>

          <h1 className="mt-7 text-balance text-4xl font-extrabold leading-[1.08] tracking-tight md:text-6xl">
            {/* No `{' '}` between the halves: Chinese and Japanese do not put a
                space there, and an inserted one reads as a typo. Each locale's
                `headline` carries its own trailing separator instead. */}
            {t.headline}
            <span className="bg-gradient-to-r from-teal-400 via-sky-400 to-violet-400 bg-clip-text text-transparent">
              {t.headlineAccent}
            </span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-fd-muted-foreground md:text-xl">
            {t.heroLead}
            <strong>{t.heroEmphasis}</strong>
            {t.heroRest}
          </p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={`${p}/docs/getting-started/quickstart`}
              className="inline-flex items-center gap-2 rounded-lg bg-fd-primary px-5 py-3 text-sm font-semibold text-fd-primary-foreground transition-opacity hover:opacity-90"
            >
              {t.ctaDemo} <ArrowRight className="size-4" />
            </Link>
            <Link
              href={`${p}/docs`}
              className="inline-flex items-center gap-2 rounded-lg border border-fd-border px-5 py-3 text-sm font-semibold transition-colors hover:bg-fd-accent"
            >
              {t.ctaDocs}
            </Link>
          </div>

          <div className="mx-auto mt-10 max-w-xl overflow-x-auto rounded-xl border border-fd-border bg-fd-card p-5 text-left">
            <pre className="text-[13px] leading-relaxed">
              <code>
                {/* The comment is prose and is translated; the two command lines
                    are meant to be pasted, so they are not. */}
                <span className="text-fd-muted-foreground">{t.snippetComment}</span>
                {'\n'}pnpm install && pnpm build{'\n'}pnpm demo
              </code>
            </pre>
          </div>
          <p className="mt-3 text-xs text-fd-muted-foreground">{t.snippetNote}</p>
        </div>
      </section>

      {/* ── pipeline ───────────────────────────────────────────────────── */}
      <section className="border-b border-fd-border px-6 py-16">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-center text-2xl font-bold tracking-tight md:text-3xl">{t.pipelineTitle}</h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-fd-muted-foreground">{t.pipelineLede}</p>

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
                    {s.llm ? 'LLM' : t.noLlm}
                  </span>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-fd-muted-foreground">{t.steps[s.cmd]}</p>
              </li>
            ))}
            <li className="grid place-items-center rounded-xl border border-dashed border-fd-border p-5 text-center">
              <Link href={`${p}/docs/concepts/pipeline`} className="text-sm font-semibold hover:underline">
                {t.pipelineMore} →
              </Link>
            </li>
          </ol>

          <figure className="mt-12">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={diagram}
              alt={t.pipelineDiagramAlt}
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
          <h2 className="text-center text-2xl font-bold tracking-tight md:text-3xl">{t.pillarsTitle}</h2>
          <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {PILLARS.map(({ icon: Icon, key }) => (
              <div key={key} className="rounded-xl border border-fd-border bg-fd-card p-6">
                <Icon className="size-6 text-fd-primary" />
                <h3 className="mt-4 text-base font-bold">{t.pillars[key].title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">{t.pillars[key].body}</p>
              </div>
            ))}
            <div className="rounded-xl border border-dashed border-fd-border p-6">
              <h3 className="text-base font-bold">{t.limitsTitle}</h3>
              <p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">{t.limitsBody}</p>
              <Link
                href={`${p}/docs/concepts/analysis-fidelity`}
                className="mt-4 inline-block text-sm font-semibold hover:underline"
              >
                {t.limitsLink} →
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── outputs ────────────────────────────────────────────────────── */}
      <section className="border-b border-fd-border px-6 py-16">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-center text-2xl font-bold tracking-tight md:text-3xl">{t.formatsTitle}</h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-fd-muted-foreground">{t.formatsLede}</p>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FORMATS.map(({ title, body }) => (
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
          <h2 className="text-2xl font-bold tracking-tight md:text-3xl">{t.closingTitle}</h2>
          <p className="mt-4 text-fd-muted-foreground">
            {t.closingBefore}
            <code className="rounded bg-fd-muted px-1.5 py-0.5 font-mono text-sm">handbook analyze</code>
            {t.closingAfter}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              href={`${p}/docs/getting-started/installation`}
              className="inline-flex items-center gap-2 rounded-lg bg-fd-primary px-5 py-3 text-sm font-semibold text-fd-primary-foreground transition-opacity hover:opacity-90"
            >
              {t.ctaInstall} <ArrowRight className="size-4" />
            </Link>
            <Link
              href={`${p}/docs/reference/cli`}
              className="inline-flex items-center gap-2 rounded-lg border border-fd-border px-5 py-3 text-sm font-semibold transition-colors hover:bg-fd-accent"
            >
              {t.ctaCli}
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
