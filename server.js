const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');

const pool = require('./db/pool');
const { requireAuth, requireRole } = require('./middleware/auth');
const authRouter = require('./routes/auth');
const adminRouter = require('./routes/admin');
const officersRouter = require('./routes/officers');
const filesRouter = require('./routes/files');
const processesRouter = require('./routes/processes');
const notificationsRouter = require('./routes/notifications');
const triageRouter = require('./routes/triage');
const { checkSLAs } = require('./services/slaChecker');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Public routes (no auth required)
app.use('/api/auth', authRouter);

// Health check (public)
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Admin-only routes
app.use('/api/admin', requireAuth, requireRole('admin'), adminRouter);

// Protected API routes (team_leader + officer)
app.use('/api/officers', requireAuth, requireRole('team_leader', 'officer'), officersRouter);
app.use('/api/files', requireAuth, requireRole('team_leader', 'officer'), filesRouter);
app.use('/api/processes', requireAuth, processesRouter);
app.use('/api/notifications', requireAuth, requireRole('team_leader', 'officer'), notificationsRouter);
app.use('/api/triage', requireAuth, requireRole('team_leader'), triageRouter);

// Manual SLA check trigger (team_leader only)
app.post('/api/sla-check', requireAuth, requireRole('team_leader'), async (req, res) => {
    try {
        await checkSLAs();
        res.json({ success: true, message: 'SLA check completed' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// SPA fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// SLA checker cron — every hour
cron.schedule('0 * * * *', async () => {
    console.log('[CRON] Running SLA check at', new Date().toISOString());
    try {
        await checkSLAs();
    } catch (err) {
        console.error('[CRON] SLA check error:', err.message);
    }
});

// Start server with retry logic for DB connection
async function start() {
    let retries = 10;
    while (retries > 0) {
        try {
            await pool.query('SELECT 1');
            console.log('✅ Database connected');
            break;
        } catch (err) {
            retries--;
            console.log(`⏳ Waiting for database... (${retries} retries left)`);
            await new Promise(r => setTimeout(r, 3000));
        }
    }

    if (retries === 0) {
        console.error('❌ Could not connect to database');
        process.exit(1);
    }

    // Run migrations for existing databases
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS app_settings (
                key VARCHAR(100) PRIMARY KEY,
                value TEXT,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // Triage tables
        await pool.query(`
            CREATE TABLE IF NOT EXISTS triage_files (
                id SERIAL PRIMARY KEY,
                pr_number VARCHAR(100) NOT NULL UNIQUE,
                title VARCHAR(500) NOT NULL,
                team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
                estimated_value DECIMAL(15,2),
                business_owner VARCHAR(300) NOT NULL,
                status VARCHAR(50) NOT NULL DEFAULT 'Triaged'
                    CHECK (status IN ('Triaged', 'Missing Document(s)', 'Assigned', 'Awarded', 'Cancelled')),
                file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                doc_deadline TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS triage_missing_docs (
                id SERIAL PRIMARY KEY,
                triage_file_id INTEGER NOT NULL REFERENCES triage_files(id) ON DELETE CASCADE,
                document_name VARCHAR(300) NOT NULL,
                provided BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS triage_status_history (
                id SERIAL PRIMARY KEY,
                triage_file_id INTEGER NOT NULL REFERENCES triage_files(id) ON DELETE CASCADE,
                from_status VARCHAR(50),
                to_status VARCHAR(50) NOT NULL,
                changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                note TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS contracts (
                id SERIAL PRIMARY KEY,
                file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                start_date DATE NOT NULL,
                end_date DATE NOT NULL,
                optional_period_months INTEGER DEFAULT 12,
                amended_end_date DATE,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log('✅ Migrations applied');
    } catch (err) {
        console.error('⚠️ Migration warning:', err.message);
    }

    // Seed default App Admin account
    try {
        const bcrypt = require('bcryptjs');
        const existing = await pool.query(
            "SELECT id, password_hash FROM users WHERE email = $1 AND role = 'admin'",
            ['admin@filetracker.local']
        );
        if (existing.rows.length === 0) {
            const hash = await bcrypt.hash('admin123', 10);
            await pool.query(
                "INSERT INTO users (email, password_hash, display_name, role) VALUES ($1, $2, $3, 'admin')",
                ['admin@filetracker.local', hash, 'App Administrator']
            );
            console.log('✅ Default admin created (admin@filetracker.local / admin123)');
        } else {
            // Verify hash is valid bcrypt, re-hash if not
            const row = existing.rows[0];
            const isValid = row.password_hash && row.password_hash.startsWith('$2');
            if (!isValid) {
                const hash = await bcrypt.hash('admin123', 10);
                await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, row.id]);
                console.log('✅ Admin password hash refreshed');
            } else {
                console.log('✅ Admin account ready');
            }
        }
    } catch (err) {
        console.error('⚠️ Admin seed warning:', err.message);
    }

    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
}

start();
