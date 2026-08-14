#!/usr/bin/env node
/**
 * End-to-end smoke test: two real browsers make a real call.
 *
 * Two Chromium instances sign in as separate extensions, one dials the other,
 * and the test asserts that RTP actually flowed — not merely that the UI said
 * the call was connected. A softphone that shows "In call" while nobody can
 * hear anything is the failure mode worth catching, and it is invisible to
 * every other kind of test.
 *
 * Also exercises hold, resume, mute and hangup, and fails on any console
 * error from either page.
 *
 *   npm run test:e2e
 *
 * Environment:
 *   APP_URL         where the web app is served  (default http://localhost:8090)
 *   CHROMIUM_PATH   override the browser binary; needed where the sandbox
 *                   pins a Chromium build that differs from the npm package's
 *   CALLER / CALLEE extensions to use            (default 101 / 102)
 *   CALLER_PASSWORD / CALLEE_PASSWORD
 *   HEADED=1        watch it happen
 */

import { chromium } from 'playwright';

const APP_URL = process.env.APP_URL ?? 'http://localhost:8090';
const CALLER = process.env.CALLER ?? '101';
const CALLEE = process.env.CALLEE ?? '102';
const CALLER_PASSWORD = process.env.CALLER_PASSWORD ?? 'change-me-alice';
const CALLEE_PASSWORD = process.env.CALLEE_PASSWORD ?? 'change-me-ben';

/** Five seconds of 20ms-ptime audio is ~250 packets; allow a wide margin. */
const MIN_PACKETS = 50;
const MEDIA_SETTLE_MS = 5000;

const problems = [];
const step = (message) => console.log(message);
const fail = (message) => {
  problems.push(message);
  console.log(`  ✗ ${message}`);
};
const pass = (message) => console.log(`  ✓ ${message}`);

const browser = await chromium.launch({
  headless: process.env.HEADED !== '1',
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: [
    // A synthetic microphone, and no permission prompt to click.
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    // Development runs against a self-signed certificate on the WSS listener.
    '--ignore-certificate-errors',
    '--no-sandbox',
  ],
});

async function signIn(extension, password) {
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();

  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  // SIP.js owns the RTCPeerConnection and does not expose it, so record every
  // instance the page creates. This is how the test reads real RTP counters
  // instead of inferring liveness from track state, which stays "live" on a
  // perfectly silent call.
  await page.addInitScript(() => {
    const Original = window.RTCPeerConnection;
    window.__peerConnections = [];
    window.RTCPeerConnection = function (...args) {
      const pc = new Original(...args);
      window.__peerConnections.push(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = Original.prototype;
  });

  await page.goto(APP_URL);
  await page.getByPlaceholder('101').fill(extension);
  await page.locator('input[type=password]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.waitForSelector('.registration--registered', { timeout: 30000 });
  pass(`${extension} registered`);

  return { page, errors, extension };
}

async function readMedia(page) {
  return page.evaluate(async () => {
    const audio = document.getElementById('remote-audio');
    const stream = audio?.srcObject;
    if (!stream) return { error: 'no remote stream attached to the audio element' };

    let inbound = null;
    let outbound = null;
    for (const pc of window.__peerConnections ?? []) {
      const report = await pc.getStats();
      report.forEach((entry) => {
        if (entry.type === 'inbound-rtp' && entry.kind === 'audio') inbound = entry;
        if (entry.type === 'outbound-rtp' && entry.kind === 'audio') outbound = entry;
      });
    }

    return {
      liveTracks: stream.getAudioTracks().filter((t) => t.readyState === 'live').length,
      packetsReceived: inbound?.packetsReceived ?? 0,
      bytesReceived: inbound?.bytesReceived ?? 0,
      packetsSent: outbound?.packetsSent ?? 0,
      packetsLost: inbound?.packetsLost ?? 0,
      jitter: inbound?.jitter ?? 0,
    };
  });
}

try {
  step('\nSigning in');
  const caller = await signIn(CALLER, CALLER_PASSWORD);
  const callee = await signIn(CALLEE, CALLEE_PASSWORD);

  step(`\n${CALLER} dials ${CALLEE}`);
  await caller.page.locator('.dialpad__input').fill(CALLEE);
  await caller.page.locator('.dialpad button[type=submit]').click();

  await callee.page.waitForSelector('.incoming', { timeout: 25000 });
  const shown = (await callee.page.locator('.incoming__party').textContent())?.trim();
  pass(`${CALLEE} sees an incoming call from "${shown}"`);

  await callee.page.getByRole('button', { name: 'Answer' }).click();
  await caller.page.waitForSelector('.call-panel--active', { timeout: 25000 });
  await callee.page.waitForSelector('.call-panel--active', { timeout: 25000 });
  pass('both sides show an active call');

  step('\nMedia');
  await caller.page.waitForTimeout(MEDIA_SETTLE_MS);

  for (const side of [caller, callee]) {
    const media = await readMedia(side.page);
    if (media.error) {
      fail(`${side.extension}: ${media.error}`);
      continue;
    }
    console.log(
      `    ${side.extension}: recv ${media.packetsReceived} pkt / ${media.bytesReceived} B, ` +
        `sent ${media.packetsSent} pkt, lost ${media.packetsLost}, jitter ${media.jitter}`,
    );
    if (media.liveTracks === 0) fail(`${side.extension}: no live remote audio track`);
    if (media.packetsReceived < MIN_PACKETS) {
      fail(`${side.extension}: received only ${media.packetsReceived} RTP packets`);
    }
    if (media.packetsSent < MIN_PACKETS) {
      fail(`${side.extension}: sent only ${media.packetsSent} RTP packets`);
    }
  }
  if (problems.length === 0) pass('audio flowing both ways');

  step('\nIn-call controls');
  await caller.page.getByRole('button', { name: 'Hold' }).click();
  await caller.page.waitForSelector('.call-panel--held', { timeout: 15000 });
  pass('hold');

  await caller.page.getByRole('button', { name: 'Resume' }).click();
  await caller.page.waitForSelector('.call-panel--active', { timeout: 15000 });
  pass('resume');

  await caller.page.getByRole('button', { name: 'Mute' }).click();
  await caller.page.waitForSelector('button.control--on', { timeout: 10000 });
  await caller.page.getByRole('button', { name: 'Unmute' }).click();
  pass('mute and unmute');

  step('\nHangup');
  await caller.page.getByRole('button', { name: 'Hang up' }).click();
  await callee.page.waitForSelector('.dialpad', { timeout: 20000 });
  pass(`${CALLEE} returned to the dial pad`);

  step('\nConsole');
  for (const side of [caller, callee]) {
    // Certificate complaints are expected against a development certificate.
    const real = side.errors.filter((e) => !/favicon|ERR_CERT/i.test(e));
    if (real.length === 0) {
      pass(`${side.extension}: no console errors`);
    } else {
      fail(`${side.extension} logged ${real.length} console error(s)`);
      real.slice(0, 5).forEach((e) => console.log(`      ${e.slice(0, 200)}`));
    }
  }
} catch (err) {
  fail(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await browser.close();
}

console.log(`\n${'─'.repeat(60)}`);
if (problems.length === 0) {
  console.log('PASS — a call was placed, answered, held, resumed and ended,');
  console.log('       with RTP verified in both directions.');
  process.exit(0);
}
console.log(`FAIL — ${problems.length} problem(s):`);
problems.forEach((p) => console.log(`  - ${p}`));
process.exit(1);
