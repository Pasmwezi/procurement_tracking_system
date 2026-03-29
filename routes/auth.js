const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const JWT_SECRET = process.env.JWT_SECRET || 'file-tracker-secret-key-change-in-production';

// POST /api/auth/login
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    try {
        const result = await pool.query(
            'SELECT id, email, password_hash, display_name, role, team_id, password_changed, is_active FROM users WHERE email = $1',
            [email.toLowerCase().trim()]
        );
        if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid email or password' });

        const user = result.rows[0];

        if (!user.is_active) return res.status(401).json({ error: 'Account is deactivated' });
        if (!user.password_hash) return res.status(401).json({ error: 'Password not set. Contact your administrator.' });

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

        const token = jwt.sign(
            { id: user.id, role: user.role, teamId: user.team_id },
            JWT_SECRET,
            { expiresIn: '8h' }
        );

        const refreshToken = jwt.sign(
            { id: user.id, isRefresh: true },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.cookie('refreshToken', refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
        });

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                displayName: user.display_name,
                role: user.role,
                teamId: user.team_id,
                passwordChanged: user.password_changed
            }
        });
    } catch (err) {
        console.error('Login error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) {
        return res.status(401).json({ error: 'No refresh token provided' });
    }

    try {
        const decoded = jwt.verify(refreshToken, JWT_SECRET);
        
        if (!decoded.isRefresh) {
            return res.status(401).json({ error: 'Invalid token type' });
        }

        const result = await pool.query(
            'SELECT id, email, display_name, role, team_id, password_changed, is_active FROM users WHERE id = $1',
            [decoded.id]
        );

        if (result.rows.length === 0 || !result.rows[0].is_active) {
            return res.status(401).json({ error: 'Account inactive or deleted' });
        }

        const user = result.rows[0];

        const token = jwt.sign(
            { id: user.id, role: user.role, teamId: user.team_id },
            JWT_SECRET,
            { expiresIn: '8h' }
        );

        // Optionally, rotate refresh token here as well
        const newRefreshToken = jwt.sign(
            { id: user.id, isRefresh: true },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.cookie('refreshToken', newRefreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        res.json({ token, user: {
            id: user.id,
            email: user.email,
            displayName: user.display_name,
            role: user.role,
            teamId: user.team_id,
            passwordChanged: user.password_changed
        }});
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Refresh token expired' });
        }
        return res.status(401).json({ error: 'Invalid refresh token' });
    }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
    res.clearCookie('refreshToken', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict'
    });
    res.json({ success: true });
});

// PUT /api/auth/password — change own password (any authenticated user)
router.put('/password', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Authentication required' });

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new passwords are required' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters' });
        }

        const userResult = await pool.query('SELECT password_hash FROM users WHERE id = $1', [decoded.id]);
        if (userResult.rows.length === 0) return res.status(401).json({ error: 'User not found' });

        const valid = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);
        if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

        const newHash = await bcrypt.hash(newPassword, 10);
        await pool.query(
            'UPDATE users SET password_hash = $1, password_changed = TRUE, updated_at = NOW() WHERE id = $2',
            [newHash, decoded.id]
        );

        res.json({ success: true });
    } catch (err) {
        if (err.name === 'JsonWebTokenError') return res.status(401).json({ error: 'Invalid token' });
        res.status(500).json({ error: err.message });
    }
});

// GET /api/auth/me — get current user info
router.get('/me', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Authentication required' });

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        const userRes = await pool.query(
            `SELECT u.id, u.email, u.display_name, u.role, u.team_id, u.password_changed,
                    t.name AS team_name
             FROM users u
             LEFT JOIN teams t ON t.id = u.team_id
             WHERE u.id = $1 AND u.is_active = TRUE`,
            [decoded.id]
        );
        if (userRes.rows.length === 0) return res.status(401).json({ error: 'User not found' });

        const user = userRes.rows[0];
        res.json({
            id: user.id,
            email: user.email,
            displayName: user.display_name,
            role: user.role,
            teamId: user.team_id,
            teamName: user.team_name,
            passwordChanged: user.password_changed
        });
    } catch (err) {
        if (err.name === 'JsonWebTokenError') return res.status(401).json({ error: 'Invalid token' });
        res.status(500).json({ error: err.message });
    }
});

// GET /api/auth/setup-status — public endpoint: tells login page if admin still uses default creds
router.get('/setup-status', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT password_changed FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1"
        );
        const changed = result.rows.length > 0 ? result.rows[0].password_changed : true;
        res.json({ admin_password_changed: !!changed });
    } catch (err) {
        res.json({ admin_password_changed: true }); // fail safe — hide hint on error
    }
});

module.exports = router;
