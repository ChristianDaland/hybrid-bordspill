// Spillets regler og tilstand. Ingen nettverkskode her: alt som skal ut sendes
// gjennom emit(), så logikken kan testes uten sockets.
const { randomUUID } = require('crypto');
const Physics = require('./public/physics.js');

const PALETTE = [
  '#e5484d', '#3e8ef7', '#30c07a', '#f5c518', '#a970ff', '#f2803a',
  '#17c3c9', '#ff6fb1', '#9ccc3c', '#8d9bff', '#c98b5a', '#e8e8ee',
];
const BOT_NAMES = ['Robot-Rolf', 'Bot-Berit', 'Maskin-Mona', 'Kalkulator-Knut', 'Tinn-Tove', 'Silisium-Sverre'];
const REACTIONS = ['😂', '🔥', '😱', '👏', '💀', '🍻'];
const MAX_PLAYERS = 12;
const MAX_OBSTACLES = 30;

const INTRO_MS = 2200;
const SETTLE_MARGIN_MS = 150;
const AFTER_SHOT_MS = 800;
const OFFLINE_GRACE_MS = 12000;
const REACTION_GAP_MS = 350;
const BOT_THINK_MS = 700;
const BOT_AIM_STEPS = 12;
const BOT_AIM_STEP_MS = 70;

const DEFAULT_SETTINGS = { pucksPerPlayer: 4, rounds: 3, twists: true, shotClock: 45, botLevel: 'medium', teams: false };
const BOT_LEVELS = {
  easy: { tries: 8, shake: 0.16 },
  medium: { tries: 48, shake: 0.05 },
  hard: { tries: 120, shake: 0.015 },
};
const TEAMS = [
  { name: 'Lag Rød', color: '#e5484d' },
  { name: 'Lag Blå', color: '#3e8ef7' },
];
const MAX_RECORDS = 200;
const TOP_RECORDS = 5;
const SHOT_CLOCKS = [0, 20, 30, 45, 60];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function cleanName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16);
}

function normalizeSettings(input = {}, base = DEFAULT_SETTINGS) {
  const pick = (key) => (input[key] === undefined ? base[key] : input[key]);
  const shotClock = Number(pick('shotClock'));
  return {
    pucksPerPlayer: clamp(Math.round(Number(pick('pucksPerPlayer'))) || base.pucksPerPlayer, 1, 10),
    rounds: clamp(Math.round(Number(pick('rounds'))) || base.rounds, 1, 9),
    twists: Boolean(pick('twists')),
    shotClock: SHOT_CLOCKS.includes(shotClock) ? shotClock : base.shotClock,
    botLevel: Object.hasOwn(BOT_LEVELS, pick('botLevel')) ? pick('botLevel') : base.botLevel,
    teams: Boolean(pick('teams')),
  };
}

function normalizeObstacles(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((o) => o && isNumber(o.x) && isNumber(o.y) && isNumber(o.r))
    .slice(0, MAX_OBSTACLES)
    .map((o) => ({ x: clamp(o.x, -300, 300), y: clamp(o.y, 0, Physics.LENGTH), r: clamp(o.r, 15, 150) }));
}

function normalizeConfig(input = {}) {
  const widthRatio = clamp(Math.round(Number(input.widthRatio)) || 100, 50, 100);
  return {
    widthRatio,
    obstacles: normalizeObstacles(input.obstacles),
    calibratedFor: isNumber(input.calibratedFor) ? input.calibratedFor : null,
  };
}

