const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

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
const vendorsRouter = require('./routes/vendors');
const bidsRouter = require('./routes/bids');
const purchaseOrdersRouter = require('./routes/purchaseOrders');
const reportsRouter = require('./routes/reports');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
const corsOptions = {
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    credentials: true // allow cookies
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 requests per windowMs
    message: { error: 'Too many requests from this IP, please try again after 15 minutes' }
});

// Public routes (no auth required)
app.use('/api/auth', authLimiter, authRouter);

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

// Priority-2 routes
app.use('/api/vendors', requireAuth, requireRole('team_leader', 'officer'), vendorsRouter);
app.use('/api/bids', requireAuth, requireRole('team_leader', 'officer'), bidsRouter);
app.use('/api/purchase-orders', requireAuth, requireRole('team_leader', 'officer'), purchaseOrdersRouter);

// Priority-3 routes
app.use('/api/reports', requireAuth, requireRole('team_leader', 'admin'), reportsRouter);

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
                contract_number VARCHAR(100),
                start_date DATE NOT NULL,
                end_date DATE NOT NULL,
                has_options BOOLEAN DEFAULT FALSE,
                number_of_options INTEGER,
                contractor_name VARCHAR(300),
                optional_period_months INTEGER DEFAULT 12,
                amended_end_date DATE,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`
            ALTER TABLE contracts 
            ADD COLUMN IF NOT EXISTS contract_number VARCHAR(100),
            ADD COLUMN IF NOT EXISTS has_options BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS number_of_options INTEGER,
            ADD COLUMN IF NOT EXISTS contractor_name VARCHAR(300);
        `);
        // Priority-1 schema additions
        await pool.query(`
            ALTER TABLE files
            ADD COLUMN IF NOT EXISTS estimated_value DECIMAL(15,2),
            ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
            ADD COLUMN IF NOT EXISTS notes TEXT;
        `);
        await pool.query(`
            ALTER TABLE triage_files
            ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
            ADD COLUMN IF NOT EXISTS notes TEXT;
        `);
        // Priority-2 schema additions
        await pool.query(`
            CREATE TABLE IF NOT EXISTS vendors (
                id SERIAL PRIMARY KEY,
                name VARCHAR(300) NOT NULL UNIQUE,
                registration_number VARCHAR(100),
                contact_email VARCHAR(200),
                contact_phone VARCHAR(50),
                address TEXT,
                category VARCHAR(100),
                status VARCHAR(20) DEFAULT 'Active' CHECK (status IN ('Active','Blacklisted','Inactive')),
                notes TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bids (
                id SERIAL PRIMARY KEY,
                file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
                vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
                vendor_name_free TEXT,
                submission_date DATE,
                bid_amount DECIMAL(15,2),
                technical_score DECIMAL(5,2),
                financial_score DECIMAL(5,2),
                disqualified BOOLEAN DEFAULT FALSE,
                disqualification_reason TEXT,
                is_winner BOOLEAN DEFAULT FALSE,
                notes TEXT,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS purchase_orders (
                id SERIAL PRIMARY KEY,
                contract_id INTEGER REFERENCES contracts(id) ON DELETE CASCADE,
                po_number VARCHAR(100) NOT NULL UNIQUE,
                po_date DATE NOT NULL,
                amount DECIMAL(15,2) NOT NULL,
                description TEXT,
                status VARCHAR(30) DEFAULT 'Open' CHECK (status IN ('Open','Received','Closed','Cancelled')),
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS goods_receipts (
                id SERIAL PRIMARY KEY,
                po_id INTEGER REFERENCES purchase_orders(id) ON DELETE CASCADE,
                receipt_date DATE NOT NULL,
                received_quantity DECIMAL(10,2),
                received_by_name VARCHAR(200),
                notes TEXT,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS invoices (
                id SERIAL PRIMARY KEY,
                contract_id INTEGER REFERENCES contracts(id) ON DELETE CASCADE,
                po_id INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
                invoice_number VARCHAR(100) NOT NULL,
                invoice_date DATE NOT NULL,
                amount DECIMAL(15,2) NOT NULL,
                status VARCHAR(30) DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected','Paid')),
                due_date DATE,
                paid_date DATE,
                notes TEXT,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        // Priority-3 migrations
        await pool.query(`
            ALTER TABLE notifications ALTER COLUMN step_id DROP NOT NULL;
        `);
        // Priority-4 migrations
        await pool.query(`
            CREATE TABLE IF NOT EXISTS audit_log (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                action VARCHAR(100) NOT NULL,
                entity_type VARCHAR(50),
                entity_id INTEGER,
                old_value JSONB,
                new_value JSONB,
                ip_address VARCHAR(45),
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
