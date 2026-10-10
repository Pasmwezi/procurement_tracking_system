const express = require('express');
const { body, param } = require('express-validator');
const pool = require('../db/pool');
const { validateRequest } = require('../middleware/validate');
const { logAction } = require('../services/auditLogger');
const {
    OFFICER_CLASSIFICATIONS,
    TRIAGE_LEVELS,
    REVIEW_GATES,
    REVIEW_STATUSES,
    CHECKPOINT_TYPES,
    recommendOfficerClassification,
    validateReviewTransition,
    sanitizePerformanceCheckpoint
} = require('../services/teamLeadership');

const router = express.Router();
const isLeader = user => ['admin', 'team_leader'].includes(user.role);

function requireLeader(req, res, next) {
    if (!isLeader(req.user)) return res.status(403).json({ error: 'Team leader access required' });
    next();
}

async function officerInScope(db, user, officerId, { forUpdate = false } = {}) {
    const params = [officerId];
    let scope = '';
    if (user.role !== 'admin') {
        params.push(user.teamId);
        scope = ' AND team_id = $2';
    }
    return db.query(
        `SELECT id, team_id, officer_classification FROM users
         WHERE id = $1 AND role = 'officer' AND is_active = TRUE${scope}${forUpdate ? ' FOR UPDATE' : ''}`,
        params
    );
}

router.get('/metadata', (_req, res) => res.json({
    officer_classifications: OFFICER_CLASSIFICATIONS,
    triage_levels: TRIAGE_LEVELS,
    review_gates: REVIEW_GATES,
    review_statuses: REVIEW_STATUSES,
    checkpoint_types: CHECKPOINT_TYPES
}));

