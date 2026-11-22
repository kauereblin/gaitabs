import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WONDERFUL_WORLD_GOLDEN_DOC } from '../../src/schema/golden.ts';

function findBrowserExecutable(): string {
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const pwDir = join(localAppData, 'ms-playwright');
  if (existsSync(pwDir)) {
    const entries = readdirSync(pwDir).filter((d) => d.startsWith('chromium-')).sort().reverse();
    for (const dir of entries) {
      const candidate = join(pwDir, dir, 'chrome-win', 'chrome.exe');
      if (existsSync(candidate)) return candidate;
      const candidate64 = join(pwDir, dir, 'chrome-win64', 'chrome.exe');
      if (existsSync(candidate64)) return candidate64;
    }
  }

  const fallbacks = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const fb of fallbacks) {
    if (existsSync(fb)) return fb;
  }
  throw new Error('No Chromium or Edge browser executable found for Playwright E2E');
}

async function waitForServer(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Server still booting
    }
    await Bun.sleep(150);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`E2E ASSERTION FAILED: ${msg}`);
}

const PORT = 4179;
const URL = `http://127.0.0.1:${PORT}`;

const server = Bun.spawn(['bun', 'x', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  cwd: process.cwd(),
  stdout: 'pipe',
  stderr: 'pipe',
});

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

