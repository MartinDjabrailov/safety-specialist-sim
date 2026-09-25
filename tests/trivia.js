// PV Trivia checks: bank integrity + counts, no-repeat shuffle bag, reshuffle, persistence, difficulty ramp, screenshots.
// Run: cd tests && node trivia.js   (screenshots land in tests/shots/)
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const FILE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = path.resolve(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };
async function launch() {
  try { return await chromium.launch({ channel: 'chrome', headless: true }); }
  catch (e) { return chromium.launch({ headless: true }); }
}
const waitFor = async (page, fn, arg, timeout = 15000) => {
  try { await page.waitForFunction(fn, arg, { timeout, polling: 50 }); return true; } catch (e) { return false; }
};

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/rest/v1/leaderboard**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto(FILE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForTimeout(400);

  // ---- 1. bank integrity + counts ----
  const bank = await page.evaluate(() => {
    const B = DSS.CONTENT.triviaBank, cats = Object.keys(DSS.CONTENT.triviaCategories), errs = [], ids = new Set();
    for (const q of B) {
      if (ids.has(q.id)) errs.push('duplicate id ' + q.id); ids.add(q.id);
      if (!cats.includes(q.cat)) errs.push('bad category ' + q.id);
      if (![1, 2, 3].includes(q.diff)) errs.push('bad difficulty ' + q.id);
      if (!q.q || !q.why) errs.push('missing text ' + q.id);
      if (q.type === 'tf') { if (typeof q.answer !== 'boolean') errs.push('tf answer ' + q.id); }
      else if (q.type === 'mc' || q.type === 'odd') {
        if (!Array.isArray(q.options) || q.options.length !== 4 || new Set(q.options).size !== 4) errs.push('options ' + q.id);
        if (!(q.answer >= 0 && q.answer < 4)) errs.push('answer index ' + q.id);
      } else errs.push('type ' + q.id);
    }
    const grid = {}, types = {};
    for (const q of B) { grid[q.cat] = grid[q.cat] || { total: 0, d1: 0, d2: 0, d3: 0 }; grid[q.cat].total++; grid[q.cat]['d' + q.diff]++; types[q.type] = (types[q.type] || 0) + 1; }
    return { total: B.length, errs, grid, types, review: B.filter((q) => q.review).map((q) => q.id) };
  });
  check('bank has 150+ questions', bank.total >= 150, `(${bank.total})`);
  check('every question is well-formed', bank.errs.length === 0, bank.errs.join(', '));
  console.log('\nQuestions per category and difficulty:');
  console.table(bank.grid);
  console.log('Formats:', JSON.stringify(bank.types), '· review:true →', bank.review.join(', '), '\n');

  // ---- 2. shuffle bag: draw the whole bank with zero repeats, no same category back to back, then reshuffle ----
  const bag = await page.evaluate(() => {
    const TB = DSS.TriviaBag, N = DSS.CONTENT.triviaBank.length;
    localStorage.removeItem(DSS.CONFIG.storageKeys.trivia); TB.load();
    const drawn = [];
    for (let i = 0; i < N; i++) drawn.push(TB.draw(1 + Math.floor(i / 20)));   // shift days 1..8 as the run goes on
    const ids = drawn.map((q) => q.id);
    let sameCatPairs = 0;
    for (let i = 1; i < drawn.length; i++) if (drawn[i].cat === drawn[i - 1].cat) sameCatPairs++;
    const first150Unique = new Set(ids.slice(0, 150)).size;
    const cycleBefore = TB.cycle;
    const next = TB.draw(3);
    return { N, unique: new Set(ids).size, first150Unique, sameCatPairs, cycleBefore, cycleAfter: TB.cycle, seenAfter: TB.seen.size, nextWasSeenBefore: ids.includes(next.id) };
  });
  check('150 draws in a row: zero repeats', bag.first150Unique === 150, `(${bag.first150Unique}/150 unique)`);
  check('whole bank drawn once with zero repeats', bag.unique === bag.N, `(${bag.unique}/${bag.N})`);
  check('no two questions from the same category back to back', bag.sameCatPairs === 0, `(${bag.sameCatPairs} pairs)`);
  check('after the whole bank, the bag reshuffles and starts again', bag.cycleAfter === bag.cycleBefore + 1 && bag.seenAfter === 1 && bag.nextWasSeenBefore, JSON.stringify({ cycle: [bag.cycleBefore, bag.cycleAfter], seenAfter: bag.seenAfter }));

  // ---- 3. the bag survives a reload (tracked in localStorage) ----
  await page.evaluate(() => { localStorage.removeItem(DSS.CONFIG.storageKeys.trivia); DSS.TriviaBag.load(); for (let i = 0; i < 20; i++) DSS.TriviaBag.draw(1); });
  await page.reload(); await page.waitForTimeout(300);
  const persisted = await page.evaluate(() => DSS.TriviaBag.seen.size);
  check('seen questions persist across page reloads', persisted === 20, `(${persisted})`);

  // ---- 4. difficulty ramp ----
  const ramp = await page.evaluate(() => {
    const TB = DSS.TriviaBag, share = (day) => {
      localStorage.removeItem(DSS.CONFIG.storageKeys.trivia); TB.load();
      const d = { 1: 0, 2: 0, 3: 0 };
      for (let i = 0; i < 30; i++) d[TB.draw(day).diff]++;
      return d;
    };
    return { day1: share(1), day7: share(7) };
  });
  check('day 1 draws mostly difficulty 1 (no difficulty 3)', ramp.day1[1] >= 18 && ramp.day1[3] === 0, JSON.stringify(ramp.day1));
  check('day 7 mixes in difficulty 2 and 3', ramp.day7[2] > 0 && ramp.day7[3] > 0, JSON.stringify(ramp.day7));
  await page.evaluate(() => { localStorage.removeItem(DSS.CONFIG.storageKeys.trivia); DSS.TriviaBag.load(); });

  // ---- 5. play it for real: walk to the arcade cabinet, answer, screenshots ----
  await page.keyboard.press('Space'); await page.waitForTimeout(200);
  await page.fill('#nameInput', 'Trivia Tester'); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
  await page.evaluate(() => { DSS.S.nextEventAt = 9999; DSS.S.nextCaseAt = 9999; });
  const walked = await waitFor(page, () => DSS.api.goToObj('a'), null, 30000);
  check('walked to the arcade cabinet (prompt: PLAY PV TRIVIA)', walked);
  // fixed question order for the screenshots: multiple choice, true/false, odd one out, then streak questions
  await page.evaluate(() => {
    const B = DSS.CONTENT.triviaBank, byId = (id) => B.find((q) => q.id === id);
    const seq = ['meddra-005', 'time-002', 'case-003', 'signal-001', 'regs-013', 'agg-011', 'hist-003'].map(byId);
    let i = 0; DSS.TriviaBag._draw = DSS.TriviaBag.draw;
    DSS.TriviaBag.draw = () => seq[i++ % seq.length];
  });
  await page.keyboard.press('e');
  const started = await waitFor(page, () => DSS.S.mode === 'minigame' && DSS.MG.active && DSS.MG.active.kind === 'trivia', null, 3000);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/t0-trivia-intro.png`, animations: 'disabled' });
  check('E at the cabinet starts PV TRIVIA', started);
  const answerRight = async () => { const i = await page.evaluate(() => DSS.MG.active.q.opts.findIndex((o) => o.ok)); await page.keyboard.press(String(i + 1)); };
  const waitQuestion = () => waitFor(page, () => DSS.MG.active && DSS.MG.active.state === 'question', null, 6000);

  await waitQuestion(); await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/t1-multiple-choice.png` });
  check('multiple-choice question shows 4 options and a countdown', await page.evaluate(() => DSS.MG.active.q.type === 'mc' && document.querySelectorAll('.tv-opts .choice').length === 4 && !!document.querySelector('#qBar')));
  await answerRight(); await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/t2-correct-did-you-know.png` });
  check('CORRECT banner and "Did you know?" appear', await page.evaluate(() => !!document.querySelector('.tv-banner.ok') && /DID YOU KNOW/.test(document.querySelector('.tv-why').textContent)));

  await waitQuestion(); await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/t3-true-false.png` });
  check('true/false question shows TRUE and FALSE', await page.evaluate(() => DSS.MG.active.q.type === 'tf' && document.querySelectorAll('.tv-opts.two .choice').length === 2));
  const tfWrong = await page.evaluate(() => DSS.MG.active.q.opts.findIndex((o) => !o.ok));
  await page.keyboard.press(tfWrong === 0 ? 't' : 'f'); await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/t4-wrong.png` });
  check('WRONG banner appears and the streak resets', await page.evaluate(() => !!document.querySelector('.tv-banner.bad') && DSS.S.triviaStreak === 0));

  await waitQuestion(); await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/t5-odd-one-out.png` });
  check('odd-one-out question is labelled', await page.evaluate(() => DSS.MG.active.q.type === 'odd' && /ODD ONE OUT/.test(document.querySelector('.tv-top').textContent)));
  await answerRight(); await page.waitForTimeout(200);

  // streak: bump to 4, then a 5th correct answer triggers the streak bonus
  await waitQuestion();
  const san0 = await page.evaluate(() => { DSS.S.triviaStreak = 4; DSS.S.stats.sanity = 50; return DSS.S.stats.sanity; });
  await page.evaluate(() => UI.renderMinigame(DSS.MG.active));
  await answerRight(); await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/t6-streak.png` });
  const st = await page.evaluate(() => ({ streak: DSS.S.triviaStreak, mult: DSS.MG.active.mult, bonus: DSS.MG.active.bonusMsg, sanity: DSS.S.stats.sanity }));
  check('streak of 5 shows ×2 and gives a Sanity boost', st.streak === 5 && st.mult === 2 && /STREAK 5/.test(st.bonus) && st.sanity > san0, JSON.stringify(st));

  for (let r = 0; r < 3; r++) { await waitQuestion(); await answerRight(); await page.waitForTimeout(200); }
  const done = await waitFor(page, () => DSS.MG.active && DSS.MG.active.state === 'result', null, 8000);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/t7-result.png`, animations: 'disabled' });
  check('game ends with a result screen after 7 questions', done && await page.evaluate(() => DSS.MG.active.round === 7));
  await page.keyboard.press('e'); await page.waitForTimeout(200);
  check('back in the office afterwards', (await page.evaluate(() => DSS.S.mode)) === 'playing');

  console.log('\nconsole errors:', errors.length ? errors : 'none');
  if (errors.length) failures++;
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