// Rundens vri. build() returnerer «mods» som fysikken og poengregningen leser.
const TWISTS = {
  classic: { name: 'Klassisk', text: 'Ingen triks. Bare deg og bordet.', build: () => ({}) },
  ice: { name: 'Isbane', text: 'Bordet er speilblankt. Kast lettere enn du tror.', build: () => ({ friction: 0.62 }) },
  gravel: { name: 'Grusvei', text: 'Tungt føre. Her må det kraft til.', build: () => ({ friction: 1.45 }) },
  wind: {
    name: 'Sidevind',
    text: (mods) => `Det trekker mot ${mods.wind < 0 ? 'venstre' : 'høyre'}. Sikt deretter.`,
    build: (ctx) => ({ wind: (ctx.random() < 0.5 ? -1 : 1) * (20 + ctx.random() * 25) }),
  },
  patches: {
    name: 'Flekkete føre',
    text: 'Is farer av gårde, sand bremser brått.',
    build: (ctx) => ({
      patches: ['ice', 'sand', 'ice', 'sand'].map((type) => ({ type, ...ctx.place(60 + ctx.random() * 25, 180, 780) })),
    }),
  },
  bumpers: {
    name: 'Flipperbord',
    text: 'Treff en sprettpute og hold deg fast.',
    build: (ctx) => ({ bumpers: [0, 1, 2, 3].map(() => ctx.place(26, 360, 790)) }),
  },
  gold: {
    name: 'Gullplaten',
    text: 'Stopp på gullplaten for 5 ekstra poeng.',
    build: (ctx) => ({ gold: { ...ctx.place(52, 50, 560), points: 5 } }),
  },
  reversed: { name: 'Bakvendtland', text: 'Sonene er snudd: 4 poeng ligger nærmest deg.', build: () => ({ reversed: true }) },
};

class Game {
  constructor({ config, settings, records, emit, onSave, timeScale = 1, random = Math.random, now = Date.now }) {
    this.records = Array.isArray(records) ? records : [];
    this.config = normalizeConfig(config);
    this.settings = normalizeSettings(settings);
    this.emit = emit;
    this.onSave = onSave || (() => {});
    this.timeScale = timeScale;
    this.random = random;
    this.now = now;

    this.players = new Map();
    this.timers = new Set();
    this.turnTimer = null;
    this.feed = [];
    this.feedSeq = 0;
    this.puckSeq = 0;
    this.lastReaction = new Map();
    this._toLobby();
  }

  // --- Tilstand ut ---

  publish() {
    this.emit('state', this.publicState());
  }

