const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { sendAssignmentEmail } = require('../services/emailService');
const multer = require('multer');
const XLSX = require('xlsx');

// Multer: memory storage (no disk writes)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
    fileFilter: (req, file, cb) => {
        const ok = file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
                   file.mimetype === 'application/vnd.ms-excel' ||
                   file.originalname.endsWith('.xlsx') ||
                   file.originalname.endsWith('.xls');
        cb(ok ? null : new Error('Only .xlsx / .xls files are allowed'), ok);
    }
});

// Helper: log a status change
async function logStatusChange(dbOrPool, triageFileId, fromStatus, toStatus, changedBy, note) {
    return dbOrPool.query(
        `INSERT INTO triage_status_history (triage_file_id, from_status, to_status, changed_by, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [triageFileId, fromStatus, toStatus, changedBy, note || null]
    );
}

// GET /api/triage — list triage files (scoped to team leader's team)
router.get('/', async (req, res) => {
    try {
        let query = `
            SELECT tf.*, t.name AS team_name, u.display_name AS created_by_name,
                   f.pr_number AS assigned_pr_number
            FROM triage_files tf
            LEFT JOIN teams t ON t.id = tf.team_id
            LEFT JOIN users u ON u.id = tf.created_by
            LEFT JOIN files f ON f.id = tf.file_id
        `;
        const params = [];
        const conditions = [];

        // Scope to team leader's team by default
        if (req.query.team_id === 'me' && req.user.teamId) {
            params.push(req.user.teamId);
            conditions.push(`tf.team_id = $${params.length}`);
        }

        if (req.query.status) {
            params.push(req.query.status);
            conditions.push(`tf.status = $${params.length}`);
        }

        if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
        query += ' ORDER BY tf.created_at DESC';

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/triage/stats — triage summary stats
router.get('/stats', async (req, res) => {
    try {
        const params = [];
        let where = '';
        if (req.user.teamId) {
            params.push(req.user.teamId);
            where = `WHERE tf.team_id = $${params.length}`;
        }

        const result = await pool.query(`
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE tf.status = 'Triaged') AS triaged,
                COUNT(*) FILTER (WHERE tf.status = 'Missing Document(s)') AS missing_docs,
                COUNT(*) FILTER (WHERE tf.status = 'Assigned') AS assigned,
                COUNT(*) FILTER (WHERE tf.status = 'Awarded') AS awarded,
                COUNT(*) FILTER (WHERE tf.status = 'Cancelled') AS cancelled
            FROM triage_files tf
            ${where}
        `, params);

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/triage/:id — detail with missing docs
router.get('/:id(\\d+)', async (req, res) => {
    try {
        const tf = await pool.query(`
            SELECT tf.*, t.name AS team_name, u.display_name AS created_by_name,
                   ou.display_name AS assigned_officer_name
            FROM triage_files tf
            LEFT JOIN teams t ON t.id = tf.team_id
            LEFT JOIN users u ON u.id = tf.created_by
            LEFT JOIN files f ON f.id = tf.file_id
            LEFT JOIN users ou ON ou.id = f.officer_id
            WHERE tf.id = $1
        `, [req.params.id]);

        if (tf.rows.length === 0) return res.status(404).json({ error: 'Triage file not found' });

        const docs = await pool.query(
            'SELECT * FROM triage_missing_docs WHERE triage_file_id = $1 ORDER BY created_at',
            [req.params.id]
        );

        const history = await pool.query(
            `SELECT h.*, u.display_name AS changed_by_name
             FROM triage_status_history h
             LEFT JOIN users u ON u.id = h.changed_by
             WHERE h.triage_file_id = $1 ORDER BY h.created_at ASC`,
            [req.params.id]
        );

        res.json({ ...tf.rows[0], missing_docs: docs.rows, status_history: history.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/triage — create new triage file
router.post('/', async (req, res) => {
    const { pr_number, title, estimated_value, business_owner, team_id } = req.body;
    if (!pr_number || !title || !business_owner) {
        return res.status(400).json({ error: 'pr_number, title, and business_owner are required' });
    }

    try {
        const result = await pool.query(
            `INSERT INTO triage_files (pr_number, title, team_id, estimated_value, business_owner, created_by, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'Triaged') RETURNING *`,
            [
                pr_number,
                title,
                team_id || req.user.teamId || null,
                estimated_value || null,
                business_owner,
                req.user.id
            ]
        );

        // Log initial status
        await logStatusChange(pool, result.rows[0].id, null, 'Triaged', req.user.id, 'File triaged');

        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'PR Number already exists' });
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/triage/:id — update triage file info
router.put('/:id', async (req, res) => {
    const { pr_number, title, estimated_value, business_owner, notes } = req.body;
    try {
        const result = await pool.query(
            `UPDATE triage_files SET
                pr_number = COALESCE($1, pr_number),
                title = COALESCE($2, title),
                estimated_value = COALESCE($3, estimated_value),
                business_owner = COALESCE($4, business_owner),
                notes = COALESCE($5, notes),
                updated_at = NOW()
             WHERE id = $6 RETURNING *`,
            [pr_number, title, estimated_value, business_owner, notes, req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Triage file not found' });
        res.json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'PR Number already exists' });
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/triage/:id/status — change status
router.put('/:id/status', async (req, res) => {
    const { status } = req.body;
    const valid = ['Triaged', 'Missing Document(s)', 'Assigned', 'Awarded', 'Cancelled'];
    if (!status || !valid.includes(status)) {
        return res.status(400).json({ error: `Status must be one of: ${valid.join(', ')}` });
    }

    try {
        const existing = await pool.query('SELECT * FROM triage_files WHERE id = $1', [req.params.id]);
        if (existing.rows.length === 0) return res.status(404).json({ error: 'Triage file not found' });

        const oldStatus = existing.rows[0].status;
        const updates = { status };

        // Set doc_deadline when moving to Missing Document(s)
        if (status === 'Missing Document(s)') {
            const deadline = new Date();
            deadline.setDate(deadline.getDate() + 7);
            updates.doc_deadline = deadline;
        }

        // Store cancellation reason in dedicated column
        const cancellationReason = (status === 'Cancelled' && req.body.cancellation_reason)
            ? req.body.cancellation_reason : null;

        const result = await pool.query(
            `UPDATE triage_files SET status = $1, doc_deadline = COALESCE($2, doc_deadline),
             cancellation_reason = COALESCE($3, cancellation_reason), updated_at = NOW()
             WHERE id = $4 RETURNING *`,
            [updates.status, updates.doc_deadline || null, cancellationReason, req.params.id]
        );

        // Log status change
        await logStatusChange(pool, req.params.id, oldStatus, status, req.user.id);

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/triage/:id/missing-docs — add missing document(s)
router.post('/:id/missing-docs', async (req, res) => {
    const { documents } = req.body; // array of document names
    if (!documents || !Array.isArray(documents) || documents.length === 0) {
        return res.status(400).json({ error: 'documents array is required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const results = [];
        for (const docName of documents) {
            if (!docName || !docName.trim()) continue;
            const r = await client.query(
                'INSERT INTO triage_missing_docs (triage_file_id, document_name) VALUES ($1, $2) RETURNING *',
                [req.params.id, docName.trim()]
            );
            results.push(r.rows[0]);
        }

        // Update status to Missing Document(s) and set deadline
        const existing = await client.query('SELECT status FROM triage_files WHERE id = $1', [req.params.id]);
        const oldStatus = existing.rows[0]?.status;
        const deadline = new Date();
        deadline.setDate(deadline.getDate() + 7);
        await client.query(
            `UPDATE triage_files SET status = 'Missing Document(s)', doc_deadline = $1, updated_at = NOW()
             WHERE id = $2`,
            [deadline, req.params.id]
        );

        // Log status change
        const docNames = results.map(r => r.document_name).join(', ');
        await logStatusChange(client, req.params.id, oldStatus, 'Missing Document(s)', req.user.id, `Missing: ${docNames}`);

        await client.query('COMMIT');
        res.status(201).json(results);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// PUT /api/triage/:id/missing-docs/:docId — toggle document as provided
router.put('/:id/missing-docs/:docId', async (req, res) => {
    const { provided } = req.body;
    try {
        const result = await pool.query(
            'UPDATE triage_missing_docs SET provided = $1 WHERE id = $2 AND triage_file_id = $3 RETURNING *',
            [provided !== false, req.params.docId, req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Document not found' });

        // Check if all docs are now provided — auto-transition to Triaged
        const allDocs = await pool.query(
            'SELECT * FROM triage_missing_docs WHERE triage_file_id = $1',
            [req.params.id]
        );
        const allProvided = allDocs.rows.length > 0 && allDocs.rows.every(d => d.provided);
        if (allProvided) {
            await pool.query(
                `UPDATE triage_files SET status = 'Triaged', updated_at = NOW() WHERE id = $1`,
                [req.params.id]
            );
            await logStatusChange(pool, req.params.id, 'Missing Document(s)', 'Triaged', req.user.id, 'All documents provided');
        }

        res.json({ doc: result.rows[0], all_provided: allProvided });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/triage/:id/missing-docs/:docId — remove a missing doc
router.delete('/:id/missing-docs/:docId', async (req, res) => {
    try {
        await pool.query(
            'DELETE FROM triage_missing_docs WHERE id = $1 AND triage_file_id = $2',
            [req.params.docId, req.params.id]
        );

        // Check remaining docs
        const remaining = await pool.query(
            'SELECT * FROM triage_missing_docs WHERE triage_file_id = $1',
            [req.params.id]
        );
        // If no docs left, transition back to Triaged
        if (remaining.rows.length === 0) {
            const cur = await pool.query('SELECT status FROM triage_files WHERE id = $1', [req.params.id]);
            if (cur.rows[0]?.status === 'Missing Document(s)') {
                await pool.query(
                    `UPDATE triage_files SET status = 'Triaged', updated_at = NOW() WHERE id = $1`,
                    [req.params.id]
                );
                await logStatusChange(pool, req.params.id, 'Missing Document(s)', 'Triaged', req.user.id, 'All missing documents removed');
            }
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/triage/:id/assign — assign triaged file to an officer
router.post('/:id/assign', async (req, res) => {
    const { officer_id, process_name, assigned_date, current_step_order } = req.body;
    if (!officer_id || !process_name) {
        return res.status(400).json({ error: 'officer_id and process_name are required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Verify triage file exists and is Triaged
        const tf = await client.query('SELECT * FROM triage_files WHERE id = $1', [req.params.id]);
        if (tf.rows.length === 0) throw new Error('Triage file not found');
        if (tf.rows[0].status !== 'Triaged') throw new Error('Only Triaged files can be assigned');

        const triageFile = tf.rows[0];

        // Get process steps
        const stepsResult = await client.query(
            'SELECT * FROM process_steps WHERE process_name = $1 ORDER BY step_order',
            [process_name]
        );
        if (stepsResult.rows.length === 0) throw new Error('Invalid process');

        const allSteps = stepsResult.rows;
        const startDate = assigned_date
            ? new Date(assigned_date.includes('T') ? assigned_date : `${assigned_date}T12:00:00`)
            : new Date();
        const targetOrder = current_step_order ? parseInt(current_step_order) : 1;
        const targetStep = allSteps.find(s => s.step_order === targetOrder) || allSteps[0];
        const stepStartedAt = targetOrder <= 1 ? startDate : new Date();

        // Create the file in the files table (copy estimated_value from triage)
        const fileResult = await client.query(
            `INSERT INTO files (pr_number, title, process_name, officer_id, current_step_id, step_started_at, created_at, estimated_value)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [triageFile.pr_number, triageFile.title, process_name, officer_id, targetStep.id, stepStartedAt, startDate, triageFile.estimated_value || null]
        );
        const file = fileResult.rows[0];

        // Auto-log steps (same logic as files.js)
        if (targetOrder > 1) {
            let runningDate = new Date(startDate);
            for (const step of allSteps) {
                if (step.step_order < targetOrder) {
                    const stepStart = new Date(runningDate);
                    const stepEnd = new Date(runningDate);
                    stepEnd.setDate(stepEnd.getDate() + (step.sla_days || 1));
                    runningDate = new Date(stepEnd);
                    await client.query(
                        'INSERT INTO file_step_log (file_id, step_id, started_at, completed_at, sla_met) VALUES ($1, $2, $3, $4, TRUE)',
                        [file.id, step.id, stepStart, stepEnd]
                    );
                } else if (step.step_order === targetOrder) {
                    await client.query(
                        'INSERT INTO file_step_log (file_id, step_id, started_at) VALUES ($1, $2, $3)',
                        [file.id, step.id, stepStartedAt]
                    );
                    break;
                }
            }
        } else {
            await client.query(
                'INSERT INTO file_step_log (file_id, step_id, started_at) VALUES ($1, $2, $3)',
                [file.id, allSteps[0].id, startDate]
            );
        }

        // Update triage file status to Assigned and link to file
        await client.query(
            `UPDATE triage_files SET status = 'Assigned', file_id = $1, updated_at = NOW() WHERE id = $2`,
            [file.id, req.params.id]
        );

        // Log assignment
        const officerName = await client.query('SELECT display_name FROM users WHERE id = $1', [officer_id]);
        await logStatusChange(client, req.params.id, 'Triaged', 'Assigned', req.user.id,
            `Assigned to ${officerName.rows[0]?.display_name || 'officer'} (${process_name.replace(/_/g, ' ')})`);

        await client.query('COMMIT');

        res.status(201).json({ triage_id: triageFile.id, file_id: file.id, status: 'Assigned' });

        // Send assignment email (non-blocking)
        try {
            const officerRow = await pool.query('SELECT email, display_name FROM users WHERE id = $1', [officer_id]);
            if (officerRow.rows.length > 0) {
                const officer = officerRow.rows[0];
                sendAssignmentEmail(officer.email, officer.display_name, triageFile.pr_number, triageFile.title, process_name);
            }
        } catch (emailErr) {
            console.error('[Email] Triage assignment email error:', emailErr.message);
        }
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') return res.status(409).json({ error: 'PR Number already exists in files' });
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// GET /api/triage/export — export triage files as Excel (team leaders only)
router.get('/export', async (req, res) => {
    try {
        let query = `
            SELECT tf.pr_number, tf.title, tf.business_owner, tf.status,
                   tf.estimated_value, tf.cancellation_reason, tf.notes,
                   t.name AS team_name, u.display_name AS created_by_name,
                   tf.created_at, tf.doc_deadline
            FROM triage_files tf
            LEFT JOIN teams t ON t.id = tf.team_id
            LEFT JOIN users u ON u.id = tf.created_by
        `;
        const params = [];
        const conditions = [];

        if (req.user.teamId) {
            params.push(req.user.teamId);
            conditions.push(`tf.team_id = $${params.length}`);
        }
        if (req.query.status) { params.push(req.query.status); conditions.push(`tf.status = $${params.length}`); }
        if (req.query.search) { params.push(`%${req.query.search}%`); conditions.push(`(tf.pr_number ILIKE $${params.length} OR tf.title ILIKE $${params.length})`); }

        if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
        query += ' ORDER BY tf.created_at DESC';

        const result = await pool.query(query, params);

        const rows = result.rows.map(tf => ({
            'PR Number':            tf.pr_number,
            'Title':                tf.title,
            'Business Owner':       tf.business_owner,
            'Status':               tf.status,
            'Estimated Value':      tf.estimated_value != null ? parseFloat(tf.estimated_value) : '',
            'Team':                 tf.team_name || '',
            'Created By':           tf.created_by_name || '',
            'Cancellation Reason':  tf.cancellation_reason || '',
            'Notes':                tf.notes || '',
            'Date Created':         tf.created_at ? new Date(tf.created_at).toISOString().split('T')[0] : '',
            'Doc Deadline':         tf.doc_deadline ? new Date(tf.doc_deadline).toISOString().split('T')[0] : '',
        }));

        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, 'Triage');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Disposition', `attachment; filename="triage_files_${new Date().toISOString().split('T')[0]}.xlsx"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/triage/import — bulk import triage files from Excel
router.post('/import', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded. Please upload an .xlsx file.' });
    }

    let workbook;
    try {
        workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    } catch (e) {
        return res.status(400).json({ error: 'Could not parse Excel file. Ensure it is a valid .xlsx file.' });
    }

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
        return res.status(400).json({ error: 'Excel file has no worksheets.' });
    }

    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (rows.length === 0) {
        return res.status(400).json({ error: 'The sheet is empty. Please add data rows below the header.' });
    }

    // Normalise header keys to lowercase with underscores for flexible matching
    const normalise = str => String(str || '').trim().toLowerCase().replace(/\s+/g, '_');

    const imported = [];
    const skipped = [];

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        for (let i = 0; i < rows.length; i++) {
            const rawRow = rows[i];
            const rowNum = i + 2; // +1 for header, +1 for 1-based human row number

            // Build a normalised key map
            const norm = {};
            for (const [k, v] of Object.entries(rawRow)) {
                norm[normalise(k)] = String(v || '').trim();
            }

            // Map flexible column name variants
            const pr_number     = norm['pr_number'] || norm['pr_no'] || norm['pr'] || norm['purchase_requisition_number'] || norm['pr_#'] || '';
            const title         = norm['title'] || norm['file_title'] || norm['description'] || '';
            const business_owner = norm['business_owner'] || norm['owner'] || norm['business_unit'] || '';
            const estimated_value_raw = norm['estimated_value'] || norm['value'] || norm['amount'] || '';
            const estimated_value = estimated_value_raw !== '' && !isNaN(parseFloat(estimated_value_raw))
                ? parseFloat(estimated_value_raw)
                : null;

            // Validate required fields
            if (!pr_number) {
                skipped.push({ row: rowNum, reason: 'Missing PR Number' });
                continue;
            }
            if (!title) {
                skipped.push({ row: rowNum, pr_number, reason: 'Missing Title' });
                continue;
            }
            if (!business_owner) {
                skipped.push({ row: rowNum, pr_number, reason: 'Missing Business Owner' });
                continue;
            }

            try {
                const result = await client.query(
                    `INSERT INTO triage_files (pr_number, title, team_id, estimated_value, business_owner, created_by, status)
                     VALUES ($1, $2, $3, $4, $5, $6, 'Triaged') RETURNING id`,
                    [pr_number, title, req.user.teamId || null, estimated_value, business_owner, req.user.id]
                );
                const triageId = result.rows[0].id;
                await client.query(
                    `INSERT INTO triage_status_history (triage_file_id, from_status, to_status, changed_by, note)
                     VALUES ($1, NULL, 'Triaged', $2, 'Imported from Excel')`,
                    [triageId, req.user.id]
                );
                imported.push({ row: rowNum, pr_number });
            } catch (err) {
                if (err.code === '23505') {
                    skipped.push({ row: rowNum, pr_number, reason: 'Duplicate PR Number — already exists' });
                } else {
                    skipped.push({ row: rowNum, pr_number, reason: err.message });
                }
            }
        }

        await client.query('COMMIT');
        res.status(201).json({
            imported: imported.length,
            skipped: skipped.length,
            total: rows.length,
            details: { imported, skipped }
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

module.exports = router;
