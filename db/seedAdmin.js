// One-shot administrator bootstrap for operators who do not use server startup.
const bcrypt = require('bcryptjs');
const pool = require('./pool');

async function seedAdmin() {
    const email = process.env.ADMIN_INITIAL_EMAIL;
    const password = process.env.ADMIN_INITIAL_PASSWORD;
    if (!email || !password || password.length < 12) {
        throw new Error('ADMIN_INITIAL_EMAIL and ADMIN_INITIAL_PASSWORD (minimum 12 characters) are required');
    }

    const existing = await pool.query("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
    if (existing.rows.length > 0) {
        console.log('Administrator already exists; no changes made');
        return;
    }

    const hash = await bcrypt.hash(password, 10);
    await pool.query(
        "INSERT INTO users (email, password_hash, display_name, role) VALUES ($1, $2, $3, 'admin')",
        [email.toLowerCase().trim(), hash, 'App Administrator']
    );
    console.log('Initial administrator created');
}

seedAdmin()
    .catch(err => {
        console.error('Administrator bootstrap failed:', err.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
