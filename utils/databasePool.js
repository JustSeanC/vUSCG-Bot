const mysql = require('mysql2/promise');

const strictSession = `SET SESSION sql_mode = CONCAT_WS(',',
  NULLIF(@@SESSION.sql_mode, ''), 'STRICT_TRANS_TABLES', 'NO_ENGINE_SUBSTITUTION')`;

function createStrictPool(options) {
  const pool = mysql.createPool(options);

  async function getConnection() {
    const connection = await pool.getConnection();
    try {
      await connection.query(strictSession);
      return connection;
    } catch (error) {
      // Never return a session whose initialization failed to the pool.
      connection.destroy();
      throw error;
    }
  }

  async function run(method, args) {
    const connection = await getConnection();
    try {
      return await connection[method](...args);
    } finally {
      connection.release();
    }
  }

  return {
    getConnection,
    query: (...args) => run('query', args),
    execute: (...args) => run('execute', args),
    end: () => pool.end(),
  };
}

module.exports = { createStrictPool };