router.put('/officers/:id/classification', requireLeader, [
    param('id').isInt({ min: 1 }),
    body('classification').isIn(OFFICER_CLASSIFICATIONS),
    validateRequest
], async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const officer = await officerInScope(client, req.user, Number(req.params.id), { forUpdate: true });
        if (!officer.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Active officer not found in scope' });
        }
        const result = await client.query(
            'UPDATE users SET officer_classification = $1, updated_at = NOW() WHERE id = $2 RETURNING id, display_name, team_id, officer_classification',
            [req.body.classification, req.params.id]
        );
        await logAction({
            userId: req.user.id, action: 'officer.classification_update', entityType: 'user',
            entityId: Number(req.params.id), oldValue: { officer_classification: officer.rows[0].officer_classification },
            newValue: { officer_classification: req.body.classification }, ipAddress: req.ip,
            db: client, required: true
        });
        await client.query('COMMIT');
        res.json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

router.put('/triage/:id/classification', requireLeader, [
    param('id').isInt({ min: 1 }),
    body('value_classification').isIn(TRIAGE_LEVELS),
    body('complexity').isIn(TRIAGE_LEVELS),
    validateRequest
], async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const recommendation = recommendOfficerClassification(req.body.value_classification, req.body.complexity);
        const params = [req.params.id];
        let scope = '';
        if (req.user.role !== 'admin') {
            params.push(req.user.teamId);
            scope = ' AND team_id = $2';
        }
        const existing = await client.query(
            `SELECT id, value_classification, complexity, recommended_classification
             FROM triage_files WHERE id = $1${scope} FOR UPDATE`, params
        );
        if (!existing.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Triage file not found in scope' });
        }
        const result = await client.query(
            `UPDATE triage_files SET value_classification = $1, complexity = $2,
             recommended_classification = $3, updated_at = NOW() WHERE id = $4
             RETURNING id, value_classification, complexity, recommended_classification`,
            [req.body.value_classification, req.body.complexity, recommendation, req.params.id]
        );
        await logAction({
            userId: req.user.id, action: 'triage.classification_update', entityType: 'triage_file',
            entityId: Number(req.params.id), oldValue: existing.rows[0], newValue: result.rows[0],
            ipAddress: req.ip, db: client, required: true
        });
        await client.query('COMMIT');
        res.json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

router.get('/reviews', async (req, res) => {
    try {
        const params = [];
        const conditions = [];
        if (req.user.role === 'officer') {
            params.push(req.user.id, req.user.teamId);
            conditions.push(`f.officer_id = $${params.length - 1}`);
            conditions.push(`u.team_id = $${params.length}`);
        } else if (req.user.role !== 'admin') {
            params.push(req.user.teamId);
            conditions.push(`u.team_id = $${params.length}`);
        }
        if (req.query.status) {
            params.push(req.query.status);
            conditions.push(`r.status = $${params.length}`);
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const result = await pool.query(
            `SELECT r.*, f.pr_number, f.title, f.status AS file_status,
                    u.display_name AS officer_name, u.team_id
             FROM pg5_reviews r JOIN files f ON f.id = r.file_id
             JOIN users u ON u.id = f.officer_id ${where}
             ORDER BY r.updated_at DESC, r.id DESC`, params
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/reviews', [
    body('file_id').isInt({ min: 1 }),
    body('gate').isIn(REVIEW_GATES),
    body('submission_note').optional({ nullable: true }).isString(),
    validateRequest
], async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const params = [req.body.file_id];
        let scope = '';
        if (req.user.role === 'officer') {
            params.push(req.user.id, req.user.teamId);
            scope = ' AND f.officer_id = $2 AND u.team_id = $3';
        } else if (req.user.role === 'team_leader') {
            params.push(req.user.teamId);
            scope = ' AND u.team_id = $2';
        }
        const file = await client.query(
            `SELECT f.id FROM files f JOIN users u ON u.id = f.officer_id
             WHERE f.id = $1 AND f.status = 'Active'${scope} FOR UPDATE OF f, u`, params
        );
        if (!file.rowCount) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Only an active file in your ownership or team can be submitted' });
        }
        const result = await client.query(
            `INSERT INTO pg5_reviews (file_id, gate, status, submitted_by, submission_note)
             VALUES ($1, $2, 'submitted', $3, $4) RETURNING *`,
            [req.body.file_id, req.body.gate, req.user.id, req.body.submission_note?.trim() || null]
        );
        await logAction({
            userId: req.user.id, action: 'pg5_review.submit', entityType: 'pg5_review',
            entityId: result.rows[0].id, newValue: result.rows[0], ipAddress: req.ip,
            db: client, required: true
        });
        await client.query('COMMIT');
        res.status(201).json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') return res.status(409).json({ error: 'An active review already exists for this file and gate' });
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

router.put('/reviews/:id/status', [
    param('id').isInt({ min: 1 }),
    body('status').isIn(REVIEW_STATUSES),
    body('decision_note').optional({ nullable: true }).isString(),
    body('submission_note').optional({ nullable: true }).isString(),
    validateRequest
], async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const current = await client.query(
            `SELECT r.*, f.officer_id, u.team_id FROM pg5_reviews r
             JOIN files f ON f.id = r.file_id JOIN users u ON u.id = f.officer_id
             WHERE r.id = $1 FOR UPDATE`, [req.params.id]
        );
        if (!current.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Review not found' });
        }
        const review = current.rows[0];
        if (req.user.role === 'officer') {
            if (review.officer_id !== req.user.id || review.team_id !== req.user.teamId) {
                await client.query('ROLLBACK');
                return res.status(403).json({ error: 'Access denied' });
            }
        } else if (req.user.role === 'team_leader' && review.team_id !== req.user.teamId) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Access denied' });
        }
        validateReviewTransition(review.status, req.body.status, req.user.role);
        const leaderDecision = req.user.role !== 'officer';
        const decisionNote = req.body.decision_note?.trim() || null;
        const submissionNote = req.body.submission_note?.trim() || null;
        const result = await client.query(
            `UPDATE pg5_reviews SET status = $1,
             submission_note = CASE WHEN $2 THEN COALESCE($3, submission_note) ELSE submission_note END,
             decision_note = CASE WHEN $2 THEN decision_note ELSE COALESCE($4, decision_note) END,
             decided_by = CASE WHEN NOT $2 THEN $5 ELSE decided_by END,
             decided_at = CASE WHEN NOT $2 THEN NOW() ELSE decided_at END, updated_at = NOW()
             WHERE id = $6 RETURNING *`,
            [req.body.status, !leaderDecision, submissionNote, decisionNote, req.user.id, req.params.id]
        );
        await logAction({
            userId: req.user.id, action: 'pg5_review.status_change', entityType: 'pg5_review',
            entityId: Number(req.params.id), oldValue: { status: review.status },
            newValue: { status: req.body.status, decision_note: decisionNote, submission_note: submissionNote },
            ipAddress: req.ip, db: client, required: true
        });
        await client.query('COMMIT');
        res.json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.message.includes('not allowed') ? 409 : 500).json({ error: err.message });
    } finally {
        client.release();
    }
});

router.get('/weekly-checkins', async (req, res) => {
    try {
        const params = [];
        let where = '';
        if (req.user.role === 'officer') {
            params.push(req.user.id, req.user.teamId);
            where = 'WHERE c.officer_id = $1 AND c.team_id = $2';
        } else if (req.user.role === 'team_leader') {
            params.push(req.user.teamId);
            where = 'WHERE c.team_id = $1';
        }
        const result = await pool.query(
            `SELECT c.*, u.display_name AS officer_name FROM weekly_checkins c
             JOIN users u ON u.id = c.officer_id ${where}
             ORDER BY c.week_start DESC, u.display_name`, params
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/weekly-checkins', requireLeader, [
    body('officer_id').isInt({ min: 1 }),
    body('week_start').isISO8601(),
    body('operational_summary').trim().notEmpty(),
    validateRequest
], async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const officer = await officerInScope(client, req.user, req.body.officer_id, { forUpdate: true });
        if (!officer.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Active officer not found in scope' });
        }
        const teamId = officer.rows[0].team_id;
        const existing = await client.query(
            'SELECT * FROM weekly_checkins WHERE officer_id=$1 AND week_start=$2 FOR UPDATE',
            [req.body.officer_id, req.body.week_start]
        );
        const result = await client.query(
            `INSERT INTO weekly_checkins
             (officer_id, team_id, week_start, operational_summary, blockers, decisions, actions, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
             ON CONFLICT (officer_id, week_start) DO UPDATE SET
             operational_summary = EXCLUDED.operational_summary, blockers = EXCLUDED.blockers,
             decisions = EXCLUDED.decisions, actions = EXCLUDED.actions,
             updated_by = EXCLUDED.updated_by, updated_at = NOW()
             WHERE weekly_checkins.team_id = EXCLUDED.team_id
             RETURNING *`,
            [req.body.officer_id, teamId, req.body.week_start, req.body.operational_summary.trim(),
                req.body.blockers?.trim() || null, req.body.decisions?.trim() || null,
                req.body.actions?.trim() || null, req.user.id]
        );
        if (!result.rowCount) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Existing check-in belongs to another team' });
        }
        await logAction({
            userId: req.user.id, action: 'weekly_checkin.upsert', entityType: 'weekly_checkin',
            entityId: result.rows[0].id, oldValue: existing.rows[0] || null,
            newValue: result.rows[0], ipAddress: req.ip, db: client, required: true
        });
        await client.query('COMMIT');
        res.status(201).json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

router.get('/management-summary', requireLeader, async (req, res) => {
    try {
        const params = [];
        const scope = req.user.role === 'admin' ? '' : (params.push(req.user.teamId), 'WHERE u.team_id = $1');
        const actionScope = req.user.role === 'admin' ? '' : 'WHERE a.team_id = $1';
        const reviewScope = req.user.role === 'admin' ? '' : 'WHERE ru.team_id = $1';
        const [portfolio, reviews, actions] = await Promise.all([
            pool.query(`SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE f.status='Active')::int AS active,
                COUNT(*) FILTER (WHERE f.status='Completed')::int AS completed,
                COUNT(*) FILTER (WHERE f.status='Cancelled')::int AS cancelled
                FROM files f JOIN users u ON u.id=f.officer_id ${scope}`, params),
            pool.query(`SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE r.status IN ('submitted','resubmitted','reviewing'))::int AS pending,
                COUNT(*) FILTER (WHERE r.status='returned')::int AS returned,
                COUNT(*) FILTER (WHERE r.status='escalated')::int AS escalated
                FROM pg5_reviews r JOIN files rf ON rf.id=r.file_id
                JOIN users ru ON ru.id=rf.officer_id ${reviewScope}`, params),
            pool.query(`SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE a.completed_at IS NULL)::int AS open,
                COUNT(*) FILTER (WHERE a.completed_at IS NULL AND a.due_date < CURRENT_DATE)::int AS overdue
                FROM business_owner_actions a ${actionScope}`, params)
        ]);
        res.json({ portfolio: portfolio.rows[0], reviews: reviews.rows[0], actions: actions.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/business-owner-actions', requireLeader, async (req, res) => {
    try {
        const params = [];
        const where = req.user.role === 'admin' ? '' : (params.push(req.user.teamId), 'WHERE a.team_id = $1');
        const result = await pool.query(
            `SELECT a.*, f.pr_number FROM business_owner_actions a
             LEFT JOIN files f ON f.id=a.file_id ${where}
             ORDER BY a.action_month DESC, a.due_date NULLS LAST, a.id DESC`, params
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/business-owner-actions', requireLeader, [
    body('business_owner').trim().notEmpty(),
    body('action_month').isISO8601(),
    body('action').trim().notEmpty(),
    body('file_id').optional({ nullable: true }).isInt({ min: 1 }),
    body('due_date').optional({ nullable: true }).isISO8601(),
    validateRequest
], async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let teamId = req.user.teamId;
        if (req.body.file_id) {
            const params = [req.body.file_id];
            let scope = '';
            if (req.user.role !== 'admin') {
                params.push(req.user.teamId);
                scope = ' AND u.team_id=$2';
            }
            const file = await client.query(
                `SELECT u.team_id FROM files f JOIN users u ON u.id=f.officer_id
                 WHERE f.id=$1${scope} FOR UPDATE OF f, u`, params
            );
            if (!file.rowCount) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'File not found in scope' });
            }
            teamId = file.rows[0].team_id;
        } else if (req.user.role === 'admin') {
            teamId = Number(req.body.team_id);
        }
        if (!Number.isInteger(teamId) || teamId <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'team_id is required' });
        }
        const team = await client.query('SELECT id FROM teams WHERE id=$1 FOR KEY SHARE', [teamId]);
        if (!team.rowCount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Valid team_id is required' });
        }
        const result = await client.query(
            `INSERT INTO business_owner_actions
             (file_id, team_id, business_owner, action_month, action, due_date, created_by, updated_by)
             VALUES ($1,$2,$3,date_trunc('month',$4::date)::date,$5,$6,$7,$7) RETURNING *`,
            [req.body.file_id || null, teamId, req.body.business_owner.trim(), req.body.action_month,
                req.body.action.trim(), req.body.due_date || null, req.user.id]
        );
        await logAction({
            userId: req.user.id, action: 'business_owner_action.create', entityType: 'business_owner_action',
            entityId: result.rows[0].id, newValue: result.rows[0], ipAddress: req.ip,
            db: client, required: true
        });
        await client.query('COMMIT');
        res.status(201).json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

router.put('/business-owner-actions/:id/status', requireLeader, [
    param('id').isInt({ min: 1 }),
    body('completed').isBoolean(),
    validateRequest
], async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const params = [req.params.id];
        let scope = '';
        if (req.user.role !== 'admin') {
            params.push(req.user.teamId);
            scope = ' AND team_id = $2';
        }
        const current = await client.query(
            `SELECT * FROM business_owner_actions WHERE id = $1${scope} FOR UPDATE`, params
        );
        if (!current.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Business-owner action not found in scope' });
        }
        const result = await client.query(
            `UPDATE business_owner_actions
             SET completed_at = CASE WHEN $1 THEN COALESCE(completed_at, NOW()) ELSE NULL END,
                 updated_by = $2, updated_at = NOW()
             WHERE id = $3 RETURNING *`,
            [req.body.completed, req.user.id, req.params.id]
        );
        await logAction({
            userId: req.user.id,
            action: req.body.completed ? 'business_owner_action.complete' : 'business_owner_action.reopen',
            entityType: 'business_owner_action', entityId: Number(req.params.id),
            oldValue: { completed_at: current.rows[0].completed_at },
            newValue: { completed_at: result.rows[0].completed_at },
            ipAddress: req.ip, db: client, required: true
        });
        await client.query('COMMIT');
        res.json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

router.get('/performance-checkpoints', requireLeader, async (req, res) => {
    try {
        const params = [];
        const where = req.user.role === 'admin' ? '' : (params.push(req.user.teamId), 'WHERE p.team_id = $1');
        const result = await pool.query(
            `SELECT p.*, u.display_name AS officer_name FROM performance_checkpoints p
             JOIN users u ON u.id=p.officer_id ${where}
             ORDER BY p.year DESC, p.due_date, u.display_name`, params
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/performance-checkpoints', requireLeader, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const checkpoint = sanitizePerformanceCheckpoint(req.body);
        const officer = await officerInScope(client, req.user, checkpoint.officer_id, { forUpdate: true });
        if (!officer.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Active officer not found in scope' });
        }
        const existing = await client.query(
            `SELECT * FROM performance_checkpoints
             WHERE officer_id=$1 AND year=$2 AND checkpoint_type=$3 FOR UPDATE`,
            [checkpoint.officer_id, checkpoint.year, checkpoint.checkpoint_type]
        );
        const result = await client.query(
            `INSERT INTO performance_checkpoints
             (officer_id,team_id,year,checkpoint_type,due_date,completion_date,hr_record_date,followup_date,created_by,updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
             ON CONFLICT (officer_id,year,checkpoint_type) DO UPDATE SET
             due_date=EXCLUDED.due_date, completion_date=EXCLUDED.completion_date,
             hr_record_date=EXCLUDED.hr_record_date, followup_date=EXCLUDED.followup_date,
             updated_by=EXCLUDED.updated_by, updated_at=NOW()
             WHERE performance_checkpoints.team_id = EXCLUDED.team_id
             RETURNING *`,
            [checkpoint.officer_id, officer.rows[0].team_id, checkpoint.year, checkpoint.checkpoint_type,
                checkpoint.due_date, checkpoint.completion_date, checkpoint.hr_record_date,
                checkpoint.followup_date, req.user.id]
        );
        if (!result.rowCount) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Existing checkpoint belongs to another team' });
        }
        await logAction({
            userId: req.user.id, action: 'performance_checkpoint.upsert', entityType: 'performance_checkpoint',
            entityId: result.rows[0].id, oldValue: existing.rows[0] || null,
            newValue: result.rows[0], ipAddress: req.ip, db: client, required: true
        });
        await client.query('COMMIT');
        res.status(201).json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(/cannot contain|invalid|required|must be/.test(err.message.toLowerCase()) ? 400 : 500).json({ error: err.message });
    } finally {
        client.release();
    }
});

module.exports = router;
