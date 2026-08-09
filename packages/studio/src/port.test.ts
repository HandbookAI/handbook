import { createServer, type Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundPort, startStudio } from './server.js';

/**
 * A port that is already taken is routine — a second studio, or a corporate
 * agent that claimed the number. It used to surface as a bare Node error
 * (`listen EADDRINUSE: address already in use 127.0.0.1:4860`), which says what
 * happened and nothing about what to do.
 */
describe('binding the listen port', () => {
  const opened: Server[] = [];
  const stateDir = (): string => mkdtempSync(join(tmpdir(), 'hb-port-'));

  afterAll(() => {
    for (const s of opened) s.close();
  });

  it('names the way out when the port is taken', async () => {
    const squatter = createServer(() => {});
    await new Promise<void>((r) => squatter.listen(0, '127.0.0.1', r));
    opened.push(squatter);
    const taken = boundPort(squatter);

    await expect(startStudio({ stateDir: stateDir(), port: taken })).rejects.toThrow(
      /already in use.*--port 0/s,
    );
  });

  it('takes any free port when asked for 0, and reports the one it got', async () => {
    const server = await startStudio({ stateDir: stateDir(), port: 0 });
    opened.push(server);
    const port = boundPort(server);
    // The requested number was 0; printing that would send a reader to
    // http://127.0.0.1:0. The bound port is read from the socket.
    expect(port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
  });
});
