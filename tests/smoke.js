// Smoke test: real keyboard/mouse input in headless Chrome, screenshots, high-score persistence.
// Run: cd tests && npm install && node smoke.js   (screenshots land in tests/shots/)
const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');

const FILE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = path.resolve(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };

async function launch() {
  try { return await chromium.launch({ channel: 'chrome', headless: true }); }
  catch (e) { return chromium.launch({ headless: true }); }   // falls back to Playwright's own Chromium
}
const waitFor = async (page, fn, arg, timeout = 30000) => {
  try { await page.waitForFunction(fn, arg, { timeout, polling: 50 }); return true; } catch (e) { return false; }
};
// Walk with the in-game helper until it reports arrival (movement itself is real grid stepping)
const walkTo = (page, call, timeout = 20000) => waitFor(page, (c) => new Function('api', 'return ' + c)(DSS.api), call, timeout);

// The office leaderboard is mocked here so test runs never post to the real one.
const FAKE_BOARD = [
  { name: 'Nora (test)', score: 1480, days: 12.4, cases: 10, player_id: '11111111-1111-4111-8111-111111111111' },
  { name: 'Max (test)', score: 910, days: 7.6, cases: 6, player_id: '22222222-2222-4222-8222-222222222222' },
];
const posted = [];
async function mockBoard(page, mode = 'ok') {
  await page.route('**/rest/v1/leaderboard**', async (route) => {
    if (mode === 'offline') return route.abort('internetdisconnected');
    const req = route.request();
    if (req.method() === 'POST') { posted.push(JSON.parse(req.postData())); return route.fulfill({ status: 201, body: '' }); }
    const rows = [...FAKE_BOARD, ...posted.map((p) => ({ ...p }))].sort((a, b) => b.score - a.score);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  });
}

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  await mockBoard(page);

  await page.goto(FILE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await waitFor(page, () => DSS.Board.status === 'online', null, 5000);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/1-title.png`, animations: 'disabled' });
  check('title screen visible', await page.isVisible('#overlay'));
  check('title shows the office leaderboard', (await page.textContent('.lb-slot')).includes('Nora (test)'));

  // before playing, you must enter a name
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  check('SPACE opens the name screen (not the game)', await page.isVisible('#nameInput') && (await page.evaluate(() => DSS.S.mode)) === 'title');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check('an empty name is refused', (await page.evaluate(() => DSS.S.mode)) === 'title' && (await page.textContent('.name-err')).length > 5);
  await page.fill('#nameInput', '  Test   Player <b>  ');
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${OUT}/1b-name-entry.png`, animations: 'disabled' });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const nm = await page.evaluate(() => ({ mode: DSS.S.mode, name: DSS.Board.name, stored: localStorage.getItem('drugSafetySim.playerName') }));
  const cleaned = await page.evaluate(() => DSS.Board.cleanName('  Dr.  <b>Ana</b> Maria-Lopez-Garcia  '));
  check('names are cleaned (no tags/control chars, max 16)', cleaned === 'Dr. bAna/b Maria', JSON.stringify(cleaned));
  check('name is cleaned, remembered, and the shift starts', nm.mode === 'playing' && nm.name === 'Test Player', JSON.stringify(nm));
  const mapOk = await page.evaluate(() => {
    const { POIS } = window; // not exported: verify via walkable on key tiles instead
    const tiles = [[22, 9], [9, 23], [36, 11], [32, 5], [20, 21], [16, 2], [5, 2], [25, 2], [25, 7], [36, 9]];
    return tiles.every(([x, y]) => DSS.walkable(x, y));
  });
  check('map: key standing tiles are walkable', mapOk);

  await page.evaluate(() => { DSS.S.nextEventAt = 9999; DSS.CONFIG.work.qcBounceChance = 0; }); // keep this run deterministic

  // Pokemon-style movement: a quick tap turns without moving, holding walks tile by tile
  const p0 = await page.evaluate(() => ({ tx: DSS.P.tx, ty: DSS.P.ty, dir: DSS.P.dir }));
  await page.keyboard.down('ArrowLeft'); await page.waitForTimeout(40); await page.keyboard.up('ArrowLeft');
  await page.waitForTimeout(150);
  const p1 = await page.evaluate(() => ({ tx: DSS.P.tx, ty: DSS.P.ty, dir: DSS.P.dir }));
  check('tap turns in place', p1.dir === 'left' && p1.tx === p0.tx && p1.ty === p0.ty, JSON.stringify({ p0, p1 }));
  await page.keyboard.down('ArrowUp'); await page.waitForTimeout(700); await page.keyboard.up('ArrowUp');
  await page.waitForTimeout(300);
  await page.keyboard.down('ArrowRight'); await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/2-walking.png` });
  await page.keyboard.up('ArrowRight');
  await page.waitForTimeout(300);
  const p2 = await page.evaluate(() => ({ tx: DSS.P.tx, ty: DSS.P.ty, x: DSS.P.x, y: DSS.P.y }));
  check('holding walks whole tiles', p2.ty < p0.ty && p2.x === (p2.tx + 0.5) * 32, JSON.stringify(p2));

  // coffee machine (the nearest one is the new open-plan machine by the desks)
  await page.evaluate(() => { DSS.S.stats.caffeine = 45; });
  const caf0 = await page.evaluate(() => DSS.S.stats.caffeine);
  check('walked to the nearest coffee machine', await walkTo(page, 'api.goToObj("C")'));
  const machine = await page.evaluate(() => { const t = DSS.api.target(); return t && t.obj && { type: t.obj.type, label: t.obj.label, y: t.obj.y }; });
  check('it is the open-plan machine near the desks', !!machine && machine.type === 'C' && machine.y < 18, JSON.stringify(machine));
  await page.keyboard.press('e');
  await page.waitForTimeout(2000);
  const caf1 = await page.evaluate(() => DSS.S.stats.caffeine);
  check('coffee raises caffeine', caf1 > caf0 + 15, `${caf0.toFixed(1)} -> ${caf1.toFixed(1)}`);
  await page.evaluate(() => { DSS.S.stats.caffeine = 70; });   // keep the rest of the run calm

  // colleague mini-game: talk to Max and pick the mini-game reply
  await page.evaluate(() => { const n = DSS.NPCS.find((x) => x.id === 'max'); n.chatReadyAt = 0; DSS.S.mgReady = {}; });
  check('walked up to Max', await walkTo(page, 'api.goToNpc(DSS.NPCS.find(n => n.id === "max"))', 40000));
  await page.keyboard.press('e');
  await waitFor(page, () => DSS.S.mode === 'dialog', null, 3000);
  const nChoices = await page.evaluate(() => DSS.S.dialog.choices.length);
  const offer = await page.evaluate(() => DSS.S.dialog.choices[DSS.S.dialog.choices.length - 1].text);
  check('Max offers a mini-game in conversation', /Code It/.test(offer), offer);
  await page.keyboard.press(String(nChoices));
  const inQuiz = await waitFor(page, () => DSS.S.mode === 'minigame' && DSS.MG.active && DSS.MG.active.state === 'question', null, 4000);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/3b-minigame-codeit.png` });
  check('"Code It!" quiz starts and shows a question', inQuiz && await page.isVisible('#mg'));
  const statsBefore = await page.evaluate(() => ({ ...DSS.S.stats }));
  for (let r = 0; r < 5; r++) {   // answer every round correctly with the number keys
    await waitFor(page, () => DSS.MG.active && DSS.MG.active.state !== 'feedback', null, 3000);
    const idx = await page.evaluate(() => DSS.MG.active && DSS.MG.active.state === 'question' ? DSS.MG.active.item.opts.findIndex((o) => o.ok) : -1);
    if (idx >= 0) await page.keyboard.press(String(idx + 1));
    await page.waitForTimeout(1000);
  }
  const quizDone = await waitFor(page, () => DSS.MG.active && DSS.MG.active.state === 'result', null, 5000);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/3c-minigame-result.png`, animations: 'disabled' });
  const quizRes = await page.evaluate(() => ({ correct: DSS.MG.active.correct, n: DSS.MG.active.items.length }));
  check('quiz finishes with a result screen (all answered correctly)', quizDone && quizRes.correct === quizRes.n, JSON.stringify(quizRes));
  await page.keyboard.press('e');
  await page.waitForTimeout(200);
  const statsAfter = await page.evaluate(() => ({ mode: DSS.S.mode, ...DSS.S.stats }));
  check('closing the mini-game returns to the office with rewards', statsAfter.mode === 'playing' && statsAfter.compliance > statsBefore.compliance && statsAfter.sanity > statsBefore.sanity,
    `sanity ${statsBefore.sanity.toFixed(1)} -> ${statsAfter.sanity.toFixed(1)}, compliance ${statsBefore.compliance.toFixed(1)} -> ${statsAfter.compliance.toFixed(1)}`);

  // table tennis at the ping pong table
  check('walked to the ping pong table', await walkTo(page, 'api.goToObj("g")', 30000));
  await page.keyboard.press('e');
  const inPong = await waitFor(page, () => DSS.S.mode === 'minigame' && DSS.MG.active && DSS.MG.active.kind === 'pong', null, 3000);
  await page.waitForTimeout(2200);
  const py0 = await page.evaluate(() => DSS.MG.active.py);
  await page.keyboard.down('ArrowUp'); await page.waitForTimeout(300); await page.keyboard.up('ArrowUp');
  const py1 = await page.evaluate(() => DSS.MG.active.py);
  await page.screenshot({ path: `${OUT}/3d-table-tennis.png` });
  check('table tennis starts and the paddle moves with the arrow keys', inPong && py1 < py0, `paddle y ${py0.toFixed(0)} -> ${py1.toFixed(0)}`);
  await page.evaluate(() => { const g = DSS.MG.active; g.score = [3, 1]; g.lastWinner = 0; g.state = 'point'; g.t = 1; });
  const pongDone = await waitFor(page, () => DSS.MG.active && DSS.MG.active.state === 'result', null, 3000);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/3e-table-tennis-win.png`, animations: 'disabled' });
  check('table tennis shows a win screen', pongDone && await page.evaluate(() => DSS.MG.active.won));
  await page.keyboard.press('e');
  await page.waitForTimeout(200);
  check('back in the office after table tennis', (await page.evaluate(() => DSS.S.mode)) === 'playing');

  // vending machine: pick a snack for Energy
  await page.evaluate(() => { DSS.CONFIG.vending.stuckChance = 0; DSS.S.stats.energy = 40; });
  check('walked to the vending machine', await walkTo(page, 'api.goToObj("V")', 30000));
  await page.keyboard.press('e');
  const vendOpen = await waitFor(page, () => DSS.S.mode === 'dialog' && DSS.S.dialog.vend, null, 3000);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/3g-vending.png` });
  const snack = await page.evaluate(() => DSS.S.dialog.choices[0]);
  const nrg0 = await page.evaluate(() => DSS.S.stats.energy);
  await page.keyboard.press('1');
  await page.waitForTimeout(200);
  const nrg1 = await page.evaluate(() => DSS.S.stats.energy);
  check('vending menu opens and a snack gives Energy', vendOpen && nrg1 > nrg0 + 5, `${snack.text}: energy ${nrg0.toFixed(1)} -> ${nrg1.toFixed(1)}`);

  // WC: a short lock-in that restores Sanity
  await page.evaluate(() => { DSS.S.stats.sanity = 50; });
  check('walked to the WC', await walkTo(page, 'api.goToObj("L")', 30000));
  const san0w = await page.evaluate(() => DSS.S.stats.sanity);
  await page.keyboard.press('e');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/3h-wc.png` });
  const inWc = await page.evaluate(() => DSS.S.inToilet);
  await waitFor(page, () => !DSS.S.inToilet, null, 8000);
  const san1w = await page.evaluate(() => DSS.S.stats.sanity);
  check('bio break restores Sanity', inWc && san1w > san0w + 5, `sanity ${san0w.toFixed(1)} -> ${san1w.toFixed(1)}`);

  // TV: a corporate email pops up; "Reply all" costs Sanity
  check('walked to the TV', await walkTo(page, 'api.goToObj("v")', 30000));
  await page.keyboard.press('e');
  const mailOpen = await waitFor(page, () => DSS.S.mode === 'mail', null, 3000);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/3i-corporate-email.png` });
  const subj = await page.textContent('#mailSubject');
  const sanM = await page.evaluate(() => DSS.S.stats.sanity);
  await page.keyboard.press('2');
  await page.waitForTimeout(200);
  const afterMail = await page.evaluate(() => ({ mode: DSS.S.mode, san: DSS.S.stats.sanity }));
  check('TV opens a corporate email; Reply all closes it with a penalty', mailOpen && afterMail.mode === 'playing' && afterMail.san < sanM && !(await page.isVisible('#mail')), `"${subj}" sanity ${sanM.toFixed(1)} -> ${afterMail.san.toFixed(1)}`);

  // talk to a colleague (Nora wanders, so keep re-planning until adjacent)
  await page.evaluate(() => { const n = DSS.NPCS.find((x) => x.id === 'lin'); n.chatReadyAt = 0; });
  check('walked up to a colleague', await walkTo(page, 'api.goToNpc(DSS.NPCS.find(n => n.id === "lin"))', 40000));
  await page.keyboard.press('e');
  const talked = await waitFor(page, () => DSS.S.mode === 'dialog', null, 3000);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/3-dialog.png` });
  check('E opens a dialogue with choices', talked && await page.isVisible('#dialog'));
  const san0 = await page.evaluate(() => DSS.S.stats.sanity);
  await page.keyboard.press('1');
  await page.waitForTimeout(200);
  check('choice 1 closes dialogue and applies effects', (await page.evaluate(() => DSS.S.mode)) === 'playing', `sanity ${san0.toFixed(1)} -> ${(await page.evaluate(() => DSS.S.stats.sanity)).toFixed(1)}`);

  // process one case at the desk by holding E
  await page.evaluate(() => { DSS.S.cases.length = 0; DSS.S.casesVersion++; DSS.spawnCase({ serious: false }); DSS.S.nextCaseAt = 9999; });
  check('walked to my desk', await walkTo(page, 'api.goToTile(22, 9)'));
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(150);
  const facing = await page.evaluate(() => ({ t: DSS.api.target(), P: { tx: DSS.P.tx, ty: DSS.P.ty, dir: DSS.P.dir, moving: DSS.P.moving } }));
  check('facing my desk', !!(facing.t && facing.t.obj && facing.t.obj.type === 'M'), JSON.stringify(facing.P));
  const onTime0 = await page.evaluate(() => DSS.S.onTime);
  await page.keyboard.down('e');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/4-working.png` });
  const done = await waitFor(page, (n) => DSS.S.onTime > n, onTime0, 15000);
  await page.keyboard.up('e');
  check('holding E at the desk submits a case on time', done, `onTime=${await page.evaluate(() => DSS.S.onTime)}`);

  // let a case go late -> manager walks over and scolds
  await page.evaluate(() => { const c = DSS.spawnCase({ serious: true }); c.deadline = DSS.S.time + 0.3; DSS.S.scoldReadyAt = 0; });
  const lateOk = await waitFor(page, () => DSS.S.cases.some((c) => c.late), null, 3000);
  check('case goes late', lateOk);
  const scolded = await waitFor(page, () => DSS.S.mode === 'scene', null, 35000);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/5-manager-scold.png` });
  check('manager walks over and scolds', scolded && (await page.evaluate(() => DSS.S.scene && DSS.S.scene.kind)) === 'manager');
  await page.keyboard.press('1');
  await page.waitForTimeout(300);
  check('scold closes with a reply', (await page.evaluate(() => DSS.S.mode)) === 'playing');

  // director scene
  await page.evaluate(() => { DSS.S.scoldReadyAt = 0; DSS.queueScold('director', 'lowCompliance'); });
  const dir = await waitFor(page, () => DSS.S.mode === 'scene', null, 40000);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/6-director.png` });
  check('director scene triggers', dir && (await page.evaluate(() => DSS.S.scene.kind)) === 'director');
  await page.keyboard.press('2');

  // random event alert
  await page.evaluate(() => DSS.spawnEvent('pbrer'));
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/7-event.png` });
  check('event alert visible', await page.isVisible('#eventBox'));
  await page.keyboard.press('1');
  await page.waitForTimeout(200);
  check('event answered with key 1', !(await page.isVisible('#eventBox')));

  // meeting event: walk to meeting room
  await page.evaluate(() => DSS.spawnEvent('signal'));
  const met = await walkTo(page, 'api.goToTile(30, 5)', 20000);
  const inMeeting = await waitFor(page, () => !!DSS.S.meeting, null, 3000);
  check('meeting starts when walking into the meeting room', met && inMeeting);

  // game over by a stat hitting 0
  await page.evaluate(() => { DSS.S.time = 250; DSS.S.stats.energy = 0.3; });
  const died = await waitFor(page, () => DSS.S.mode === 'gameover', null, 5000);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/8-gameover.png`, animations: 'disabled' });
  const go = await page.evaluate(() => ({ cause: DSS.S.deathCause, score: DSS.S.score, hi: DSS.S.hi }));
  check('natural game over when energy hits 0', died && go.cause === 'energy', JSON.stringify(go));
  const postedOk = await waitFor(page, () => DSS.Board.lastPost && DSS.Board.lastPost.state === 'posted', null, 5000);
  const mine = posted[posted.length - 1] || {};
  check('score is posted to the office leaderboard', postedOk && mine.name === 'Test Player' && mine.score === go.score && /^[0-9a-f-]{36}$/.test(mine.player_id || ''), JSON.stringify(mine));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/8b-gameover-leaderboard.png`, animations: 'disabled' });
  check('game over shows the leaderboard with you highlighted', await page.evaluate(() => !!document.querySelector('.lb-slot tr.me')));
  for (const cause of ['caffeine', 'sanity', 'compliance', 'overload']) {
    await page.evaluate((c) => { DSS.start(); DSS.gameOver(c); }, cause);
    await page.waitForTimeout(250);
    check(`death screen: ${cause}`, (await page.evaluate(() => document.querySelector('.ov-text').textContent)).length > 5);
  }
  await page.screenshot({ path: `${OUT}/9-gameover-susar.png`, animations: 'disabled' });
  await page.waitForTimeout(1000);
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  const prefill = await page.evaluate(() => document.querySelector('#nameInput') && document.querySelector('#nameInput').value);
  check('restart asks for the player again, pre-filled', prefill === 'Test Player', String(prefill));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check('ENTER starts the next shift', (await page.evaluate(() => DSS.S.mode)) === 'playing');

  // clock out on purpose: confirm screen, then a friendly ending that still posts the score
  await page.evaluate(() => { DSS.S.time = 135; DSS.S.onTime = 1; });
  const postsBefore = posted.length;
  await page.click('#clockBtn');
  await page.waitForTimeout(300);
  const confirmShown = await page.evaluate(() => DSS.S.mode === 'paused' && document.querySelector('#overlay').dataset.kind === 'clockout');
  await page.screenshot({ path: `${OUT}/8c-clock-out-confirm.png`, animations: 'disabled' });
  await page.keyboard.press('Enter');
  await waitFor(page, () => DSS.Board.lastPost && DSS.Board.lastPost.state === 'posted', null, 5000);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/8d-clocked-out.png`, animations: 'disabled' });
  const co = await page.evaluate(() => ({ mode: DSS.S.mode, cause: DSS.S.deathCause, score: DSS.S.score }));
  check('clock-out button asks first, then ends the shift and posts the score', confirmShown && co.mode === 'gameover' && co.cause === 'clockout' && posted.length === postsBefore + 1, JSON.stringify(co));

  await page.reload();
  await page.waitForTimeout(600);
  const hi = await page.evaluate(() => ({ hi: DSS.S.hi, name: DSS.Board.name, local: DSS.Board.local.length }));
  check('high score, name and local board persist after reload', hi.hi.score >= go.score && hi.hi.score > 0 && hi.name === 'Test Player' && hi.local > 0, JSON.stringify(hi));

  // offline / blocked network: the game still works and keeps scores on this computer
  const offCtx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const off = await offCtx.newPage();
  off.on('pageerror', (e) => errors.push('offline pageerror: ' + e));
  await mockBoard(off, 'offline');
  await off.goto(FILE);
  const wentOffline = await waitFor(off, () => DSS.Board.status === 'offline', null, 8000);
  await off.keyboard.press('Space'); await off.waitForTimeout(200);
  await off.fill('#nameInput', 'Offline Olly'); await off.keyboard.press('Enter'); await off.waitForTimeout(200);
  await off.evaluate(() => { DSS.S.time = 200; DSS.S.stats.sanity = 0.2; });
  await waitFor(off, () => DSS.Board.lastPost && DSS.Board.lastPost.state !== 'posting', null, 8000);
  const offRes = await off.evaluate(() => ({ state: DSS.Board.lastPost.state, status: DSS.Board.status, row: document.querySelector('.lb-slot tr.me td.n') && document.querySelector('.lb-slot tr.me td.n').textContent }));
  check('offline: falls back to this computer\'s leaderboard', wentOffline && offRes.state === 'failed' && offRes.row === 'Offline Olly', JSON.stringify(offRes));
  await offCtx.close();

  // live read-only check: the real office leaderboard answers from a local file (no scores are posted)
  const liveCtx = await browser.newContext();
  const live = await liveCtx.newPage();
  await live.goto(FILE);
  const liveOk = await waitFor(live, () => DSS.Board.status !== 'loading' && DSS.Board.status !== 'idle', null, 10000);
  const liveStatus = await live.evaluate(() => DSS.Board.status);
  check('live office leaderboard reachable (read only)', liveOk && liveStatus === 'online', liveStatus);
  await liveCtx.close();

  // phone layout + touch controls
  const phone = await browser.newContext({ ...devices['iPhone 13'], defaultBrowserType: undefined });
  const pp = await phone.newPage();
  pp.on('pageerror', (e) => errors.push('phone pageerror: ' + e));
  await mockBoard(pp);
  await pp.goto(FILE);
  await pp.waitForTimeout(600);
  await pp.tap('.startBtn');
  await pp.waitForTimeout(300);
  await pp.fill('#nameInput', 'Phone Pat');
  await pp.screenshot({ path: `${OUT}/10a-phone-name.png` });
  await pp.tap('.go-btn');
  await pp.waitForTimeout(500);
  await pp.screenshot({ path: `${OUT}/10-phone.png` });
  check('phone: name entry then joystick + action button shown', (await pp.evaluate(() => DSS.S.mode)) === 'playing' && await pp.isVisible('#joy') && await pp.isVisible('#actBtn'));
  const ov = await pp.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  check('phone: no horizontal overflow', ov);

  // phone: a meeting call is a small pill at the top, never covering Casey, and shows the way
  await pp.evaluate(() => DSS.spawnEvent('signal'));
  await pp.waitForTimeout(700);
  await pp.screenshot({ path: `${OUT}/10b-phone-meeting.png` });
  const pill = await pp.evaluate(() => {
    const r = document.querySelector('#eventBox').getBoundingClientRect();
    return { mini: document.querySelector('#eventBox').classList.contains('mini'), bottom: r.bottom, height: r.height };
  });
  const caseyY = await pp.evaluate(() => (typeof toScreen === 'function') ? toScreen(DSS.P.x, DSS.P.y - 40).y : null);
  check('phone: meeting alert is a small pill above Casey', pill.mini && pill.height < 110 && caseyY !== null && pill.bottom < caseyY, JSON.stringify({ ...pill, caseyY }));
  await pp.tap('#eventBox');
  await pp.waitForTimeout(200);
  const expanded = await pp.evaluate(() => !document.querySelector('#eventBox').classList.contains('mini'));
  await pp.tap('#evMin');
  await pp.waitForTimeout(200);
  const collapsed = await pp.evaluate(() => document.querySelector('#eventBox').classList.contains('mini'));
  check('phone: tapping the pill expands it, the ▾ button shrinks it again', expanded && collapsed);

  console.log('\nconsole errors/warnings:', errors.length ? errors : 'none');
  if (errors.length) failures++;
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
