const { test } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { createStrictPool } = require('../utils/databasePool');

test('failed strict session initialization discards the connection before any pool or transaction work', async t => {
  const failure = new Error('session initialization rejected');
  let destroyed = 0;
  let initialized = 0;
  t.mock.method(mysql, 'createPool', () => ({
    getConnection: async () => ({
      query: async statement => {
        assert.match(statement, /^SET SESSION sql_mode/);
        initialized++;
        throw failure;
      },
      execute: () => assert.fail('Protected SQL must never run'),
      release: () => assert.fail('An uninitialized connection must not return to the pool'),
      destroy: () => { destroyed++; },
    }),
  }));
  const db = createStrictPool({});
  for (const operation of [() => db.query('SELECT 1'), () => db.execute('SELECT 1'), () => db.getConnection()]) {
    await assert.rejects(operation(), failure);
  }
  assert.equal(initialized, 3);
  assert.equal(destroyed, 3);
});
