/**
 * A minimal Chrome DevTools Protocol driver: real Chrome, real clicks, real keys.
 *
 * No dependencies. CDP is a WebSocket protocol and Node has had a global
 * `WebSocket` since 22, so a browser test needs nothing installed beyond a
 * Chrome that is already on the machine (and on GitHub's ubuntu runners).
 *
 * This exists because the bugs it is meant to catch are invisible to any other
 * kind of test. A page whose JavaScript never loads still server-renders
 * perfectly, passes a fetch-based check, and is completely inert in a browser —
 * which is exactly the failure that shipped once already.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Chrome lives, in the order worth trying: an explicit override first,
 * then the usual macOS bundle, then the names the Linux runner images install.
 */
const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

export function findChrome() {
  const hit = CANDIDATES.find((path) => existsSync(path));
  if (!hit) {
    throw new Error(
      `no Chrome found. Tried:\n  ${CANDIDATES.join('\n  ')}\nSet CHROME_PATH to point at one.`,
    );
  }
  return hit;
}

/**
 * Ask the OS for a port nobody is using, rather than picking one and hoping.
 * These suites start a fresh browser per feature area, so "probably free" turns
 * into an occasional unexplained launch failure — which in CI reads as a broken
 * site rather than as a broken harness.
 */
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((res, rej) => {
    const server = createServer();
    server.on('error', rej);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => res(port));
    });
  });
}

export async function launch(options = {}) {
  // One retry: the port is free when we ask for it, but another process can
  // still take it in the moment between closing the probe and Chrome binding.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await launchOnce(options);
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }
}

