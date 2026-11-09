const test = require('node:test');
const assert = require('node:assert');
const { Game } = require('../game');

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label = 'betingelse', ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`Tidsavbrudd: ${label}`);
    await tick(2);
  }
}

function makeGame(settings = {}) {
  const events = [];
  const game = new Game({
    settings: { rounds: 2, pucksPerPlayer: 2, twists: false, shotClock: 0, ...settings },
    emit: (event, payload, room) => events.push({ event, payload, room }),
    timeScale: 0,
  });
  return { game, events };
}

const join = (game, name) => game.join({ name, socketId: `s-${name}` });
const SHOT = { power: 0.7, angle: 0 };

async function waitForTurn(game) {
  await until(() => game.phase === 'aiming' && game.turn, 'tur');
  return game.turn.playerId;
}

test('turene går på omgang, venter på rullingen og runden avsluttes', async (t) => {
  const { game } = makeGame();
  t.after(() => game._clearAllTimers());
  const a = join(game, 'A');
  const b = join(game, 'B');
  game.start();

  const order = [];
  for (let i = 0; i < 4; i++) {
    const id = await waitForTurn(game);
    order.push(id);
    assert.ok(game.shoot(id, SHOT));
    assert.strictEqual(game.phase, 'rolling');
    assert.strictEqual(game.shoot(id, SHOT), false, 'kan ikke kaste mens pucken ruller');
    await until(() => game.phase !== 'rolling', 'stopp');
  }
  assert.deepStrictEqual(order, [a.id, b.id, a.id, b.id]);
  assert.strictEqual(game.phase, 'roundOver');
  assert.ok(game.summary.ranking.length === 2);
});

test('hele kampen gir vinner og tillater omkamp', async (t) => {
  const { game } = makeGame({ rounds: 1, pucksPerPlayer: 1 });
  t.after(() => game._clearAllTimers());
  join(game, 'A');
  game.start();
  const id = await waitForTurn(game);
  game.shoot(id, SHOT);
  await until(() => game.phase === 'matchOver', 'kampslutt');
  assert.ok(game.summary.winners);
  assert.ok(Array.isArray(game.summary.awards));
  game.rematch();
  assert.strictEqual(game.phase, 'intro');
  assert.strictEqual([...game.players.values()][0].total, 0);
});

test('bare den med tur kan kaste, og ugyldige kast avvises', async (t) => {
  const { game } = makeGame();
  t.after(() => game._clearAllTimers());
  join(game, 'A');
  join(game, 'B');
  game.start();
  const id = await waitForTurn(game);
  const other = [...game.players.keys()].find((k) => k !== id);
  assert.strictEqual(game.shoot(other, SHOT), false);
  assert.strictEqual(game.shoot(id, { power: NaN, angle: 0 }), false);
  assert.strictEqual(game.shoot(id, { power: '1', angle: 0 }), false);
  assert.strictEqual(game.shoot(id, { power: 0.01, angle: 0 }), false);
  assert.strictEqual(game.phase, 'aiming');
});

test('gjenoppkobling beholder spilleren, og gammel socket kan ikke melde den ut', () => {
  const { game } = makeGame();
  const a = game.join({ name: 'A', socketId: 's1' });
  game.join({ token: a.token, socketId: 's2' });
  assert.strictEqual(game.players.size, 1);
  game.disconnect(a.id, 's1');
  assert.strictEqual(a.connected, true);
  game.disconnect(a.id, 's2');
  assert.strictEqual(a.connected, false);
});

test('frakobling av den aktive går videre etter fristen, uten å ta pucken', async (t) => {
  const { game } = makeGame();
  t.after(() => game._clearAllTimers());
  const a = join(game, 'A');
  const b = join(game, 'B');
  game.start();
  const id = await waitForTurn(game);
  assert.strictEqual(id, a.id);
  game.disconnect(a.id, a.socketId);
  await until(() => game.turn && game.turn.playerId === b.id, 'neste spiller');
  assert.strictEqual(a.pucksLeft, 2);
});

