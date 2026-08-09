/**
 * Browser test for the Studio run progress.
 *
 *   handbook studio --port 4860 &
 *   node scripts/browser/studio-progress.mjs http://127.0.0.1:4860 [source-dir]
 *
 * A generate is minutes of silence unless something reports. This drives a real
 * run through the SSE stream and asserts the progress events actually arrive,
 * carry a run-level figure, and advance through every phase — the failure this
 * caught first time was three of the four passes never reporting at all,
 * because their sinks were declared and never wired.
 */
import { launch, tally } from './cdp.mjs';
const B = (process.argv[2] ?? process.env.STUDIO_BASE_URL ?? 'http://127.0.0.1:4860').replace(/\/+$/, '');
const SOURCE = process.argv[3] ?? new URL('../../packages/core/src', import.meta.url).pathname;
const t = tally('progress-ui');
const b = await launch();
await b.setViewport(1440, 900);
await b.goto(B, { waitMs: 2500 });
// Register a repo big enough that the cards pass ticks more than once.
await b.eval(
  `fetch('/api/repos',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'p',sourceRoot:${JSON.stringify(SOURCE)}})}).then((r) => r.status)`,
);
await new Promise((r) => setTimeout(r, 800));
// Start a generate and watch the SSE stream for progress events.
const seen = await b.eval(`(async () => {
  const j = await (await fetch('/api/repos/p/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({narrateLang:'en'})})).json();
  return await new Promise((resolve) => {
    const events = []; const es = new EventSource('/api/jobs/' + j.id + '/stream');
    es.addEventListener('progress', (e) => { try { events.push(JSON.parse(e.data)); } catch {} });
    es.addEventListener('done', () => { es.close(); resolve(events); });
    setTimeout(() => { es.close(); resolve(events); }, 90000);
  });
})()`);
t.ok('the run emits progress events', seen.length > 0, `${seen.length} events`);
const withOverall = seen.filter((e) => e.overall);
t.ok('they carry an overall figure', withOverall.length > 0, `${withOverall.length} with overall`);
const phases = [...new Set(withOverall.map((e) => e.overall.phase && e.overall.phase.name).filter(Boolean))];
t.ok('the coarse phase bar advances through phases', phases.length >= 2, JSON.stringify(phases));
const scopes = [...new Set(seen.map((e) => e.scope))];
t.ok('more than one pass reports', scopes.length >= 2, JSON.stringify(scopes));
const pcts = withOverall.map((e) => e.overall.pct);
t.ok(
  'overall percentage is within 0-100',
  pcts.every((p) => p >= 0 && p <= 100),
  `min=${Math.min(...pcts)} max=${Math.max(...pcts)}`,
);
t.ok(
  'an ETA is produced at some point',
  withOverall.some((e) => typeof e.overall.etaSec === 'number'),
);
b.close();
process.exit(t.done() ? 0 : 1);
