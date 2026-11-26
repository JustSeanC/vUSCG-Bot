const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { Collection, ChannelType } = require('discord.js');
const { Response } = require('node-fetch');
const { createPirepBridge } = require('../utils/pirepBridge');
const { handlePirepButton, tickWatcher } = require('../utils/pendingPireps');

const id = 'AbC-123';
const reviewer = { discord_id: '123456789012345678', pilot_number: 'C121' };
const secret = 'a'.repeat(64);

function reply(status, code, state) {
  return new Response(JSON.stringify({ code, state, pirep_id: id }), { status });
}

function client(fetchImpl, options = {}) {
  return createPirepBridge({ baseUrl: 'https://example.test', secret, fetchImpl, ...options });
}

for (const [action, state] of [['approve', 2], ['reject', 6]]) {
  test(`bridge signs ${action} with the string ID and audit identity`, async () => {
    const bridge = client(async (url, options) => {
      const path = new URL(url).pathname;
      const headers = options.headers;
      assert.equal(path, '/api/vuscgcustom/pirep-review/decision');
      assert.equal(options.redirect, 'error');
      assert.deepEqual(JSON.parse(options.body), { pirep_id: id, action, reviewer });
      const canonical = [
        options.method, path, headers['X-VUSCG-Timestamp'], headers['X-VUSCG-Nonce'], options.body,
      ].join('\n');
      assert.equal(headers['X-VUSCG-Signature'], createHmac('sha256', secret).update(canonical).digest('hex'));
      return reply(200, 'changed', state);
    });
    assert.deepEqual(await bridge.decide(id, action, reviewer), { code: 'changed', state, pirep_id: id });
  });
}

test('a conflicting click reports the actual resolved state', async () => {
  const bridge = client(async () => reply(409, 'not_pending', 6));
  assert.equal((await bridge.decide(id, 'approve', reviewer)).state, 6);
});