  publicState() {
    const { width, obstacles, mods, pucks } = this.world;
    return {
      phase: this.phase,
      round: this.round,
      settings: this.settings,
      config: this.config,
      twist: this.twist,
      world: { width, obstacles, mods, pucks },
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        connected: p.connected,
        isBot: p.isBot,
        total: p.total,
        roundScore: p.roundScore,
        pucksLeft: p.pucksLeft,
        teamName: this.teamsActive ? TEAMS[p.team].name : null,
        teamColor: this.teamsActive ? TEAMS[p.team].color : null,
      })),
      teams: this.teamsActive ? this._teamRows() : null,
      records: this._topRecords(),
      turn: this.turn && {
        playerId: this.turn.playerId,
        remainingMs: this.turn.deadline ? Math.max(0, this.turn.deadline - this.now()) : null,
        totalMs: this.turn.totalMs,
      },
      summary: this.summary,
      feed: this.feed,
    };
  }

  _feed(text, kind = 'info') {
    this.feed = [...this.feed.slice(-13), { id: ++this.feedSeq, text, kind }];
  }

  _pick(lines) {
    return lines[Math.floor(this.random() * lines.length)];
  }

  // --- Timere ---

  _later(fn, ms) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms * this.timeScale);
    this.timers.add(timer);
  }

  _clearTurnTimer() {
    clearTimeout(this.turnTimer);
    this.turnTimer = null;
  }

  _clearAllTimers() {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this._clearTurnTimer();
  }

  _armTurnClock(ms) {
    this._clearTurnTimer();
    if (!ms) {
      this.turn.deadline = null;
      this.turn.totalMs = null;
      return;
    }
    this.turn.deadline = this.now() + ms;
    this.turn.totalMs = ms;
    this.turnTimer = setTimeout(() => this._turnExpired(this.turn.playerId), ms * this.timeScale);
  }

  // --- Oppsett ---

  _emptyWorld(mods = {}) {
    return {
      width: Physics.widthFor(this.config.widthRatio),
      obstacles: this.config.obstacles,
      mods,
      pucks: [],
    };
  }

  _toLobby() {
    this._clearAllTimers();
    this.phase = 'lobby';
    this.round = 0;
    this.turn = null;
    this.turnIndex = -1;
    this.order = [];
    this.summary = null;
    this.twist = null;
    this.twistsUsed = new Set();
    this.bestShot = null;
    this.teamsActive = false;
    this.world = this._emptyWorld();
    for (const p of this.players.values()) this._resetPlayerForMatch(p);
  }

  _resetPlayerForMatch(p) {
    p.total = 0;
    p.roundScore = 0;
    p.pucksLeft = 0;
    p.team = null;
    p.stats = { shots: 0, knocks: 0, bullseyes: 0, banks: 0, falls: 0, bestValue: 0 };
  }

  setSettings(input) {
    this.settings = normalizeSettings(input, this.settings);
    this.onSave();
    this.publish();
  }

  // Bordet kan ikke endres mens en puck ruller, for da stemmer ikke simuleringen.
  setConfig(input) {
    if (this.phase === 'rolling' || !input || typeof input !== 'object') return false;
    this.config = normalizeConfig({ ...this.config, ...input });
    this.world.width = Physics.widthFor(this.config.widthRatio);
    this.world.obstacles = this.config.obstacles;
    this.onSave();
    this.publish();
    return true;
  }

  // --- Spillere ---

  _nextColor() {
    const used = new Set([...this.players.values()].map((p) => p.color));
    return PALETTE.find((c) => !used.has(c)) || PALETTE[this.players.size % PALETTE.length];
  }

  _addPlayer(fields) {
    const player = {
      id: randomUUID(),
      token: randomUUID(),
      color: this._nextColor(),
      socketId: null,
      connected: true,
      isBot: false,
      ...fields,
    };
    this._resetPlayerForMatch(player);
    if (this.teamsActive) player.team = this._smallerTeam();
    this.players.set(player.id, player);
    if (['intro', 'aiming', 'rolling'].includes(this.phase)) {
      player.pucksLeft = this.settings.pucksPerPlayer;
      this.order.push(player.id);
    }
    return player;
  }

  findByToken(token) {
    return [...this.players.values()].find((p) => p.token === token);
  }

  join({ token, name, socketId }) {
    let player = typeof token === 'string' ? this.findByToken(token) : null;
    const clean = cleanName(name);

    if (player) {
      player.socketId = socketId;
      player.connected = true;
      if (clean) player.name = clean;
      if (this.turn && this.turn.playerId === player.id) this._armTurnClock(this.settings.shotClock * 1000);
    } else {
      if (this.players.size >= MAX_PLAYERS) return null;
      player = this._addPlayer({ name: clean || `Spiller ${this.players.size + 1}`, socketId });
      this._feed(`${player.name} er med!`, 'join');
    }

    if (this.phase === 'aiming' && !this.turn) this._advance();
    else this.publish();
    return player;
  }

  // Den gamle socketen kan koble fra etter at spilleren allerede er tilbake på en ny.
  disconnect(playerId, socketId) {
    const player = this.players.get(playerId);
    if (!player || player.socketId !== socketId) return;
    player.connected = false;
    if (this.turn && this.turn.playerId === player.id) this._armTurnClock(OFFLINE_GRACE_MS);
    this.publish();
  }

  addBot() {
    if (this.players.size >= MAX_PLAYERS) return null;
    const taken = new Set([...this.players.values()].map((p) => p.name));
    const name = BOT_NAMES.find((n) => !taken.has(n)) || `Robot ${this.players.size + 1}`;
    const bot = this._addPlayer({ name, isBot: true });
    this._feed(`${bot.name} har plugget seg inn.`, 'join');
    if (this.phase === 'aiming' && !this.turn) this._advance();
    else this.publish();
    return bot;
  }

  remove(playerId) {
    const player = this.players.get(playerId);
    if (!player) return null;
    this.players.delete(playerId);

    const index = this.order.indexOf(playerId);
    if (index !== -1) {
      this.order.splice(index, 1);
      if (index <= this.turnIndex) this.turnIndex--;
    }

    if (this.players.size === 0) {
      this._toLobby();
      this.publish();
    } else if (this.turn && this.turn.playerId === playerId) {
      this._clearTurnTimer();
      this.turn = null;
      this._advance();
    } else {
      this.publish();
    }
    return player;
  }

  removeAll() {
    const removed = [...this.players.values()];
    this.players.clear();
    this._toLobby();
    this.publish();
    return removed;
  }

  // --- Kampforløp ---

  start() {
    if (!['lobby', 'practice'].includes(this.phase) || this.players.size === 0) return;
    this._startMatch();
  }

  rematch() {
    if (this.phase === 'matchOver') this._startMatch();
  }

  next() {
    if (this.phase === 'roundOver') this._startRound();
  }

  resetToLobby() {
    this._toLobby();
    this._feed('Verten nullstilte spillet.');
    this.publish();
  }

  _startMatch() {
    this._clearAllTimers();
    this.round = 0;
    this.twistsUsed = new Set();
    this.feed = [];
    this.teamsActive = false;
    for (const p of this.players.values()) this._resetPlayerForMatch(p);
    if (this.settings.teams && this.players.size >= 2) this._assignTeams();
    this._startRound();
  }

  // --- Lag ---

  _assignTeams() {
    const shuffled = [...this.players.values()]
      .map((player) => ({ player, sort: this.random() }))
      .sort((a, b) => a.sort - b.sort);
    shuffled.forEach(({ player }, i) => { player.team = i % 2; });
    this.teamsActive = true;
  }

  _smallerTeam() {
    const sizes = [0, 0];
    for (const p of this.players.values()) sizes[p.team]++;
    return sizes[0] <= sizes[1] ? 0 : 1;
  }

  _isFoe(a, b) {
    return this.teamsActive ? a.team !== b.team : a.id !== b.id;
  }

  _teamRows() {
    const players = [...this.players.values()];
    const onBoard = (id) => this.world.pucks.filter((p) => p.owner === id).length;
    return TEAMS.map((team, index) => {
      const members = players.filter((p) => p.team === index);
      const sum = (read) => members.reduce((total, p) => total + read(p), 0);
      return {
        name: team.name,
        color: team.color,
        members: members.map((p) => p.name),
        roundScore: sum((p) => p.roundScore),
        total: sum((p) => p.total),
        pucks: sum((p) => onBoard(p.id)),
      };
    }).sort((a, b) => b.total - a.total || b.roundScore - a.roundScore);
  }

  _turnOrder() {
    const byTotal = [...this.players.values()].sort((a, b) => b.total - a.total);
    if (!this.teamsActive) return byTotal.map((p) => p.id);

    const teamTotal = (team) => byTotal.filter((p) => p.team === team).reduce((sum, p) => sum + p.total, 0);
    const leader = teamTotal(0) >= teamTotal(1) ? 0 : 1;
    const first = byTotal.filter((p) => p.team === leader);
    const second = byTotal.filter((p) => p.team !== leader);
    const order = [];
    for (let i = 0; i < Math.max(first.length, second.length); i++) {
      if (first[i]) order.push(first[i].id);
      if (second[i]) order.push(second[i].id);
    }
    return order;
  }

  _chooseTwist() {
    if (this.round === 1 || !this.settings.twists) return 'classic';
    let pool = Object.keys(TWISTS).filter((id) => id !== 'classic' && !this.twistsUsed.has(id));
    if (pool.length === 0) {
      this.twistsUsed.clear();
      pool = Object.keys(TWISTS).filter((id) => id !== 'classic');
    }
    const id = pool[Math.floor(this.random() * pool.length)];
    this.twistsUsed.add(id);
    return id;
  }

  _placer() {
    const halfWidth = Physics.widthFor(this.config.widthRatio) / 2;
    const taken = this.config.obstacles.map((o) => ({ ...o }));
    return {
      random: this.random,
      place: (r, minY, maxY) => {
        const span = Math.max(0, halfWidth - r - Physics.PUCK_R);
        let spot = { x: 0, y: minY, r };
        for (let attempt = 0; attempt < 40; attempt++) {
          spot = { x: (this.random() * 2 - 1) * span, y: minY + this.random() * (maxY - minY), r };
          const free = taken.every((o) => Math.hypot(o.x - spot.x, o.y - spot.y) > o.r + r + Physics.PUCK_R);
          if (free) break;
        }
        taken.push(spot);
        return spot;
      },
    };
  }

  _startRound() {
    this._clearAllTimers();
    this.round++;
    this.summary = null;
    this.bestShot = null;
    this.turn = null;
    this.turnIndex = -1;

    const twistId = this._chooseTwist();
    const twist = TWISTS[twistId];
    const mods = twist.build(this._placer());
    this.world = this._emptyWorld(mods);
    this.twist = {
      id: twistId,
      name: twist.name,
      text: typeof twist.text === 'function' ? twist.text(mods) : twist.text,
    };

    // Lederen kaster først, så den som ligger bakerst får siste kast.
    this.order = this._turnOrder();
    for (const p of this.players.values()) {
      p.roundScore = 0;
      p.pucksLeft = this.settings.pucksPerPlayer;
    }

    this.phase = 'intro';
    this._feed(`Runde ${this.round}: ${this.twist.name}`, 'round');
    this.publish();
    this._later(() => {
      this.phase = 'aiming';
      this._advance();
    }, INTRO_MS);
  }

  _advance() {
    this._clearTurnTimer();
    this.turn = null;
    this.phase = 'aiming';

    const connected = [...this.players.values()].some((p) => p.connected);
    if (!connected) {
      this.publish();
      return;
    }

    for (let i = 1; i <= this.order.length; i++) {
      const index = (this.turnIndex + i) % this.order.length;
      const player = this.players.get(this.order[index]);
      if (player && player.connected && player.pucksLeft > 0) {
        this.turnIndex = index;
        this.turn = { playerId: player.id, deadline: null, totalMs: null };
        if (player.isBot) this._later(() => this._playBot(player), BOT_THINK_MS);
        else this._armTurnClock(this.settings.shotClock * 1000);
        this.publish();
        return;
      }
    }
    this._endRound();
  }

  _turnExpired(playerId) {
    const player = this.players.get(playerId);
    if (!player || !this.turn || this.turn.playerId !== playerId) return;
    if (player.connected) {
      player.pucksLeft = Math.max(0, player.pucksLeft - 1);
      this._feed(`${player.name} brukte for lang tid og mistet en puck.`, 'miss');
    } else {
      this._feed(`${player.name} er borte. Turen går videre.`, 'miss');
    }
    this._advance();
  }

  // --- Kast ---

  aim(playerId, input) {
    if (!this.turn || this.turn.playerId !== playerId) return;
    if (input === null) {
      this.emit('aim', { playerId, power: null }, 'boards');
      return;
    }
    if (!input || !isNumber(input.power) || !isNumber(input.angle)) return;
    this.emit(
      'aim',
      {
        playerId,
        power: clamp(input.power, 0, 1),
        angle: clamp(input.angle, -Physics.MAX_ANGLE, Physics.MAX_ANGLE),
      },
      'boards'
    );
  }

  shoot(playerId, input) {
    if (this.phase !== 'aiming' || !this.turn || this.turn.playerId !== playerId) return false;
    if (!input || !isNumber(input.power) || !isNumber(input.angle)) return false;
    if (input.power < Physics.MIN_POWER) return false;
    const player = this.players.get(playerId);
    if (!player || player.pucksLeft <= 0) return false;
    this._fire(player, clamp(input.power, 0, 1), clamp(input.angle, -Physics.MAX_ANGLE, Physics.MAX_ANGLE));
    return true;
  }

  // Et prøvekast teller ikke og viser bare den siste pucken.
  practice(playerId, input) {
    if (this.phase !== 'lobby' || !input || !isNumber(input.power) || !isNumber(input.angle)) return false;
    if (input.power < Physics.MIN_POWER) return false;
    const player = this.players.get(playerId);
    if (!player) return false;

    const puck = this._newPuck(player, clamp(input.power, 0, 1), clamp(input.angle, -Physics.MAX_ANGLE, Physics.MAX_ANGLE));
    this.world = this._emptyWorld();
    const sim = Physics.cloneWorld(this.world);
    sim.pucks.push({ ...puck });
    const steps = Physics.runToRest(sim);

    this.phase = 'practice';
    this.emit('shot', { puck, shooterId: player.id, name: player.name, practice: true });
    this.publish();
    this._later(() => {
      const landed = sim.pucks[0];
      this.world = this._emptyWorld();
      this.world.pucks = sim.pucks;
      this.phase = 'lobby';
      this.emit('shotResult', {
        shooterId: player.id,
        puckId: puck.id,
        points: landed ? Physics.puckPoints(landed, sim) : 0,
        x: landed ? landed.x : null,
        y: landed ? landed.y : null,
        banner: null,
        practice: true,
      });
      this.publish();
    }, steps * Physics.DT * 1000 + SETTLE_MARGIN_MS);
    return true;
  }

  _newPuck(player, power, angle) {
    return {
      id: ++this.puckSeq,
      owner: player.id,
      color: this.teamsActive ? TEAMS[player.team].color : player.color,
      x: 0,
      y: Physics.START_Y,
      ...Physics.shotVelocity(power, angle),
    };
  }

  _fire(player, power, angle) {
    this._clearTurnTimer();
    const puck = this._newPuck(player, power, angle);
    const sim = Physics.cloneWorld(this.world);
    sim.pucks.push({ ...puck });
    const events = [];
    const steps = Physics.runToRest(sim, events);

    player.pucksLeft--;
    player.stats.shots++;
    this.turn = null;
    this.phase = 'rolling';
    this.emit('shot', { puck, shooterId: player.id, name: player.name });
    this.publish();
    this._later(() => this._settle(player, puck, sim, events), steps * Physics.DT * 1000 + SETTLE_MARGIN_MS);
  }

  _settle(shooter, puck, sim, events) {
    const before = this.world;
    const scoresBefore = Physics.scoreWorld(before);
    const scoresAfter = Physics.scoreWorld(sim);
    const remaining = new Set(sim.pucks.map((p) => p.id));
    const finalPuck = sim.pucks.find((p) => p.id === puck.id);
    const puckScore = finalPuck ? Physics.puckPoints(finalPuck, sim) : 0;

    const knockedOwners = before.pucks.filter((p) => !remaining.has(p.id)).map((p) => p.owner);
    const knockedOthers = knockedOwners.filter((owner) => {
      const victim = this.players.get(owner);
      return !victim || this._isFoe(shooter, victim);
    });
    const banked = puckScore > 0 && events.some((e) => (e.type === 'obstacle' || e.type === 'bumper') && e.id === puck.id);

    let opponentsLost = 0;
    for (const p of this.players.values()) {
      p.roundScore = scoresAfter[p.id] || 0;
      if (this._isFoe(shooter, p)) opponentsLost += Math.max(0, (scoresBefore[p.id] || 0) - p.roundScore);
    }

    shooter.stats.knocks += knockedOthers.length;
    if (!finalPuck) shooter.stats.falls++;
    if (puckScore >= 4) shooter.stats.bullseyes++;
    if (banked) shooter.stats.banks++;

    const gain = (scoresAfter[shooter.id] || 0) - (scoresBefore[shooter.id] || 0);
    const value = gain + opponentsLost + knockedOthers.length * 2 + (banked ? 2 : 0);
    if (value > shooter.stats.bestValue) shooter.stats.bestValue = value;
    if (value >= 3 && (!this.bestShot || value >= this.bestShot.value)) {
      this.bestShot = { value, name: shooter.name, color: shooter.color, world: Physics.cloneWorld(before), puck };
    }

    const banner = this._commentShot(shooter, { finalPuck, puckScore, knockedOthers, banked });

    this.world = sim;
    this.emit('shotResult', {
      shooterId: shooter.id,
      puckId: puck.id,
      points: puckScore,
      x: finalPuck ? finalPuck.x : null,
      y: finalPuck ? finalPuck.y : null,
      banner,
    });
    this.publish();
    this._later(() => this._advance(), AFTER_SHOT_MS);
  }

  _commentShot(shooter, { finalPuck, puckScore, knockedOthers, banked }) {
    const { name } = shooter;
    if (knockedOthers.length > 0) {
      const victims = [...new Set(knockedOthers)].map((id) => this.players.get(id)?.name).filter(Boolean);
      this._feed(`${name} slo ${victims.join(' og ') || 'en puck'} av bordet!`, 'big');
      return knockedOthers.length > 1 ? 'DOBBEL KNOCKOUT!' : 'KNOCKOUT!';
    }
    if (!finalPuck) {
      this._feed(this._pick([`${name} kastet rett i gulvet.`, `Farvel, puck. Hilsen ${name}.`, `${name} målte litt for raust.`]), 'miss');
      return null;
    }
    if (banked) {
      this._feed(`${name} tok vinkelen og fikk ${puckScore}!`, 'big');
      return 'VINKELSKUDD!';
    }
    if (puckScore >= 4) {
      this._feed(this._pick([`${name} satte den perfekt: ${puckScore} poeng!`, `Kirurgisk fra ${name}. ${puckScore} poeng!`]), 'big');
      return puckScore > 4 ? 'GULL!' : null;
    }
    if (puckScore > 0) {
      this._feed(`${name} tok ${puckScore} poeng.`, 'info');
      return null;
    }
    this._feed(this._pick([`${name} ble stående i ingenmannsland.`, `${name} legger en sperre. Eller bommet.`]), 'info');
    return null;
  }

  _endRound() {
    this._clearAllTimers();
    this.turn = null;
    for (const p of this.players.values()) p.total += p.roundScore;

    const isLast = this.round >= this.settings.rounds;
    const onBoard = {};
    for (const p of this.world.pucks) onBoard[p.owner] = (onBoard[p.owner] || 0) + 1;

    const ranking = [...this.players.values()]
      .sort((a, b) => b.total - a.total || b.roundScore - a.roundScore)
      .map((p) => ({ id: p.id, name: p.name, color: p.color, roundScore: p.roundScore, total: p.total }));

    const teams = this.teamsActive ? this._teamRows() : null;
    const winners = isLast ? this._winners(teams || ranking.map((r) => ({ ...r, pucks: onBoard[r.id] || 0 }))) : null;
    if (isLast) this._recordMatch(winners);

    this.summary = {
      round: this.round,
      ranking,
      teams,
      bestShot: this.bestShot,
      winners,
      awards: isLast ? this._awards() : null,
    };
    this.phase = isLast ? 'matchOver' : 'roundOver';
    this.publish();
  }

  _winners(contenders) {
    const top = Math.max(0, ...contenders.map((c) => c.total));
    if (top > 0) {
      return { names: contenders.filter((c) => c.total === top).map((c) => c.name), points: top, reason: 'points' };
    }
    const most = Math.max(0, ...contenders.map((c) => c.pucks));
    if (most > 0) {
      return { names: contenders.filter((c) => c.pucks === most).map((c) => c.name), pucks: most, reason: 'pucks' };
    }
    return { names: [], reason: 'none' };
  }

  // Robotene holdes utenfor æresplassen.
  _recordMatch(winners) {
    for (const p of this.players.values()) {
      if (p.isBot) continue;
      let record = this.records.find((r) => r.name === p.name);
      if (!record) {
        record = { name: p.name, wins: 0, played: 0, best: 0 };
        this.records.push(record);
      }
      record.played++;
      record.best = Math.max(record.best, p.total);
      if (winners.names.includes(this.teamsActive ? TEAMS[p.team].name : p.name)) record.wins++;
    }
    this.records.sort((a, b) => b.played - a.played);
    this.records.length = Math.min(this.records.length, MAX_RECORDS);
    this.onSave();
  }

  _topRecords() {
    return [...this.records].sort((a, b) => b.wins - a.wins || b.best - a.best).slice(0, TOP_RECORDS);
  }

  resetRecords() {
    this.records = [];
    this.onSave();
    this.publish();
  }

  _awards() {
    const titles = [
      { stat: 'bullseyes', emoji: '🎯', title: 'Snikskytteren', unit: 'perfekte kast', one: 'perfekt kast' },
      { stat: 'knocks', emoji: '💥', title: 'Bulldoseren', unit: 'pucker slått ut', one: 'puck slått ut' },
      { stat: 'banks', emoji: '📐', title: 'Vinkelmesteren', unit: 'vinkelskudd' },
      { stat: 'bestValue', emoji: '⭐', title: 'Kveldens skudd', unit: 'i skuddverdi' },
      { stat: 'falls', emoji: '🕳️', title: 'Over kanten', unit: 'pucker i gulvet', one: 'puck i gulvet' },
    ];
    const players = [...this.players.values()];
    return titles.flatMap(({ stat, emoji, title, unit, one }) => {
      const best = Math.max(0, ...players.map((p) => p.stats[stat]));
      if (best === 0) return [];
      const names = players.filter((p) => p.stats[stat] === best).map((p) => p.name);
      return [{ emoji, title, names, detail: `${best} ${best === 1 && one ? one : unit}` }];
    });
  }

  // --- Robot ---

  _rateBotShot(player, power, angle) {
    const sim = Physics.cloneWorld(this.world);
    sim.pucks.push(this._newPuck(player, power, angle));
    this.puckSeq--;
    Physics.runToRest(sim);
    const before = Physics.scoreWorld(this.world);
    const after = Physics.scoreWorld(sim);
    let rating = 0;
    for (const p of this.players.values()) {
      const change = (after[p.id] || 0) - (before[p.id] || 0);
      rating += this._isFoe(player, p) ? -change : change;
    }
    return rating;
  }

  _planBotShot(player) {
    const { tries, shake } = BOT_LEVELS[this.settings.botLevel];
    let best = { power: 0.6, angle: 0, rating: -Infinity };
    for (let i = 0; i < tries; i++) {
      const power = 0.3 + this.random() * 0.6;
      const angle = (this.random() - 0.5) * 0.5;
      const rating = this._rateBotShot(player, power, angle);
      if (rating > best.rating) best = { power, angle, rating };
    }
    // Litt skjelving, ellers er roboten umulig å slå.
    return {
      power: clamp(best.power + (this.random() - 0.5) * shake, Physics.MIN_POWER, 1),
      angle: clamp(best.angle + (this.random() - 0.5) * shake, -Physics.MAX_ANGLE, Physics.MAX_ANGLE),
    };
  }

  _playBot(player) {
    if (!this.turn || this.turn.playerId !== player.id) return;
    const plan = this._planBotShot(player);
    for (let i = 1; i <= BOT_AIM_STEPS; i++) {
      this._later(() => {
        if (this.turn?.playerId !== player.id) return;
        this.aim(player.id, { power: (plan.power * i) / BOT_AIM_STEPS, angle: plan.angle });
        if (i === BOT_AIM_STEPS) this.shoot(player.id, plan);
      }, BOT_AIM_STEP_MS * i);
    }
  }

  // --- Reaksjoner ---

  react(playerId, emoji) {
    const player = this.players.get(playerId);
    if (!player || !REACTIONS.includes(emoji)) return;
    const time = this.now();
    if (time - (this.lastReaction.get(playerId) || 0) < REACTION_GAP_MS) return;
    this.lastReaction.set(playerId, time);
    this.emit('reaction', { emoji, name: player.name, color: player.color });
  }
}

module.exports = { Game, REACTIONS, normalizeConfig, normalizeSettings };
