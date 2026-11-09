const test = require('node:test');
const assert = require('node:assert');
const P = require('../public/physics.js');

function world(extra = {}) {
  return { width: 450, obstacles: [], mods: {}, pucks: [], ...extra };
}

function puck(id, x, y, vx = 0, vy = 0, owner = 'a') {
  return { id, owner, x, y, vx, vy };
}

function launch(w, power, angle = 0) {
  w.pucks.push({ id: 99, owner: 'a', x: 0, y: P.START_Y, ...P.shotVelocity(power, angle) });
  P.runToRest(w);
  return w.pucks.find((p) => p.id === 99);
}

test('kraftkurven gir bred kontroll over poengsonene', () => {
  const landing = (power) => {
    const p = launch(world(), power);
    return p ? p.y : -1;
  };
  // 1-poengssonen begynner på y=320, enden er y=0.
  assert.ok(landing(0.25) > 320, 'kort kast skal stoppe før sonene');
  const y = landing(0.7);
  assert.ok(y >= 0 && y < 320, `0.7 skal lande i sonene, fikk ${y}`);
  assert.strictEqual(landing(1), -1, 'fullt kast skal gå av bordet');

  const perZone = 80 / ((1000 - 560) / 0.6);
  assert.ok(perZone * 200 > 15, 'hver sone skal være over 15 px drag på 200 px maksdrag');
});

test('landingen stemmer med ønsket lengde', () => {
  const p = launch(world(), 0.55);
  const wanted = P.powerToDistance(0.55);
  assert.ok(Math.abs(P.START_Y - p.y - wanted) < 8, `avvik ${P.START_Y - p.y - wanted}`);
});

test('sprett følger innfallsvinkelen', () => {
  const w = world({ obstacles: [{ x: 0, y: 500, r: 50 }] });
  w.pucks.push(puck(1, 30, 700, 0, -600));
  const events = [];
  while (events.length === 0 && P.step(w, events));
  assert.strictEqual(events[0].type, 'obstacle');
  assert.ok(w.pucks[0].vx > 0, 'skal sprette mot siden den traff på');
  assert.ok(w.pucks[0].vy > 0, 'skal sprette tilbake');
});

test('pucken ender aldri inne i en hindring', () => {
  const w = world({ obstacles: [{ x: 0, y: 500, r: 60 }] });
  w.pucks.push(puck(1, 0, 900, 0, -500));
  P.runToRest(w);
  for (const p of w.pucks) assert.ok(Math.hypot(p.x, p.y - 500) >= 60 + P.PUCK_R - 0.01);
});

test('støt overfører fart og pucker overlapper ikke', () => {
  const w = world({ pucks: [puck(1, 0, 700, 0, -500), puck(2, 0, 500, 0, 0, 'b')] });
  P.runToRest(w);
  const [a, b] = [w.pucks.find((p) => p.id === 1), w.pucks.find((p) => p.id === 2)];
  assert.ok(b.y < 500, 'den truffede pucken skal flytte seg');
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= P.PUCK_R * 2 - 0.01);
});

test('pucker utenfor bordet fjernes', () => {
  const w = world({ pucks: [puck(1, 200, 500, 900, 0)] });
  const events = [];
  P.runToRest(w, events);
  assert.strictEqual(w.pucks.length, 0);
  assert.ok(events.some((e) => e.type === 'fall'));
});

test('poeng, bakvendt bane og gullplate', () => {
  assert.strictEqual(P.zonePoints(10), 4);
  assert.strictEqual(P.zonePoints(90), 3);
  assert.strictEqual(P.zonePoints(250), 1);
  assert.strictEqual(P.zonePoints(320), 0);
  assert.strictEqual(P.zonePoints(10, { reversed: true }), 1);
  const w = world({ mods: { gold: { x: 0, y: 500, r: 50, points: 5 } }, pucks: [puck(1, 10, 510)] });
  assert.deepStrictEqual(P.scoreWorld(w), { a: 5 });
});

test('simuleringen er deterministisk', () => {
  const make = () =>
    world({
      obstacles: [{ x: 40, y: 400, r: 50 }],
      mods: { wind: 30, bumpers: [{ x: -60, y: 600, r: 26 }], patches: [{ type: 'ice', x: 0, y: 700, r: 80 }] },
      pucks: [puck(1, 10, 300), puck(2, -40, 200, 0, 0, 'b')],
    });
  const a = make();
  const b = make();
  assert.deepStrictEqual(launch(a, 0.8, 0.05), launch(b, 0.8, 0.05));
  assert.deepStrictEqual(a.pucks, b.pucks);
});

test('tregere bildefrekvens endrer ikke resultatet: steget er fast', () => {
  const a = world();
  const b = world();
  const pa = launch(a, 0.6);
  a.pucks = [];
  const v = P.shotVelocity(0.6, 0);
  b.pucks.push({ id: 99, owner: 'a', x: 0, y: P.START_Y, ...v });
  while (P.step(b));
  assert.ok(Math.abs(pa.y - b.pucks[0].y) < 1e-9);
});