test('a timeout reconciles using a new nonce and never resends the decision', async () => {
  const calls = [];
  const bridge = client(async (url, options) => {
    calls.push({ url, nonce: options.headers['X-VUSCG-Nonce'] });
    if (calls.length === 1) {
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
    return reply(200, 'status', 6);
  }, { timeout: 10 });
  const keepAlive = setTimeout(() => {}, 500);
  try {
    assert.deepEqual(await bridge.decide(id, 'approve', reviewer), { code: 'reconciled', state: 6 });
  } finally {
    clearTimeout(keepAlive);
  }
  assert.deepEqual(calls.map(call => call.url.split('/').pop()), ['decision', 'status']);
  assert.notEqual(calls[0].nonce, calls[1].nonce);
});

test('downtime and invalid success responses remain uncertain', async () => {
  for (const fail of [async () => { throw new Error('offline'); }, async () => reply(200, 'changed', 6)]) {
    assert.deepEqual(await client(fail).decide(id, 'approve', reviewer), { code: 'uncertain' });
  }
});

test('authentication and missing reports are surfaced without retry', async () => {
  for (const [status, code, expected] of [[401, 'unauthorized', 'unauthorized'], [404, 'not_found', 'not_found']]) {
    let calls = 0;
    const bridge = client(async () => { calls++; return reply(status, code, null); });
    assert.deepEqual(await bridge.decide(id, 'approve', reviewer), { code: expected });
    assert.equal(calls, 1);
  }
});

test('invalid IDs and insecure configuration never start a request', async () => {
  let calls = 0;
  const bridge = client(async () => { calls++; }, { baseUrl: 'http://example.test' });
  assert.deepEqual(await bridge.decide('invalid/id', 'approve', reviewer), { code: 'invalid' });
  assert.deepEqual(await bridge.decide(id, 'approve', reviewer), { code: 'unconfigured' });
  assert.equal(calls, 0);
});

function interactionContext(allowed, result) {
  const calls = [];
  return {
    calls,
    roles: { INSTRUCTOR_PILOT_ROLE_ID: 'training' },
    hasRole: role => allowed && role === 'training',
    db: {
      async query(sql, params) {
        assert.match(sql, /^SELECT pilot_id FROM discord_links/);
        assert.deepEqual(params, [reviewer.discord_id]);
        return [[{ pilot_id: 121 }]];
      },
    },
    bridge: {
      async decide(pirepId, action, actor) {
        assert.deepEqual([pirepId, action, actor], [id, 'approve', reviewer]);
        calls.push(['decision']);
        return result;
      },
    },
    interaction: {
      customId: `pirep:approve:${id}`,
      user: { id: reviewer.discord_id, tag: 'Instructor' },
      message: { embeds: [] },
      reply: async message => calls.push(['reply', message]),
      deferUpdate: async () => calls.push(['defer']),
      editReply: async message => calls.push(['edit', message]),
      followUp: async message => calls.push(['followUp', message]),
    },
  };
}

test('Discord permission is checked before requesting a decision', async () => {
  const context = interactionContext(false, {});
  await handlePirepButton(context);
  assert.deepEqual(context.calls.map(([call]) => call), ['reply']);
  assert.match(context.calls[0][1].content, /permission/);
});

test('confirmed denial removes Discord buttons even if the reviewer clicked approve', async () => {
  const context = interactionContext(true, { code: 'not_pending', state: 6 });
  await handlePirepButton(context);
  assert.deepEqual(context.calls.map(([call]) => call), ['defer', 'decision', 'edit']);
  const message = context.calls[2][1];
  assert.match(message.embeds[0].data.title, /Rejected/);
  assert.deepEqual(message.components[0].toJSON().components.map(button => button.label), ['View']);
  assert.doesNotMatch(message.embeds[0].data.footer.text, /Reviewed by/);
});

test('unconfirmed decisions leave buttons in place and point to phpVMS', async () => {
  const context = interactionContext(true, { code: 'reconciled', state: 1 });
  await handlePirepButton(context);
  assert.deepEqual(context.calls.map(([call]) => call), ['defer', 'decision', 'followUp']);
  assert.match(context.calls[2][1].content, /native phpVMS admin/);
});

test('pending watcher still posts Approve, Deny, and View in the trainee thread', async t => {
  const fs = require('node:fs');
  let cache;
  let message;
  t.mock.method(fs, 'readFileSync', () => '{}');
  t.mock.method(fs, 'writeFileSync', (path, contents) => { cache = JSON.parse(contents); });
  t.mock.method(fs, 'renameSync', () => {});
  const thread = {
    id: 'thread', parentId: 'training', type: ChannelType.PrivateThread,
    members: { fetch: async () => true },
    name: 'Training Case for C121',
    send: async payload => { message = payload; return { id: 'message', channelId: 'thread' }; },
  };
  const guild = {
    channels: { fetch: async () => ({
      id: 'training',
      threads: {
        fetchActive: async () => ({ threads: new Collection([[thread.id, thread]]) }),
        fetchArchived: async () => ({ threads: new Collection(), hasMore: false }),
      },
    }) },
  };
  await tickWatcher({
    client: { guilds: { fetch: async () => guild } },
    db: { query: async (sql, params) => {
      assert.match(sql, /WHERE p\.state =/);
      assert.deepEqual(params, [1]);
      return [[{ pirep_id: id, pilot_id: 121, discord_id: reviewer.discord_id, dpt_airport_id: 'KAST', arr_airport_id: 'KACV' }]];
    } },
    guildId: 'guild',
    trainingChannelId: 'training',
    pirepBaseUrl: 'https://example.test/pireps',
  });
  assert.deepEqual(message.components[0].toJSON().components.map(button => button.label), ['Approve', 'Deny', 'View']);
  assert.deepEqual(cache, { [id]: { channelId: 'thread', messageId: 'message' } });
});

test('optional training action follows a persisted acceptance without replaying flight credit', async () => {
  let flightMinutes = 300;
  let state = 1;
  const bridge = client(async () => {
    // Model the bridge contract. Native Laravel accounting is exercised on the staging installation.
    if (state === 2) return reply(409, 'not_pending', state);
    state = 2;
    flightMinutes += 45;
    return reply(200, 'changed', state);
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const context = interactionContext(true, {});
    context.bridge = bridge;
    context.db.execute = async (sql, params) => {
      assert.match(sql, /^SELECT p.id/);
      assert.deepEqual(params, [id]);
      return [[{ id, state, deleted_at: null }]];
    };
    await handlePirepButton(context);
    const [, payload] = context.calls.at(-1);
    assert.deepEqual(payload.components[0].toJSON().components.map(button => button.label), ['Record Training', 'View']);
    assert.match(payload.embeds[0].data.title, /Approved/);
  }
  // Neither approval, displaying the button, nor the second approval creates a signoff or adds more credit.
  assert.equal(flightMinutes, 345);
});

test('accepted bridge response with a deleted report keeps the signoff action unavailable', async () => {
  const context = interactionContext(true, { code: 'not_pending', state: 2 });
  context.db.execute = async () => [[{ id, state: 2, deleted_at: '2025-01-01' }]];
  await handlePirepButton(context);
  const [, payload] = context.calls.at(-1);
  assert.deepEqual(payload.components[0].toJSON().components.map(button => button.label), ['View']);
  assert.match(payload.embeds[0].data.title, /Deleted/);
});

test('watcher restart retries incomplete external resolution without creating new messages', async t => {
  const fs = require('node:fs');
  const ids = [id, 'Rest-654'];
  let persisted = JSON.stringify(Object.fromEntries(ids.map(report => [report, { channelId: 'thread', messageId: report }])));
  t.mock.method(fs, 'readFileSync', () => persisted);
  t.mock.method(fs, 'writeFileSync', (_, contents) => { persisted = contents; });
  t.mock.method(fs, 'renameSync', () => {});
  t.mock.method(console, 'warn', () => {});
  const edits = [];
  let firstFailure = true;
  const channel = { messages: { fetch: async report => ({ edit: async payload => {
    if (report === id && firstFailure) {
      firstFailure = false;
      throw new Error('Discord timeout');
    }
    edits.push([report, payload.components[0].toJSON().components.map(button => button.label)]);
  } }) } };
  const options = {
    client: { channels: { fetch: async () => channel }, guilds: { fetch: async () => null } },
    db: { execute: async (_, [report]) => [[{ id: report, state: report === id ? 2 : 6, deleted_at: null }]],
      query: async () => [[]] },
    guildId: 'staging',
  };
  await tickWatcher(options);
  assert.deepEqual(Object.keys(JSON.parse(persisted)), [id]);
  await tickWatcher(options);
  await tickWatcher(options);
  assert.deepEqual(edits, [['Rest-654', ['View']], [id, ['Record Training', 'View']]]);
  assert.deepEqual(JSON.parse(persisted), {});
});
