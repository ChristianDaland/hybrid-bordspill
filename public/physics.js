// Felles fysikkmotor for server og storskjerm.
//
// Verden måles i bord-enheter: bordet er alltid 1000 langt, x = 0 er midtlinjen
// og y = 0 er enden med 4-poengssonen. Tidssteget er fast, og step() bruker bare
// + - * / og sqrt, så samme skudd gir samme bane på server og skjerm.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Physics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const LENGTH = 1000;
  const BASE_WIDTH = 450;
  const PUCK_R = 20;
  const START_Y = 950;
  const ZONE_H = 80;
  const DT = 1 / 120;
  const MAX_STEPS = 30 * 120;

  const MU = 220;
  const DRAG = 0.35;
  const OBSTACLE_BOUNCE = 0.7;
  const PUCK_BOUNCE = 0.9;
  const BUMPER_KICK = 260;
  const MIN_EVENT_SPEED = 15;
  const SURFACE_FRICTION = { ice: 0.3, sand: 3 };

  // Kraft (0–1) til ønsket glidelengde. Det midterste området dekker poengsonene,
  // så en vanlig kastelengde får mest mulig av fingerens bevegelse.
  const POWER_CURVE = [
    [0, 0],
    [0.25, 560],
    [0.85, 1000],
    [1, 1700],
  ];
  const MIN_POWER = 0.06;
  const MAX_ANGLE = 0.7;

  function widthFor(widthRatio) {
    return (BASE_WIDTH * widthRatio) / 100;
  }

  function powerToDistance(power) {
    const p = Math.min(1, Math.max(0, power));
    for (let i = 1; i < POWER_CURVE.length; i++) {
      const [p0, d0] = POWER_CURVE[i - 1];
      const [p1, d1] = POWER_CURVE[i];
      if (p <= p1) return d0 + ((p - p0) / (p1 - p0)) * (d1 - d0);
    }
    return POWER_CURVE[POWER_CURVE.length - 1][1];
  }

  function stoppingDistance(speed) {
    return speed / DRAG - (MU / (DRAG * DRAG)) * Math.log(1 + (DRAG * speed) / MU);
  }

  function speedForDistance(distance) {
    let low = 0;
    let high = 4000;
    for (let i = 0; i < 50; i++) {
      const mid = (low + high) / 2;
      if (stoppingDistance(mid) < distance) low = mid;
      else high = mid;
    }
    return (low + high) / 2;
  }

  function shotVelocity(power, angle) {
    const speed = speedForDistance(powerToDistance(power));
    const a = Math.min(MAX_ANGLE, Math.max(-MAX_ANGLE, angle));
    return { vx: speed * Math.sin(a), vy: -speed * Math.cos(a) };
  }

  const isMoving = (p) => p.vx !== 0 || p.vy !== 0;

  function surfaceFriction(p, mods) {
    if (!mods.patches) return 1;
    for (const s of mods.patches) {
      const dx = p.x - s.x;
      const dy = p.y - s.y;
      if (dx * dx + dy * dy < s.r * s.r) return SURFACE_FRICTION[s.type] || 1;
    }
    return 1;
  }

  function collideCircle(p, c, type, restitution, kick, events) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const reach = PUCK_R + c.r;
    const distSq = dx * dx + dy * dy;
    if (distSq >= reach * reach) return;

    const dist = Math.sqrt(distSq);
    const nx = dist > 0 ? dx / dist : 0;
    const ny = dist > 0 ? dy / dist : -1;
    p.x = c.x + nx * reach;
    p.y = c.y + ny * reach;

    const vn = p.vx * nx + p.vy * ny;
    if (vn >= 0) return;
    p.vx += -(1 + restitution) * vn * nx + kick * nx;
    p.vy += -(1 + restitution) * vn * ny + kick * ny;
    if (-vn > MIN_EVENT_SPEED && events) {
      events.push({ type, id: p.id, x: c.x + nx * c.r, y: c.y + ny * c.r, speed: -vn });
    }
  }

  function collidePucks(a, b, events) {
    if (!isMoving(a) && !isMoving(b)) return;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const reach = PUCK_R * 2;
    const distSq = dx * dx + dy * dy;
    if (distSq >= reach * reach) return;

    const dist = Math.sqrt(distSq);
    const nx = dist > 0 ? dx / dist : 0;
    const ny = dist > 0 ? dy / dist : -1;
    const overlap = (reach - dist) / 2;
    a.x -= nx * overlap;
    a.y -= ny * overlap;
    b.x += nx * overlap;
    b.y += ny * overlap;

    const closing = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
    if (closing <= 0) return;
    const impulse = ((1 + PUCK_BOUNCE) / 2) * closing;
    a.vx -= impulse * nx;
    a.vy -= impulse * ny;
    b.vx += impulse * nx;
    b.vy += impulse * ny;
    if (closing > MIN_EVENT_SPEED && events) {
      events.push({ type: 'puck', id: a.id, other: b.id, x: a.x + nx * PUCK_R, y: a.y + ny * PUCK_R, speed: closing });
    }
  }

  // Flytter verden ett tidssteg. Returnerer true så lenge noe er i bevegelse.
  function step(world, events) {
    const mods = world.mods || {};
    const baseFriction = mods.friction || 1;
    let moving = false;

    for (const p of world.pucks) {
      if (!isMoving(p)) continue;
      if (mods.wind) p.vx += mods.wind * DT;
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      const drop = (MU * baseFriction * surfaceFriction(p, mods) + DRAG * speed) * DT;
      if (drop >= speed) {
        p.vx = 0;
        p.vy = 0;
        continue;
      }
      const factor = (speed - drop) / speed;
      p.vx *= factor;
      p.vy *= factor;
      p.x += p.vx * DT;
      p.y += p.vy * DT;
      moving = true;
    }

    for (const p of world.pucks) {
      for (const o of world.obstacles || []) collideCircle(p, o, 'obstacle', OBSTACLE_BOUNCE, 0, events);
      for (const b of mods.bumpers || []) collideCircle(p, b, 'bumper', 1, BUMPER_KICK, events);
    }

    for (let i = 0; i < world.pucks.length; i++) {
      for (let j = i + 1; j < world.pucks.length; j++) {
        collidePucks(world.pucks[i], world.pucks[j], events);
      }
    }

    const halfWidth = world.width / 2;
    world.pucks = world.pucks.filter((p) => {
      const off = p.x < -halfWidth || p.x > halfWidth || p.y < 0 || p.y > LENGTH;
      if (off && events) events.push({ type: 'fall', id: p.id, owner: p.owner, x: p.x, y: p.y });
      return !off;
    });

    return moving;
  }

  function runToRest(world, events) {
    let steps = 0;
    while (step(world, events) && steps < MAX_STEPS) steps++;
    for (const p of world.pucks) {
      p.vx = 0;
      p.vy = 0;
    }
    return steps;
  }

  function cloneWorld(world) {
    return { ...world, pucks: world.pucks.map((p) => ({ ...p })) };
  }

  function zonePoints(y, mods) {
    const index = Math.floor(y / ZONE_H);
    if (index < 0 || index > 3) return 0;
    return mods && mods.reversed ? index + 1 : 4 - index;
  }

  function puckPoints(p, world) {
    const mods = world.mods || {};
    let points = zonePoints(p.y, mods);
    if (mods.gold) {
      const dx = p.x - mods.gold.x;
      const dy = p.y - mods.gold.y;
      if (dx * dx + dy * dy < mods.gold.r * mods.gold.r) points += mods.gold.points;
    }
    return points;
  }

  function scoreWorld(world) {
    const scores = {};
    for (const p of world.pucks) scores[p.owner] = (scores[p.owner] || 0) + puckPoints(p, world);
    return scores;
  }

  return {
    LENGTH,
    BASE_WIDTH,
    PUCK_R,
    START_Y,
    ZONE_H,
    DT,
    MIN_POWER,
    MAX_ANGLE,
    widthFor,
    powerToDistance,
    stoppingDistance,
    shotVelocity,
    step,
    runToRest,
    cloneWorld,
    zonePoints,
    puckPoints,
    scoreWorld,
  };
});
