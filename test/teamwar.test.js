import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
const sent = [];
globalThis.fetch = async (url, init) => { sent.push([String(url).split('/').pop(), JSON.parse(init.body)]); return Response.json({ ok: true, result: {} }) };
const { default: worker } = await import('../src/index.js');
const TW = await import('../src/teamwar.js');
const { teamScore, teamClash } = await import('../src/teams.js');
const { ceiling } = await import('../src/wager.js');

function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  const env = { DB, sql, SESSION_SECRET: 'test-secret', BOT_TOKEN: '123:BOT', GAME_LINK: 'https://t.me/CryptoWormWarsBot/play' };
  env.LOBBY = { idFromName: x => x, get: () => ({ fetch: async () => Response.json({ online: [] }) }) };
  return env;
}
const call = async (env, path, body, p) => {
  const r = await worker.fetch(new Request('https://api.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(p ? { authorization: 'Bearer ' + p.token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, {});
  return { status: r.status, ...(await r.json()) };
};
let tgn = 100;
// a player with `n` matches, `cworm` ranked play money and Telegram (for the bot's messages)
async function player(env, name, { n = 3, cworm = 5000 } = {}) {
  const g = await call(env, '/auth/guest', {});
  env.sql.prepare('UPDATE players SET name = ?, tg_id = ? WHERE id = ?').run(name, ++tgn, g.player.id);
  env.sql.prepare('INSERT INTO player_meta (player, played) VALUES (?, ?) ON CONFLICT(player) DO UPDATE SET played = excluded.played').run(g.player.id, n);
  env.sql.prepare('INSERT INTO cworm_scores (player, total) VALUES (?, ?)').run(g.player.id, cworm);
  return { id: g.player.id, token: g.token, tg: tgn, name };
}
const team = (env, name, tag, lead, ...members) => {
  const id = env.sql.prepare("INSERT INTO teams (name, tag, emoji, owner, code, created) VALUES (?, ?, '🐸', ?, ?, 0) RETURNING id").get(name, tag, lead.id, tag + 'CODE').id;
  env.sql.prepare("INSERT INTO team_members (player, team, role, joined) VALUES (?, ?, 'lead', 0)").run(lead.id, id);
  for (const m of members) env.sql.prepare("INSERT INTO team_members (player, team, role, joined) VALUES (?, ?, 'member', 1)").run(m.id, id);
  return id;
};
const dms = chat => sent.filter(([m, b]) => m === 'sendMessage' && b.chat_id === chat).map(([, b]) => b.text);
const rewards = (env, reason) => env.sql.prepare('SELECT player, amount, note FROM rewards WHERE reason = ? ORDER BY player').all(reason).map(r => ({ ...r }));

async function setup() {
  const env = makeEnv(), a1 = await player(env, 'Ann'), a2 = await player(env, 'Abe'), b1 = await player(env, 'Bob'), b2 = await player(env, 'Bea', { cworm: 300 });
  const o = await player(env, 'Out'), s = await player(env, 'SimBot');
  env.sql.prepare('INSERT INTO sim_players (player, created) VALUES (?, 0)').run(s.id);
  const A = team(env, 'Frog Army', 'FROG', a1, a2), B = team(env, 'Bull Gang', 'BULL', b1, b2), C = team(env, 'Bot Squad', 'BOT', s);
  return { env, a1, a2, b1, b2, o, s, A, B, C };
}

test('team war: a member challenges, both sides chip in, 24 hours of points decide it, the winners share the pot less 5% burned', async () => {
  const { env, a1, a2, b1, b2, o, A, B, C } = await setup();
  const realNow = Date.now; let now = Date.UTC(2026, 10, 10, 12); Date.now = () => now;
  try {
    // checks before it starts
    assert.equal((await call(env, '/teams/war/new', { team: B, stake: 400 }, a2)).status, 400);           // pot too small
    assert.equal((await call(env, '/teams/war/new', { team: C, stake: 1000 }, a2)).status, 403);          // a team with load-test bots
    assert.equal((await call(env, '/teams/war/new', { team: B, stake: 1000 }, o)).status, 400);           // no team
    assert.equal((await call(env, '/teams/' + B, undefined, a2)).warOk, true);                            // the rival's page offers the challenge
    assert.equal((await call(env, '/teams/' + C, undefined, a2)).warOk, false);
    sent.length = 0;
    const made = await call(env, '/teams/war/new', { team: B, stake: 1000 }, a2);
    assert.equal(made.status, 200); assert.equal(made.war.state, 'filling'); assert.equal(made.war.pot, 2000); assert.equal(made.war.b.name, 'Bull Gang');
    assert.match(dms(b1.tg)[0], /Frog Army \[FROG\] challenged your team 🐸 Bull Gang \[BULL\] to a team war: 1,000 BP a side[^]*Play money in the game, not real tokens/);
    assert.equal((await call(env, '/teams/war/new', { team: B, stake: 1000 }, a1)).status, 409);          // one war at a time
    assert.equal((await call(env, '/teams/' + C, undefined, a1)).warOk, false);
    const id = made.war.id;
    // chip-ins: members only, within what's left of their side and what they have
    assert.equal((await call(env, '/teams/war/pledge', { id, amount: 100 }, o)).status, 403);
    assert.equal((await call(env, '/teams/war/pledge', { id, amount: 1200 }, a1)).status, 400);
    assert.equal((await call(env, '/teams/war/pledge', { id, amount: 20 }, a1)).status, 400);
    let r = await call(env, '/teams/war/pledge', { id, amount: 600 }, a1);
    assert.equal(r.war.a.pledged, 600); assert.equal(r.war.mine, 600); assert.deepEqual(r.owe.map(x => x.n), [600]);
    assert.equal(await ceiling(env, a1.id), 4400);                                                         // it left what the server counts as theirs
    await call(env, '/teams/war/paid', { ids: r.owe.map(x => x.id) }, a1);
    assert.deepEqual((await call(env, '/teams/war', undefined, a1)).owe, []);
    r = await call(env, '/teams/war/pledge', { id, amount: 400 }, a2); assert.equal(r.war.a.pledged, 1000);
    assert.equal((await call(env, '/teams/war/pledge', { id, amount: 100 }, a1)).status, 409);            // their side is full
    assert.equal((await call(env, '/teams/war/pledge', { id, amount: 500 }, b2)).status, 400);            // more than Bea has
    await call(env, '/teams/war/pledge', { id, amount: 300 }, b2);
    sent.length = 0; now += 3600e3;
    r = await call(env, '/teams/war/pledge', { id, amount: 700 }, b1);
    assert.equal(r.war.state, 'live'); assert.equal(r.war.ends, now + TW.WAR_MS);
    assert.match(dms(a1.tg)[0], /Team war on! 🐸 Frog Army \[FROG\] vs 🐸 Bull Gang \[BULL\], 2,000 BP/); assert.equal(dms(b1.tg).length, 1);
    assert.equal((await call(env, '/teams/war/cancel', { id }, b1)).status, 409);                         // too late to call it off
    // war points: reports count up to the day's checked matches + 150, wins over other teams +100
    now += 3600e3;
    await teamScore(env, a1.id, 500, now);               // no checked match: 150
    let w = (await call(env, '/teams/' + A, undefined, a1)).war; assert.equal(w.a.score, 150);
    await TW.warRun(env, a1.id, 300, now);               // a checked match: up to 450
    await teamScore(env, b1.id, 200, now); await TW.warRun(env, b1.id, 400, now);
    await teamClash(env, b2.id, a1.id, now);             // Bea beats Ann online: +100 for Bull Gang
    await teamScore(env, o.id, 600, now);                // not in either team: nothing
    w = (await call(env, '/teams', undefined, b1)).war; assert.equal(w.state, 'live'); assert.equal(w.a.score, 450); assert.equal(w.b.score, 300);
    assert.equal(await TW.sweep(env, now), 0);
    // over: Frog Army wins 2,000 less 100 burned, shared 600:400 between Ann and Abe
    now = w.ends; sent.length = 0;
    await teamScore(env, b1.id, 600, now);                                                                 // too late, the war is over
    assert.equal(await TW.sweep(env, now), 1);
    const row = env.sql.prepare('SELECT * FROM team_wars WHERE id = ?').get(id);
    assert.equal(row.state, 'done'); assert.equal(row.winner, A); assert.equal(row.burned, 100); assert.equal(row.sa, 450); assert.equal(row.sb, 300);
    assert.deepEqual(rewards(env, 'teamwar'), [{ player: a1.id, amount: 1140, note: 'Frog Army' }, { player: a2.id, amount: 760, note: 'Frog Army' }].sort((x, y) => x.player - y.player));
    assert.match(dms(a1.tg)[0], /won the team war[^]*450 to 300[^]*1,900 BP go to the members who chipped in \(100 burned\)/);
    assert.match(dms(b1.tg)[0], /lost the team war/);
    const last = await call(env, '/teams/war', undefined, a2); assert.equal(last.war, null); assert.equal(last.last.winner, A); assert.equal(last.last.why, 'won');
    assert.equal(await ceiling(env, a1.id), 4400 + 1140);
    assert.equal(await TW.sweep(env, now + 60e3), 0);
  } finally { Date.now = realNow }
});

test('team war: a side that doesn\'t fill in 24 hours, a war called off and an even one give every pledge back', async () => {
  const { env, a1, a2, b1, b2, A, B } = await setup();
  const realNow = Date.now; let now = Date.UTC(2026, 10, 10, 12); Date.now = () => now;
  try {
    let w = (await call(env, '/teams/war/new', { team: B, stake: 500 }, a1)).war;
    await call(env, '/teams/war/pledge', { id: w.id, amount: 500 }, a2); await call(env, '/teams/war/pledge', { id: w.id, amount: 200 }, b2);
    now += TW.FILL_MS; sent.length = 0;
    assert.equal(await TW.sweep(env, now), 1);
    assert.deepEqual(rewards(env, 'teamwarback').map(r => [r.player, r.amount]), [[a2.id, 500], [b2.id, 200]].sort((x, y) => x[0] - y[0]));
    assert.match(dms(b1.tg)[0], /didn't fill in 24 hours/);
    assert.equal(env.sql.prepare('SELECT why FROM team_wars WHERE id = ?').get(w.id).why, 'expired');
    // called off: only a leader of either team, or whoever made it
    w = (await call(env, '/teams/war/new', { team: A, stake: 500 }, b2)).war;
    await call(env, '/teams/war/pledge', { id: w.id, amount: 100 }, a2);
    assert.equal((await call(env, '/teams/war/cancel', { id: w.id }, a2)).status, 403);
    { const r = await call(env, '/teams/war/cancel', { id: w.id }, a1); assert.equal(r.war.state, 'off'); assert.equal(r.war.why, 'cancelled') }
    assert.equal(rewards(env, 'teamwarback').filter(r => r.player === a2.id).reduce((s, r) => s + r.amount, 0), 600);
    // even: everyone gets their pledge back
    w = (await call(env, '/teams/war/new', { team: B, stake: 500 }, a1)).war;
    await call(env, '/teams/war/pledge', { id: w.id, amount: 500 }, a1); await call(env, '/teams/war/pledge', { id: w.id, amount: 500 }, b1);
    assert.equal((await call(env, '/teams/war/pledge', { id: w.id, amount: 100 }, b2)).status, 409);
    now += TW.WAR_MS;
    assert.equal(await TW.sweep(env, now), 1);
    const row = env.sql.prepare('SELECT * FROM team_wars WHERE id = ?').get(w.id); assert.equal(row.state, 'done'); assert.equal(row.why, 'even'); assert.equal(row.winner, null);
    assert.ok(rewards(env, 'teamwarback').some(r => r.player === a1.id && r.amount === 500) && rewards(env, 'teamwarback').some(r => r.player === b1.id && r.amount === 500));
    assert.deepEqual(rewards(env, 'teamwar'), []);
    // at most 3 wars a day per challenging team
    for (let i = 0; i < 3; i++) { const x = (await call(env, '/teams/war/new', { team: B, stake: 500 }, a1)).war; await call(env, '/teams/war/cancel', { id: x.id }, a1) }
    assert.equal((await call(env, '/teams/war/new', { team: B, stake: 500 }, a1)).status, 429);
  } finally { Date.now = realNow }
});