test('skuddklokken tar pucken fra en tilkoblet spiller', async (t) => {
  const { game } = makeGame({ shotClock: 20 });
  t.after(() => game._clearAllTimers());
  const a = join(game, 'A');
  join(game, 'B');
  game.start();
  await until(() => a.pucksLeft === 1, 'puck tapt');
});

test('utkast av den aktive sender turen videre uten krasj', async (t) => {
  const { game } = makeGame();
  t.after(() => game._clearAllTimers());
  const a = join(game, 'A');
  const b = join(game, 'B');
  game.start();
  await waitForTurn(game);
  game.remove(a.id);
  assert.strictEqual(game.turn.playerId, b.id);
});

test('farger gjenbrukes ikke etter utkast', () => {
  const { game } = makeGame();
  const a = join(game, 'A');
  const b = join(game, 'B');
  join(game, 'C');
  game.remove(a.id);
  const d = join(game, 'D');
  const colors = [...game.players.values()].map((p) => p.color);
  assert.strictEqual(new Set(colors).size, colors.length);
  assert.notStrictEqual(d.color, b.color);
});

test('utstilt tilstand lekker ikke tokens', () => {
  const { game } = makeGame();
  const a = join(game, 'A');
  assert.ok(!JSON.stringify(game.publicState()).includes(a.token));
});

test('en spiller som blir med underveis får pucker og tur', async (t) => {
  const { game } = makeGame();
  t.after(() => game._clearAllTimers());
  const a = join(game, 'A');
  game.start();
  await waitForTurn(game);
  const b = join(game, 'B');
  assert.strictEqual(b.pucksLeft, 2);
  game.shoot(a.id, SHOT);
  await until(() => game.turn && game.turn.playerId === b.id, 'nykommerens tur');
});

test('roboter spiller en hel kamp alene', async (t) => {
  const { game } = makeGame({ rounds: 1, pucksPerPlayer: 3 });
  t.after(() => game._clearAllTimers());
  game.addBot();
  game.addBot();
  game.start();
  await until(() => game.phase === 'matchOver', 'robotkamp', 8000);
  const total = game.summary.ranking.reduce((sum, r) => sum + r.total, 0);
  assert.ok(total > 0, 'roboter skal klare å score');
});

test('alle varianter gir spillbare runder', async (t) => {
  const { game } = makeGame({ rounds: 9, pucksPerPlayer: 1, twists: true });
  t.after(() => game._clearAllTimers());
  game.addBot();
  game.start();
  const seen = new Set();
  await until(() => {
    if (game.twist) seen.add(game.twist.id);
    if (game.phase === 'roundOver') game.next();
    return game.phase === 'matchOver';
  }, 'alle runder', 15000);
  assert.ok(seen.size === 8, `så ${[...seen]}`);
});

test('bordet kan ikke endres mens en puck ruller, og verdier begrenses', async (t) => {
  const { game } = makeGame();
  t.after(() => game._clearAllTimers());
  game.setConfig({ widthRatio: 5000, obstacles: [{ x: 1e9, y: 1, r: 1 }, { x: 'a' }] });
  assert.strictEqual(game.config.widthRatio, 100);
  assert.deepStrictEqual(game.config.obstacles, [{ x: 300, y: 1, r: 15 }]);

  const a = join(game, 'A');
  game.start();
  await waitForTurn(game);
  game.shoot(a.id, SHOT);
  assert.strictEqual(game.setConfig({ widthRatio: 60 }), false);
});

test('reaksjoner begrenses og må være fra listen', () => {
  const { game, events } = makeGame();
  const a = join(game, 'A');
  game.react(a.id, '<img>');
  game.react(a.id, '🔥');
  game.react(a.id, '🔥');
  assert.strictEqual(events.filter((e) => e.event === 'reaction').length, 1);
});
