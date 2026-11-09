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

test('prøvekast teller ikke, viser bare siste puck og kan avbrytes av start', async (t) => {
  const { game, events } = makeGame();
  t.after(() => game._clearAllTimers());
  const a = join(game, 'A');
  assert.ok(game.practice(a.id, SHOT));
  assert.strictEqual(game.phase, 'practice');
  assert.strictEqual(game.practice(a.id, SHOT), false, 'ett prøvekast om gangen');
  await until(() => game.phase === 'lobby', 'prøvekast ferdig');
  assert.strictEqual(game.world.pucks.length, 1);
  assert.strictEqual(a.stats.shots, 0);
  assert.ok(events.some((e) => e.event === 'shotResult' && e.payload.practice));

  game.practice(a.id, SHOT);
  game.start();
  assert.strictEqual(game.phase, 'intro');
  assert.strictEqual(game.world.pucks.length, 0);
});

test('prøvekast er ikke mulig under kamp', async (t) => {
  const { game } = makeGame();
  t.after(() => game._clearAllTimers());
  const a = join(game, 'A');
  game.start();
  await waitForTurn(game);
  assert.strictEqual(game.practice(a.id, SHOT), false);
});

test('lagspill veksler mellom lagene og teller lagets sum', async (t) => {
  const { game } = makeGame({ teams: true, rounds: 1, pucksPerPlayer: 1 });
  t.after(() => game._clearAllTimers());
  ['A', 'B', 'C', 'D'].forEach((n) => join(game, n));
  game.start();
  const teams = game.order.map((id) => game.players.get(id).team);
  assert.strictEqual(new Set(teams).size, 2);
  teams.forEach((team, i) => { if (i) assert.notStrictEqual(team, teams[i - 1], 'lagene skal veksle'); });

  for (let i = 0; i < 4; i++) {
    const id = await waitForTurn(game);
    game.shoot(id, SHOT);
    await until(() => game.phase !== 'rolling', 'stopp');
  }
  await until(() => game.phase === 'matchOver', 'kampslutt');
  const sum = game.summary.teams.reduce((total, row) => total + row.total, 0);
  assert.strictEqual(sum, game.summary.ranking.reduce((total, row) => total + row.total, 0));
  assert.ok(game.summary.winners.names.every((n) => n.startsWith('Lag')));
});

test('å slå ut en lagkamerat er ikke knockout', async (t) => {
  const { game } = makeGame({ teams: true, rounds: 1, pucksPerPlayer: 1 });
  t.after(() => game._clearAllTimers());
  const a = join(game, 'A');
  const b = join(game, 'B');
  game.start();
  await waitForTurn(game);
  b.team = a.team;
  assert.strictEqual(game._isFoe(a, b), false);
  b.team = 1 - a.team;
  assert.strictEqual(game._isFoe(a, b), true);
});

test('lagspill krever to spillere, og en nykommer går til minste lag', async (t) => {
  const { game } = makeGame({ teams: true });
  t.after(() => game._clearAllTimers());
  join(game, 'A');
  game.start();
  assert.strictEqual(game.teamsActive, false);
  game.resetToLobby();
  join(game, 'B');
  join(game, 'C');
  game.start();
  const d = join(game, 'D');
  const sizes = [0, 1].map((team) => [...game.players.values()].filter((p) => p.team === team).length);
  assert.deepStrictEqual(sizes, [2, 2]);
  assert.ok(d.team === 0 || d.team === 1);
  assert.ok(game.publicState().teams.length === 2);
});

test('æresplassen husker mennesker, ikke roboter, og tåler rare navn', async (t) => {
  const { game } = makeGame({ rounds: 1, pucksPerPlayer: 1 });
  t.after(() => game._clearAllTimers());
  const a = join(game, '__proto__');
  game.addBot();
  for (let match = 0; match < 2; match++) {
    if (match === 0) game.start();
    else game.rematch();
    await until(() => {
      if (game.phase === 'aiming' && game.turn && game.turn.playerId === a.id) game.shoot(a.id, SHOT);
      return game.phase === 'matchOver';
    }, 'kampslutt');
  }
  assert.strictEqual(game.records.length, 1);
  assert.strictEqual(game.records[0].played, 2);
  assert.strictEqual({}.played, undefined);
  game.resetRecords();
  assert.strictEqual(game.publicState().records.length, 0);
});

test('ugyldig robotnivå ignoreres og proff slår lett over tid', async (t) => {
  const { game } = makeGame();
  game.setSettings({ botLevel: 'constructor' });
  assert.strictEqual(game.settings.botLevel, 'medium');

  async function average(level) {
    const { game: g } = makeGame({ rounds: 1, pucksPerPlayer: 4, botLevel: level });
    t.after(() => g._clearAllTimers());
    g.addBot();
    g.start();
    await until(() => g.phase === 'matchOver', 'robotkamp', 8000);
    return g.summary.ranking[0].total;
  }
  let easy = 0;
  let hard = 0;
  for (let i = 0; i < 6; i++) {
    easy += await average('easy');
    hard += await average('hard');
  }
  assert.ok(hard > easy, `proff ${hard}, lett ${easy}`);
});