try {
  await waitForServer(URL);
  const executablePath = findBrowserExecutable();
  console.log(`[E2E] Launching headless browser: ${executablePath}`);

  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  await page.goto(URL, { waitUntil: 'networkidle' });

  // 1. Verify initial audio unlock prompt & 1-click unlock via comb hole + symbol-first UI
  const playLabel = (await page.getByTestId('play-btn').textContent())?.trim() ?? '';
  assert(playLabel.startsWith('▶'), `Expected symbol-first Play button, got "${playLabel}"`);
  const wakeBtn = page.getByTestId('wake-harp-btn');
  await wakeBtn.waitFor({ state: 'visible', timeout: 5000 });
  await page.getByTestId('comb-hole-4').click();
  await wakeBtn.waitFor({ state: 'hidden', timeout: 5000 });
  console.log('[E2E] PASS: 1-click audio unlock, symbol-first UI & production AudioWorklet loaded');

  // 2. Smart Paste Golden Fixture & verify Note-Pills + Decoupled Lyrics
  await page.getByTestId('open-smart-paste-btn').click();
  await page.getByTestId('fill-golden-text-btn').click();
  await page.getByTestId('smart-paste-submit-btn').click();

  const bar0 = page.getByTestId('bar-row-0');
  const bar1 = page.getByTestId('bar-row-1');
  await bar0.waitFor({ state: 'visible', timeout: 5000 });
  const bar0Pills = await bar0.getByTestId('note-pill').count();
  const bar0Lyrics = await bar0.getByTestId('lyric-chip').count();
  const bar1Pills = await bar1.getByTestId('note-pill').count();
  assert(bar0Pills === 9, `Expected 9 note pills in bar 0, got ${bar0Pills}`);
  assert(bar0Lyrics === 9, `Expected 9 lyric chips in bar 0, got ${bar0Lyrics}`);
  assert(bar1Pills === 8, `Expected 8 note pills in bar 1, got ${bar1Pills}`);
  // Verify note pitch caption inside note-pill (Hole 3 blow on C harp = G, on G harp = D)
  const firstCaptionC = (await bar0.getByTestId('note-pill-caption').first().textContent())?.trim();
  assert(firstCaptionC === 'G', `Expected first note caption "G" on C harp, got "${firstCaptionC}"`);
  await page.getByTestId('harp-key-select').selectOption('G');
  const firstCaptionG = (await bar0.getByTestId('note-pill-caption').first().textContent())?.trim();
  assert(firstCaptionG === 'D', `Expected first note caption "D" on G harp, got "${firstCaptionG}"`);
  await page.getByTestId('harp-key-select').selectOption('C');
  console.log('[E2E] PASS: Smart Paste rendered 9+8 Note-Pills with live transposed pitch captions (G -> D) and 9 lyric spans');

  // 3. Click inside Bar 1 while paused -> caret jumps & stays at clicked tick
  const bar1Track = bar1.locator('.bar-track');
  const box1 = await bar1Track.boundingBox();
  assert(box1 !== null, 'Expected bar 1 track bounding box');
  await page.mouse.click(box1.x + box1.width * 0.5, box1.y + box1.height - 6);
  await Bun.sleep(250); // verify 60Hz worklet telemetry does NOT snap tick back to 0
  const soughtTick = Number((await page.getByTestId('playhead-tick').textContent())?.trim() ?? '0');
  assert(soughtTick > 9 * 480, `Expected paused click in Bar 1 to jump caret past 4320, got ${soughtTick}`);
  console.log(`[E2E] PASS: Paused bar click jumped caret to ${soughtTick} ticks and persisted`);

  // 4. Floating Selected Note Inspector card aside the note, always-visible 10-hole chord selector, no Hole combobox, inline side-tick-meter
  await bar0.getByTestId('note-pill').first().click();
  const inspector = page.getByTestId('note-inspector');
  await inspector.waitFor({ state: 'visible', timeout: 3000 });
  const inspCheck = await page.evaluate(() => {
    const insp = document.querySelector('[data-testid="note-inspector"]') as HTMLElement | null;
    const holeSelect = insp?.querySelector('select[aria-label="Note Hole"]');
    const holeBtns = insp?.querySelectorAll('.inspector-holes-grid button') ?? [];
    const tickMeter = document.querySelector('.side-tick-meter')?.getBoundingClientRect();
    const sm = document.querySelector('[data-testid="side-menu"]');
    const comb = document.querySelector('.comb-section') as HTMLElement | null;
    const inspRect = insp?.getBoundingClientRect();
    const inspStyle = insp ? getComputedStyle(insp) : null;
    return {
      position: inspStyle?.position ?? '',
      fontSize: parseFloat(inspStyle?.fontSize ?? '0'),
      hasHoleSelect: Boolean(holeSelect),
      holeBtnCount: holeBtns.length,
      inspInViewport:
        Boolean(inspRect) &&
        (inspRect?.left ?? -1) >= 0 &&
        (inspRect?.right ?? 9999) <= window.innerWidth + 1 &&
        (inspRect?.top ?? -1) >= 0,
      tickMeterHeight: tickMeter?.height ?? 999,
      sideMenuHasBoth: Boolean(sm?.querySelector('.transport-bar') && sm?.querySelector('.editor-toolbar')),
      combPosition: comb ? getComputedStyle(comb).position : '',
    };
  });
  const printBtnCount = await page.getByRole('button', { name: /Print Sheet/i }).count();
  assert(inspCheck.position === 'fixed', `Expected floating fixed note-inspector, got ${inspCheck.position}`);
  assert(inspCheck.fontSize >= 12.5, `Expected readable >=12.5px note-inspector font, got ${inspCheck.fontSize}px`);
  assert(!inspCheck.hasHoleSelect, 'Expected Hole combobox to be removed');
  assert(inspCheck.holeBtnCount === 10, `Expected always-visible 10-hole chord selector, got ${inspCheck.holeBtnCount}`);
  assert(inspCheck.inspInViewport, 'Expected floating note-inspector strictly inside viewport');
  assert(inspCheck.tickMeterHeight <= 28, `Expected inline single-line side-tick-meter (<=28px), got ${inspCheck.tickMeterHeight}px`);
  assert(inspCheck.sideMenuHasBoth, 'Expected .side-menu to contain both .transport-bar and .editor-toolbar');
  assert(inspCheck.combPosition === 'fixed', `Expected comb-section position: fixed, got ${inspCheck.combPosition}`);
  assert(printBtnCount === 0, `Expected Print Sheet feature to be removed, found ${printBtnCount} button(s)`);
  // Toggle a second hole in the always-visible chord selector, then close via Done
  await inspector.locator('.inspector-holes-grid button').nth(3).click();
  await inspector.getByRole('button', { name: /Done/ }).click();
  await inspector.waitFor({ state: 'hidden', timeout: 3000 });
  console.log('[E2E] PASS: Floating Note Inspector card, always-visible 10-hole chord selector, inline tick meter & fixed comb verified');

  // 4b. Verify full-page scroll (NO inner scroll on .bars-scroll) keeps side-menu sticky & comb-section fixed at bottom
  for (let i = 0; i < 6; i++) {
    await page.getByTestId('duplicate-bar-0').click();
  }
  const barsHasInnerScroll = await page.locator('.bars-scroll').evaluate((el) => {
    const style = getComputedStyle(el);
    return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 2;
  });
  assert(!barsHasInnerScroll, 'Expected .bars-scroll to have NO inner vertical scrollbar (page should scroll)');
  await page.evaluate(() => window.scrollTo(0, 420));
  await Bun.sleep(100);
  const pageScrollY = await page.evaluate(() => window.scrollY);
  assert(pageScrollY > 200, `Expected page to scroll vertically, got window.scrollY=${pageScrollY}`);
  const sideAfterScroll = await page.getByTestId('side-menu').boundingBox();
  const combAfterScroll = await page.locator('.comb-section').boundingBox();
  assert(sideAfterScroll && combAfterScroll, 'Expected side-menu and comb-section boxes after scrolling page');
  assert(sideAfterScroll.y >= 0 && sideAfterScroll.y <= 24, `Expected sticky side-menu near top, got y=${sideAfterScroll.y}`);
  assert(
    combAfterScroll.y + combAfterScroll.height <= 722 && combAfterScroll.y >= 400,
    `Expected fixed comb-section at bottom of 720px viewport, got top=${combAfterScroll.y}, bottom=${combAfterScroll.y + combAfterScroll.height}`,
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  console.log('[E2E] PASS: Page scroll (no inner bar scroll) keeps side-menu sticky & comb-section fixed at bottom');

  // 5. Bar Duplicate & Stretch/Shrink/Fit controls
  await page.getByTestId('duplicate-bar-0').click();
  await page.getByTestId('bar-row-2').waitFor({ state: 'visible', timeout: 3000 });
  const bar0HeaderBefore = (await bar0.locator('.bar-header').textContent()) ?? '';
  await page.getByTestId('stretch-bar-0').click();
  const bar0HeaderAfterStretch = (await bar0.locator('.bar-header').textContent()) ?? '';
  assert(bar0HeaderBefore !== bar0HeaderAfterStretch, 'Expected stretch-bar-0 to increase beats');
  await page.getByTestId('fit-bar-0').click();
  const bar0HeaderAfterFit = (await bar0.locator('.bar-header').textContent()) ?? '';
  assert(bar0HeaderAfterFit === bar0HeaderBefore, 'Expected fit-bar-0 to snap back to notes');
  console.log('[E2E] PASS: Bar duplication, stretch, and fit controls verified');

  // 5b. Drag lyric chip horizontally between beats strictly inside Bar 0 (never leaving the bar)
  const firstLyric = bar0.getByTestId('lyric-chip').first();
  const lyricBoxBefore = await firstLyric.boundingBox();
  const bar0TrackBox = await bar0.locator('.bar-track').boundingBox();
  assert(lyricBoxBefore && bar0TrackBox, 'Expected bounding boxes for first lyric chip and bar 0 track');
  await page.mouse.move(lyricBoxBefore.x + lyricBoxBefore.width / 2, lyricBoxBefore.y + lyricBoxBefore.height / 2);
  await page.mouse.down();
  // Drag right by ~2 beats and down past bar 0 to confirm it stays strictly inside bar 0
  await page.mouse.move(lyricBoxBefore.x + lyricBoxBefore.width / 2 + bar0TrackBox.width * 0.25, lyricBoxBefore.y + 140, { steps: 6 });
  await page.mouse.up();
  const bar0LyricsAfterDrag = await bar0.getByTestId('lyric-chip').count();
  const movedLyricBox = await bar0.locator('[data-lyric-id="l-0-0"]').boundingBox();
  assert(bar0LyricsAfterDrag === 9, `Expected lyric to stay inside bar 0 (9 lyrics), got ${bar0LyricsAfterDrag}`);
  assert(
    movedLyricBox &&
      movedLyricBox.x > lyricBoxBefore.x + 20 &&
      movedLyricBox.x + movedLyricBox.width <= bar0TrackBox.x + bar0TrackBox.width + 2,
    `Expected lyric to move right between beats strictly inside bar 0 (beforeX=${lyricBoxBefore.x}, afterX=${movedLyricBox?.x})`,
  );
  console.log('[E2E] PASS: Lyric chip dragged between beats strictly clamped inside Bar 0');

  // 6. Playback advances sample-accurate playhead, 0.5x speed, A-B loop
  await page.getByTestId('stop-btn').click();
  await page.getByTestId('play-btn').click();
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="playhead-tick"]');
      return el !== null && Number(el.textContent?.trim() ?? '0') > 50;
    },
    undefined,
    { timeout: 5000 },
  );
  const tick1 = Number((await page.getByTestId('playhead-tick').textContent())?.trim() ?? '0');
  assert(tick1 > 50, `Expected playhead tick > 50, got ${tick1}`);

  await page.getByTestId('speed-0.5').click();
  await page.getByTestId('loop-toggle-btn').click();
  await Bun.sleep(350);
  const tickLoop = Number((await page.getByTestId('playhead-tick').textContent())?.trim() ?? '0');
  assert(tickLoop >= 0 && tickLoop <= 9 * 480, `Expected loop tick inside bar 0, got ${tickLoop}`);
  await page.getByTestId('loop-toggle-btn').click(); // turn loop off
  await page.getByTestId('stop-btn').click();
  console.log(`[E2E] PASS: AudioWorklet playback advanced playhead (${tick1} ticks), 0.5x + A-B loop verified`);

  // 7. Edit title, wait for IndexedDB autosave, reload TWICE -> verify zero duplicate library entries & restores same song
  const titleInput = page.getByTestId('song-title-input');
  await titleInput.fill('E2E Persisted Harp Song');
  await page.waitForFunction(
    () => {
      const badge = document.querySelector('[data-testid="save-status-badge"]');
      return badge?.getAttribute('data-status') === 'saved';
    },
    undefined,
    { timeout: 5000 },
  );

  await page.reload({ waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  const restoredTitle = await page.getByTestId('song-title-input').inputValue();
  assert(restoredTitle === 'E2E Persisted Harp Song', `Expected restored title, got "${restoredTitle}"`);

  await page.getByTestId('open-library-btn').click();
  const libCountAfterReloads = await page.getByTestId('library-item').count();
  assert(libCountAfterReloads === 1, `Expected exactly 1 song in library after 2 reloads (no duplicates), got ${libCountAfterReloads}`);
  console.log('[E2E] PASS: Idempotent reload persistence restored song with zero duplicates');

  // 8. Copy Share URL (#tab=...) and verify decoding in isolated context + hash cleared on reload
  await page.getByTestId('copy-share-url-btn').click();
  const shareUrl = page.url();
  assert(shareUrl.includes('#tab='), `Expected #tab= hash in URL, got ${shareUrl}`);

  const freshContext = await browser.newContext();
  const freshPage = await freshContext.newPage();
  await freshPage.goto(shareUrl, { waitUntil: 'networkidle' });
  await freshPage.waitForFunction(
    () => {
      const inp = document.querySelector('[data-testid="song-title-input"]') as HTMLInputElement | null;
      return inp?.value === 'E2E Persisted Harp Song';
    },
    undefined,
    { timeout: 5000 },
  );
  // Reloading after #tab= import must NOT create duplicate songs
  await freshPage.reload({ waitUntil: 'networkidle' });
  await freshPage.getByTestId('open-library-btn').click();
  const freshLibCount = await freshPage.getByTestId('library-item').count();
  assert(freshLibCount === 1, `Expected 1 song in fresh context after #tab= import + reload, got ${freshLibCount}`);
  await freshContext.close();
  console.log('[E2E] PASS: #tab= share URL decoded once and did not duplicate on reload');

  // 9. Verify .gaitab.json file import via Library Drawer
  const importPayload = JSON.stringify({
    ...WONDERFUL_WORLD_GOLDEN_DOC,
    id: '00000000-0000-4000-8000-000000000099',
    title: 'Imported From JSON File',
  });
  await page.getByTestId('import-json-input').setInputFiles({
    name: 'imported.gaitab.json',
    mimeType: 'application/json',
    buffer: Buffer.from(importPayload, 'utf8'),
  });
  await page.waitForFunction(
    () => {
      const inp = document.querySelector('[data-testid="song-title-input"]') as HTMLInputElement | null;
      return inp?.value === 'Imported From JSON File';
    },
    undefined,
    { timeout: 5000 },
  );
  console.log('[E2E] PASS: .gaitab.json file import validated and loaded');

  // 10. DAW Live-Record Mode: create new song, click ● Record, tap comb holes -> notes created automatically
  await page.getByTestId('open-library-btn').click();
  await page.getByRole('button', { name: /New Song/ }).click();
  await page.getByTestId('speed-1').click();
  await page.getByTestId('record-btn').click();
  await page.getByTestId('comb-recording-badge').waitFor({ state: 'visible', timeout: 3000 });
  await Bun.sleep(150);
  await page.getByTestId('comb-hole-4').click();
  await Bun.sleep(220);
  await page.getByTestId('comb-hole-5').click();
  await Bun.sleep(150);
  await page.getByTestId('record-btn').click(); // stop recording
  const recordedPills = await page.getByTestId('note-pill').count();
  assert(recordedPills >= 2, `Expected >= 2 live-recorded notes in DAW mode, got ${recordedPills}`);
  console.log(`[E2E] PASS: DAW Live-Record Mode captured ${recordedPills} timed notes from comb`);

  // 11. Natural End-of-Song Caret Auto-Reset: play short 1-bar song at fast BPM, verify caret resets to 0 & replays cleanly
  await page.getByTestId('stop-btn').click();
  await page.getByTestId('bpm-input').fill('240');
  await page.getByTestId('bpm-input').blur();
  await page.getByTestId('fit-bar-0').click();
  await page.getByTestId('play-btn').click();
  // First wait for playback to advance > 0
  await page.waitForFunction(
    () => {
      const tick = document.querySelector('[data-testid="playhead-tick"]');
      return Number(tick?.textContent?.trim() ?? '0') > 20;
    },
    undefined,
    { timeout: 5000 },
  );
  // Wait for playback to finish naturally and return Play button to ▶ Play with tick reset to 0
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="play-btn"]');
      const tick = document.querySelector('[data-testid="playhead-tick"]');
      return (
        btn?.textContent?.includes('Play') &&
        Number(tick?.textContent?.trim() ?? '-1') === 0
      );
    },
    undefined,
    { timeout: 6000 },
  );
  // Verify immediate replay without clicking Stop first!
  await page.getByTestId('play-btn').click();
  await page.waitForFunction(
    () => {
      const tick = document.querySelector('[data-testid="playhead-tick"]');
      return Number(tick?.textContent?.trim() ?? '0') > 20;
    },
    undefined,
    { timeout: 5000 },
  );
  await page.getByTestId('stop-btn').click();
  console.log('[E2E] PASS: Natural end-of-song automatically reset caret to 0 and replayed immediately without Stop');

  // 12. Mobile (375x812) responsiveness: side-menu drawer opens cleanly, all 10 comb holes visible, zero unwanted component scrollbars
  const mobileCtx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const mobilePage = await mobileCtx.newPage();
  await mobilePage.goto(URL, { waitUntil: 'networkidle' });

  // Verify mobile Controls button opens the side-menu drawer and Smart Paste loads the song
  await mobilePage.getByTestId('toggle-side-menu-btn').click();
  await mobilePage.getByTestId('side-menu').locator('.transport-bar').waitFor({ state: 'visible', timeout: 3000 });
  await mobilePage.getByTestId('open-smart-paste-btn').click();
  await mobilePage.getByTestId('fill-golden-text-btn').click();
  await mobilePage.getByTestId('smart-paste-submit-btn').click();
  await mobilePage.getByTestId('bar-row-0').waitFor({ state: 'visible', timeout: 5000 });
  await mobilePage.getByTestId('bar-row-0').getByTestId('note-pill').first().click();
  await mobilePage.getByTestId('note-inspector').waitFor({ state: 'visible', timeout: 3000 });
  await mobilePage.getByTestId('note-inspector').getByRole('button', { name: /Done/ }).click();

  const mobileMetrics = await mobilePage.evaluate(() => {
    const docOverflow = document.documentElement.scrollWidth - window.innerWidth;
    const selectors = ['.bars-scroll', '.bar-row', '.note-inspector', '.comb-section'];
    const overflows: Record<string, number> = {};
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) overflows[sel] = el.scrollWidth - el.clientWidth;
    }
    const hole1 = document.querySelector('[data-testid="comb-hole-1"]')?.getBoundingClientRect();
    const hole10 = document.querySelector('[data-testid="comb-hole-10"]')?.getBoundingClientRect();
    return {
      docOverflow,
      overflows,
      hole1Left: hole1?.left ?? -1,
      hole10Right: hole10?.right ?? 9999,
      hole10Width: hole10?.width ?? 0,
    };
  });
  assert(mobileMetrics.docOverflow <= 2, `Expected no mobile page horizontal overflow, got +${mobileMetrics.docOverflow}px`);
  assert(
    mobileMetrics.hole1Left >= 0 && mobileMetrics.hole10Right <= 376 && mobileMetrics.hole10Width >= 24,
    `Expected all 10 comb holes visible inside 375px mobile viewport, got hole1Left=${mobileMetrics.hole1Left}, hole10Right=${mobileMetrics.hole10Right}, hole10Width=${mobileMetrics.hole10Width}`,
  );
  for (const [sel, diff] of Object.entries(mobileMetrics.overflows)) {
    assert(diff <= 2, `Expected zero horizontal scroll inside ${sel} on mobile, got +${diff}px`);
  }
  await mobileCtx.close();
  console.log('[E2E] PASS: Mobile (375x812) drawer, all 10 comb holes & zero inner scrollbars verified');

  assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join('; ')}`);
  assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join('; ')}`);

  await context.close();
  console.log('[E2E] ALL 12 PRODUCTION E2E CHECKS PASSED');
} finally {
  if (browser) await browser.close();
  server.kill();
}
