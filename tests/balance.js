// Balance check: plays whole games headlessly with bot players (real grid movement, real rules).
// Run: cd tests && npm install && node balance.js
// Targets: an idle player lasts a few minutes; an average (casual) player survives ~15 minutes (1 day = 90 s).
const { chromium } = require('playwright');
const path = require('path');
const FILE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');

async function launch() {
  try { return await chromium.launch({ channel: 'chrome', headless: true }); }
  catch (e) { return chromium.launch({ headless: true }); }
}

(async () => {
  const browser = await launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(FILE);
  await page.waitForTimeout(300);

  const runs = [
    ['idle (never touches anything)', 'idle', 30],
    ['coffee spammer (stands at the machine)', 'spam', 10],
    ['good player (decides every 0.5 s, answers alerts in 1.5 s)', [0.5, 1.5, 0], 20],
    ['casual player (every 1.5 s, answers in 3 s, sloppy)', [1.5, 3, 300], 20],
    ['slow player (every 3 s, answers in 6 s, very sloppy)', [3, 6, 800], 20],
  ];
  for (const [name, kind, n] of runs) {
    const res = await page.evaluate(([kind, n]) => {
      const C = DSS.CONFIG, P = DSS.P;
      const clamp = (v) => Math.max(0, Math.min(100, v));
      const U = (st) => {
        let u = 0;
        for (const k of Object.keys(st)) u -= Math.max(0, 55 - st[k]) ** 2;
        if (st.caffeine > C.jitter.threshold) u -= (st.caffeine - C.jitter.threshold) ** 2 * 3;
        if (st.caffeine >= C.jitter.overloadAt - 2) u -= 5000;
        return u;
      };
      const score = (S, fx, noise) => {
        const s = { ...S.stats };
        let extra = 0;
        for (const [k, v] of Object.entries(fx || {})) {
          if (k in s) s[k] = clamp(s[k] + v);
          else if (k === 'cases' || k === 'favor' || k === 'serious') extra -= 60 * v;
          else if (k === 'removeCase') extra += 60 * v;
          else if (k === 'dbDown') extra -= 5 * v;
        }
        return U(s) + extra + (Math.random() - 0.5) * noise;
      };
      const best = (S, choices, noise) => {
        let bi = 0, bu = -Infinity;
        choices.forEach((ch, i) => { const u = score(S, ch.effects, noise); if (u > bu) { bu = u; bi = i; } });
        return bi;
      };
      const makeBot = ([reaction, eventDelay, noise]) => {
        let next = 0, evSeen = null, evAt = 0, resting = false;
        return (api, S) => {
          if (S.mode === 'dialog') return DSS.chooseAny(best(S, S.dialog.choices, noise));
          if (S.mode === 'scene') return DSS.chooseAny(best(S, S.scene.choices, noise));
          if (S.event && S.event.def.type !== 'meeting') {
            if (evSeen !== S.event) { evSeen = S.event; evAt = S.time; }
            if (S.time - evAt >= eventDelay) DSS.chooseAny(best(S, S.event.def.choices, noise));
          }
          if (S.time < next) return;
          next = S.time + reaction;
          api.hold(false);
          const st = S.stats;
          if (P.lockedUntil > S.time || S.meeting) return;
          if (S.event && S.event.def.type === 'meeting') { api.goToTile(30, 5); return; }
          if (st.caffeine < 50 && api.coffeeReady() && st.caffeine + C.coffee.caffeine < C.jitter.overloadAt - 2) { if (api.goToObj('C')) api.press(); return; }
          if (st.energy < 45 && api.vendReady()) { if (api.goToObj('V')) api.press(); return; }   // snacks for Energy
          // Sanity: chat with a nearby colleague, otherwise rest in the break area until recovered
          // (with hysteresis, like a person would, and leaving before the manager notices)
          if (st.sanity < 40) resting = true;
          if (resting && (st.sanity > 70 || (api.zone() === 'break' && S.breakT > C.breakArea.maxSeconds - 1))) resting = false;
          if (resting) {
            const man = (e) => Math.abs(e.tx - P.tx) + Math.abs(e.ty - P.ty);
            const mate = DSS.NPCS.filter((e) => e.role === 'colleague' && S.time >= e.chatReadyAt && e.state !== 'talk').sort((a, b) => man(a) - man(b))[0];
            if (mate && man(mate) < 8) { if (api.goToNpc(mate)) api.press(); return; }
            if (api.zone() !== 'break') { api.goToTile(25, 21); return; }
            return;
          }
          if (S.cases.length) { if (api.goToTile(22, 9)) { P.dir = 'down'; api.hold(true); } return; }
          api.goToTile(22, 9);
        };
      };
      const out = [];
      const time = { working: 0, walking: 0, breakArea: 0, brewingOrMeeting: 0, deskNoCases: 0, other: 0 };
      const track = (policy) => { let last = 0; return (api, S) => { const dt = Math.max(0, S.time - last); last = S.time;
        if (S.working) time.working += dt; else if (P.lockedUntil > S.time) time.brewingOrMeeting += dt; else if (P.moving) time.walking += dt;
        else if (api.zone() === 'break') time.breakArea += dt; else if (!S.cases.length) time.deskNoCases += dt; else time.other += dt;
        policy(api, S); }; };
      for (let i = 0; i < n; i++) {
        let policy;
        if (kind === 'idle') policy = () => {};
        else if (kind === 'spam') policy = (api, S) => { if (S.mode === 'dialog' || S.mode === 'scene') return DSS.chooseAny(0); if (api.goToObj('C')) api.press(); };
        else policy = makeBot(kind);
        out.push(DSS.simulate(track(policy), 1800));
      }
      const secs = out.map((r) => r.seconds).sort((a, b) => a - b);
      const causes = {};
      out.forEach((r) => (causes[r.cause] = (causes[r.cause] || 0) + 1));
      const avg = (k) => +(out.reduce((a, r) => a + r[k], 0) / out.length).toFixed(1);
      return { min: secs[0], median: secs[Math.floor(n / 2)], max: secs[n - 1], medianDays: +(secs[Math.floor(n / 2)] / C.secondsPerDay).toFixed(2),
        causes, time: Object.fromEntries(Object.entries(time).map(([k, v]) => [k, Math.round(100 * v / out.reduce((a, r) => a + r.seconds, 0)) + '%'])), avgOnTime: avg('onTime'), avgLate: avg('late'), avgScore: avg('score') };
    }, [kind, n]);
    console.log(`${name.padEnd(62)} survive ${res.min}-${res.max}s (median ${res.median}s = ${res.medianDays} days)  died of ${JSON.stringify(res.causes)}  on-time ${res.avgOnTime} late ${res.avgLate} score ${res.avgScore}
    time split: ${JSON.stringify(res.time)}`);
  }
  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close();
})();
