// main.ts — the trial lifecycle entry for the mini-forge entry.
//
// The harness contract, in order: start the forge on an ephemeral port (never 8080), report the
// port to $MAKEFUN_ENV_URL/register as {"port": N}, then long-poll $MAKEFUN_ENV_URL/done until
// it answers done:true, and exit 0. The bearer token this process was given in
// $MAKEFUN_SHOP_TOKEN is the only credential the forge accepts.

import { createApp } from './app.ts';

const POLL_MS = 500;
const POLL_TIMEOUT_MS = 55_000;

function envUrl(): string {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined || raw === '') throw new Error('MAKEFUN_ENV_URL is not set');
  return raw.replace(/\/+$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const base = envUrl();
  const app = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    app.once('error', reject);
    app.listen(0, '127.0.0.1', () => {
      const address = app.address();
      if (address === null || typeof address === 'string') reject(new Error('no port was bound'));
      else resolve(address.port);
    });
  });

  // The trial's boot probe polls /healthz until the forge answers, then the suite connects.
  const registered = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!registered.ok) throw new Error(`registration was refused: HTTP ${registered.status}`);

  for (;;) {
    let done = false;
    try {
      const answer = await fetch(`${base}/done`, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
      if (answer.ok) {
        const body = (await answer.json()) as { done?: unknown };
        done = body.done === true;
      }
    } catch {
      // A dropped long-poll is retried; only a done:true answer ends the run.
    }
    if (done) break;
    await sleep(POLL_MS);
  }

  await new Promise<void>((resolve) => {
    app.close(() => resolve());
  });
}

main().then(
  () => {
    process.exitCode = 0;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