async function launchOnce({ headless = true, width = 1440, height = 900 } = {}) {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'hb-cdp-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    // Containers give /dev/shm 64MB, which Chrome will happily exhaust.
    '--disable-dev-shm-usage',
    // CI runners run as root; Chrome refuses the sandbox there.
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');
  const proc = spawn(findChrome(), args, { stdio: 'ignore' });

  let target;
  for (let i = 0; i < 150; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target?.webSocketDebuggerUrl) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!target) {
    proc.kill('SIGKILL');
    throw new Error('Chrome started but never exposed a debugger endpoint');
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id === undefined) {
      events.push(msg);
      return;
    }
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (p) msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id;
      pending.set(n, { res, rej });
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  for (const domain of ['Page', 'Runtime', 'DOM', 'Log', 'Network']) await send(`${domain}.enable`);

  // A headless page can end up `visibilityState: "hidden"`, and Chrome then
  // freezes the document timeline at 0 — every CSS transition stays pinned at
  // its start value forever. Anything animated (a drawer sliding in, a fade)
  // then reads as broken no matter how correct it is. Emulating focus keeps the
  // page active so the clock runs. Older builds may not know these commands;
  // they are an improvement, not a requirement, so a miss is not fatal.
  for (const [method, params] of [
    ['Emulation.setFocusEmulationEnabled', { enabled: true }],
    ['Page.setWebLifecycleState', { state: 'active' }],
  ]) {
    try {
      await send(method, params);
    } catch {
      /* not supported by this Chrome */
    }
  }

  const api = {
    send,
    events,
    /** Console errors, uncaught exceptions and failed requests seen so far. */
    problems: () =>
      events
        .filter(
          (e) =>
            (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
            e.method === 'Runtime.exceptionThrown' ||
            (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
            // An aborted request is a navigation the test itself caused.
            (e.method === 'Network.loadingFailed' && !String(e.params.errorText).includes('ERR_ABORTED')),
        )
        .map((e) => {
          if (e.method === 'Runtime.consoleAPICalled')
            return `console.error: ${e.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`;
          if (e.method === 'Runtime.exceptionThrown')
            return `uncaught: ${e.params.exceptionDetails.text} ${e.params.exceptionDetails.exception?.description ?? ''}`.slice(
              0,
              300,
            );
          if (e.method === 'Log.entryAdded') return `log.error: ${e.params.entry.text}`.slice(0, 300);
          return `net-fail: ${e.params.errorText} ${e.params.type} ${e.params.requestId}`;
        }),
    clearEvents: () => {
      events.length = 0;
    },
    async goto(url, { waitMs = 1600 } = {}) {
      await send('Page.navigate', { url });
      await new Promise((r) => setTimeout(r, waitMs));
    },
    async eval(expression) {
      const r = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) {
        throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
      }
      return r.result.value;
    },
    /** Click whatever is at these viewport coordinates. */
    async clickAt(x, y, { waitMs = 700 } = {}) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      }
      await new Promise((r) => setTimeout(r, waitMs));
    },
    /** Move the pointer somewhere harmless — hover states change what is visible. */
    async moveAway(x = 4, y = 4) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    },
    /**
     * Click the first element whose accessible name or text is exactly `label`.
     *
     * Prefers a real mouse event at the element's coordinates. Falls back to
     * `el.click()` when the element has no box or sits outside the viewport —
     * a collapsed sidebar's own expand button is translated off-canvas, and an
     * icon-only trigger may be display:none at this width, so refusing those
     * would report a working control as missing. The fallback still dispatches
     * a genuine DOM click through React's handler; it just cannot prove the
     * element was reachable by pointer.
     */
    async clickLabel(label, { waitMs = 700 } = {}) {
      const at = await api.eval(`(() => {
        const want = ${JSON.stringify(label)};
        const els = [...document.querySelectorAll('button,a,[role="button"]')].filter(
          (e) => (e.getAttribute('aria-label') || '').trim() === want || (e.textContent || '').trim() === want,
        );
        if (els.length === 0) return null;
        // Prefer one a pointer could genuinely reach: on screen AND the topmost
        // thing at its own centre. Without the hit test a coordinate click can
        // land on a sticky header or an overlay that happens to sit on top, and
        // the control silently never fires.
        for (const el of els) {
          el.scrollIntoView({ block: 'center' });
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const x = Math.round(r.x + r.width / 2);
          const y = Math.round(r.y + r.height / 2);
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
          const hit = document.elementFromPoint(x, y);
          if (hit && (hit === el || el.contains(hit) || hit.contains(el))) return { x, y };
        }
        els[0].click();
        return { synthetic: true };
      })()`);
      if (!at) return false;
      if (!at.synthetic) await api.clickAt(at.x, at.y, { waitMs });
      else await new Promise((r) => setTimeout(r, waitMs));
      return true;
    },
    async key(key, { modifiers = 0, waitMs = 500 } = {}) {
      const vk =
        key === 'Enter'
          ? 13
          : key === 'Escape'
            ? 27
            : key === 'Tab'
              ? 9
              : /^[a-zA-Z]$/.test(key)
                ? key.toUpperCase().charCodeAt(0)
                : undefined;
      const code = /^[a-zA-Z]$/.test(key) ? `Key${key.toUpperCase()}` : key;
      for (const type of ['keyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', {
          type,
          key,
          code,
          modifiers,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
        });
      }
      await new Promise((r) => setTimeout(r, waitMs));
    },
    async type(text, { waitMs = 700 } = {}) {
      for (const ch of text) await send('Input.insertText', { text: ch });
      await new Promise((r) => setTimeout(r, waitMs));
    },
    async shot(path, { full = false } = {}) {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
      writeFileSync(path, Buffer.from(r.data, 'base64'));
      return path;
    },
    async setViewport(width, height, mobile = false) {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile,
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      proc.kill('SIGKILL');
    },
  };
  return api;
}

/** A tiny tally so each suite reports the same way and exits non-zero on red. */
export function tally(name) {
  let pass = 0;
  const failures = [];
  return {
    ok(what, condition, detail = '') {
      if (condition) {
        pass += 1;
        console.log(`  ok    ${what}${detail ? `  ${detail}` : ''}`);
      } else {
        failures.push(`${what}${detail ? `  ${detail}` : ''}`);
        console.log(`  FAIL  ${what}${detail ? `  ${detail}` : ''}`);
      }
    },
    done() {
      console.log(`\n${name}: passed ${pass}, failed ${failures.length}`);
      for (const f of failures) console.log(`  - ${f}`);
      return failures.length === 0;
    },
  };
}
