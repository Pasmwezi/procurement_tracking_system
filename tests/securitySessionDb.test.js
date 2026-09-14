const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Pool } = require('pg');
test('password hash changes atomically revoke sessions; migration is repeatable', { skip: !process.env.SECURITY_TEST_DATABASE_URL }, async () => {
    const pool = new Pool({ connectionString: process.env.SECURITY_TEST_DATABASE_URL });
    try {
        await pool.query('CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, password_hash TEXT)');
        const path = require('node:path').join(__dirname, '../db/migrate-security-token-version.sql');
        if (fs.existsSync(path)) { await pool.query(fs.readFileSync(path, 'utf8')); await pool.query(fs.readFileSync(path, 'utf8')); }
        const row = (await pool.query("INSERT INTO users(password_hash) VALUES ('synthetic-old-hash') RETURNING *")).rows[0];
        await pool.query("UPDATE users SET password_hash = 'synthetic-new-hash' WHERE id=$1", [row.id]);
        const updated = (await pool.query('SELECT * FROM users WHERE id=$1', [row.id])).rows[0];
        assert.equal(updated.token_version, 1);
        await pool.query('UPDATE users SET password_hash = password_hash WHERE id=$1', [row.id]);
        assert.equal((await pool.query('SELECT token_version FROM users WHERE id=$1', [row.id])).rows[0].token_version, 1);
    } finally { await pool.end(); }
});
