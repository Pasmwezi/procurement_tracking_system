const nodemailer = require('nodemailer');
const pool = require('../db/pool');

// SMTP setting keys stored in app_settings
const SMTP_KEYS = [
    'smtp_server_name',
    'smtp_host',
    'smtp_port',
    'smtp_username',
    'smtp_password',
    'smtp_ignore_tls',
    'smtp_sender'
];

/**
 * Load SMTP settings from the database.
 * Returns an object with all smtp_* keys, or null if not configured.
 */
async function getSmtpSettings() {
    try {
        const result = await pool.query(
            'SELECT key, value FROM app_settings WHERE key = ANY($1)',
            [SMTP_KEYS]
        );
        if (result.rows.length === 0) return null;

        const settings = {};
        for (const row of result.rows) {
            settings[row.key] = row.value;
        }
        // Must have at least host and port to be usable
        if (!settings.smtp_host || !settings.smtp_port) return null;
        return settings;
    } catch (err) {
        console.error('[Email] Failed to load SMTP settings:', err.message);
        return null;
    }
}

/**
 * Save SMTP settings to the database.
 */
async function saveSmtpSettings(settings) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const key of SMTP_KEYS) {
            if (settings[key] !== undefined) {
                await client.query(
                    `INSERT INTO app_settings (key, value, updated_at)
                     VALUES ($1, $2, NOW())
                     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
                    [key, settings[key] ?? '']
                );
            }
        }
        await client.query('COMMIT');
        return true;
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[Email] Failed to save SMTP settings:', err.message);
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Create a nodemailer transporter from current DB settings.
 * Returns null if SMTP is not configured.
 */
async function createTransporter() {
    const settings = await getSmtpSettings();
    if (!settings) return null;

    const port = parseInt(settings.smtp_port) || 587;
    const secure = port === 465; // true for 465, false for others
    const ignoreTls = settings.smtp_ignore_tls === 'true';

    const transportConfig = {
        host: settings.smtp_host,
        port,
        secure,
        tls: {
            rejectUnauthorized: !ignoreTls
        }
    };

    // Only add auth if username is provided
    if (settings.smtp_username) {
        transportConfig.auth = {
            user: settings.smtp_username,
            pass: settings.smtp_password || ''
        };
    }

    return nodemailer.createTransport(transportConfig);
}

/**
 * Send an email. Returns true on success, throws on failure.
 */
async function sendEmail(to, subject, html) {
    const settings = await getSmtpSettings();
    if (!settings) {
        console.log('[Email] SMTP not configured, skipping email.');
        return false;
    }

    const transporter = await createTransporter();
    if (!transporter) return false;

    const senderName = settings.smtp_sender || 'FileTracker';
    const fromAddress = settings.smtp_username || `noreply@${settings.smtp_host}`;

    const mailOptions = {
        from: `"${senderName}" <${fromAddress}>`,
        to,
        subject,
        html
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log(`[Email] Sent to ${to}: ${info.messageId}`);
        return true;
    } catch (err) {
        console.error(`[Email] Failed to send to ${to}:`, err.message);
        throw err;
    }
}

/**
 * Send a test email to verify SMTP configuration.
 */
async function sendTestEmail(toAddress) {
    const html = `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 32px; background: #1e1e2d; border-radius: 12px; color: #ffffff;">
            <div style="text-align: center; margin-bottom: 24px;">
                <div style="display: inline-block; width: 48px; height: 48px; background: linear-gradient(135deg, #7239ea, #9d6fff); border-radius: 12px; line-height: 48px; font-size: 24px;">📧</div>
            </div>
            <h2 style="text-align: center; color: #ffffff; margin-bottom: 8px;">SMTP Configuration Test</h2>
            <p style="text-align: center; color: #a1a5b7; font-size: 0.9rem;">
                This is a test email from <strong style="color: #9d6fff;">FileTracker</strong>. 
                If you received this, your email server is configured correctly!
            </p>
            <hr style="border: none; border-top: 1px solid #2b2b40; margin: 24px 0;">
            <p style="text-align: center; color: #6e7287; font-size: 0.78rem;">
                Sent at ${new Date().toLocaleString()}
            </p>
        </div>
    `;

    return await sendEmail(toAddress, '✅ FileTracker — SMTP Test Successful', html);
}

/**
 * Send an SLA overdue email notification.
 */
async function sendOverdueEmail(officerEmail, officerName, prNumber, title, stepName, daysOverdue) {
    const html = `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px; background: #1e1e2d; border-radius: 12px; color: #ffffff;">
            <div style="text-align: center; margin-bottom: 24px;">
                <div style="display: inline-block; width: 48px; height: 48px; background: rgba(241, 65, 108, 0.15); border-radius: 12px; line-height: 48px; font-size: 24px; color: #f1416c;">⚠️</div>
            </div>
            <h2 style="text-align: center; color: #f1416c; margin-bottom: 8px;">SLA Deadline Exceeded</h2>
            <p style="color: #a1a5b7; font-size: 0.9rem; text-align: center; margin-bottom: 24px;">
                A procurement file step has exceeded its SLA deadline.
            </p>
            <div style="background: rgba(0, 0, 0, 0.2); border: 1px solid #2b2b40; border-radius: 8px; padding: 20px; margin-bottom: 20px;">
                <table style="width: 100%; border-collapse: collapse; color: #ffffff;">
                    <tr><td style="padding: 6px 0; color: #6e7287; font-size: 0.8rem;">PR NUMBER</td><td style="padding: 6px 0; font-weight: 600;">${prNumber}</td></tr>
                    <tr><td style="padding: 6px 0; color: #6e7287; font-size: 0.8rem;">FILE TITLE</td><td style="padding: 6px 0; font-weight: 600;">${title}</td></tr>
                    <tr><td style="padding: 6px 0; color: #6e7287; font-size: 0.8rem;">CURRENT STEP</td><td style="padding: 6px 0; font-weight: 600;">${stepName}</td></tr>
                    <tr><td style="padding: 6px 0; color: #6e7287; font-size: 0.8rem;">OFFICER</td><td style="padding: 6px 0; font-weight: 600;">${officerName}</td></tr>
                    <tr><td style="padding: 6px 0; color: #6e7287; font-size: 0.8rem;">DAYS OVERDUE</td><td style="padding: 6px 0; font-weight: 700; color: #f1416c;">${daysOverdue} days</td></tr>
                </table>
            </div>
            <p style="color: #a1a5b7; font-size: 0.82rem; text-align: center;">
                Please take action to advance this file to the next step.
            </p>
            <hr style="border: none; border-top: 1px solid #2b2b40; margin: 24px 0;">
            <p style="text-align: center; color: #6e7287; font-size: 0.75rem;">FileTracker — Procurement File Tracking System</p>
        </div>
    `;

    try {
        await sendEmail(officerEmail, `⚠️ SLA Overdue: ${prNumber} — ${stepName}`, html);
    } catch (err) {
        // Log but don't crash
        console.error(`[Email] Overdue email failed for ${officerEmail}:`, err.message);
    }
}

/**
 * Send a file assignment email notification.
 */
async function sendAssignmentEmail(officerEmail, officerName, prNumber, title, processName) {
    const html = `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px; background: #1e1e2d; border-radius: 12px; color: #ffffff;">
            <div style="text-align: center; margin-bottom: 24px;">
                <div style="display: inline-block; width: 48px; height: 48px; background: rgba(0, 158, 247, 0.15); border-radius: 12px; line-height: 48px; font-size: 24px; color: #009ef7;">📁</div>
            </div>
            <h2 style="text-align: center; color: #009ef7; margin-bottom: 8px;">New File Assigned</h2>
            <p style="color: #a1a5b7; font-size: 0.9rem; text-align: center; margin-bottom: 24px;">
                Hi <strong style="color: #ffffff;">${officerName}</strong>, a new procurement file has been assigned to you.
            </p>
            <div style="background: rgba(0, 0, 0, 0.2); border: 1px solid #2b2b40; border-radius: 8px; padding: 20px; margin-bottom: 20px;">
                <table style="width: 100%; border-collapse: collapse; color: #ffffff;">
                    <tr><td style="padding: 6px 0; color: #6e7287; font-size: 0.8rem;">PR NUMBER</td><td style="padding: 6px 0; font-weight: 600;">${prNumber}</td></tr>
                    <tr><td style="padding: 6px 0; color: #6e7287; font-size: 0.8rem;">FILE TITLE</td><td style="padding: 6px 0; font-weight: 600;">${title}</td></tr>
                    <tr><td style="padding: 6px 0; color: #6e7287; font-size: 0.8rem;">PROCESS</td><td style="padding: 6px 0; font-weight: 600;">${processName.replace(/_/g, ' ')}</td></tr>
                </table>
            </div>
            <p style="color: #a1a5b7; font-size: 0.82rem; text-align: center;">
                Log in to FileTracker to view your assigned files and deadlines.
            </p>
            <hr style="border: none; border-top: 1px solid #2b2b40; margin: 24px 0;">
            <p style="text-align: center; color: #6e7287; font-size: 0.75rem;">FileTracker — Procurement File Tracking System</p>
        </div>
    `;

    try {
        await sendEmail(officerEmail, `📁 New File Assigned: ${prNumber} — ${title}`, html);
    } catch (err) {
        console.error(`[Email] Assignment email failed for ${officerEmail}:`, err.message);
    }
}

/**
 * Send a contract expiry email.
 */
async function sendContractExpiryEmail(leaderEmail, leaderName, prNumber, fileTitle, contractNumber, contractorName, endDate, daysLeft) {
    const html = `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px; background: #1e1e2d; border-radius: 12px; color: #ffffff;">
            <div style="text-align: center; margin-bottom: 24px;">
                <div style="display: inline-block; width: 48px; height: 48px; background: rgba(255, 199, 0, 0.15); border-radius: 12px; line-height: 48px; font-size: 24px; color: #ffc700;">⏳</div>
            </div>
            <h2 style="text-align: center; color: #ffc700; margin-bottom: 8px;">Contract Expiring Soon</h2>
            <p style="color: #a1a5b7; font-size: 0.9rem; text-align: center; margin-bottom: 24px;">
                Hi <strong style="color: #ffffff;">${leaderName}</strong>, a contract is expiring in ${daysLeft} days.
            </p>
            <div style="background: rgba(0, 0, 0, 0.2); border: 1px solid #2b2b40; border-radius: 8px; padding: 20px; margin-bottom: 20px;">
                <table style="width: 100%; border-collapse: collapse; color: #ffffff;">
                    <tr><td style="padding: 6px 0; color: #6e7287; font-size: 0.8rem;">PR NUMBER</td><td style="padding: 6px 0; font-weight: 600;">${prNumber}</td></tr>
                    <tr><td style="padding: 6px 0; color: #6e7287; font-size: 0.8rem;">FILE TITLE</td><td style="padding: 6px 0; font-weight: 600;">${fileTitle}</td></tr>
                    <tr><td style="padding: 6px 0; color: #6e7287; font-size: 0.8rem;">CONTRACT NO.</td><td style="padding: 6px 0; font-weight: 600;">${contractNumber || 'N/A'}</td></tr>
                    <tr><td style="padding: 6px 0; color: #6e7287; font-size: 0.8rem;">CONTRACTOR</td><td style="padding: 6px 0; font-weight: 600;">${contractorName || 'N/A'}</td></tr>
                    <tr><td style="padding: 6px 0; color: #6e7287; font-size: 0.8rem;">END DATE</td><td style="padding: 6px 0; font-weight: 700; color: #ffc700;">${new Date(endDate).toLocaleDateString()}</td></tr>
                </table>
            </div>
            <p style="color: #a1a5b7; font-size: 0.82rem; text-align: center;">
                Please review this contract and prepare any necessary amendments or renewals.
            </p>
            <hr style="border: none; border-top: 1px solid #2b2b40; margin: 24px 0;">
            <p style="text-align: center; color: #6e7287; font-size: 0.75rem;">FileTracker — Procurement File Tracking System</p>
        </div>
    `;

    try {
        await sendEmail(leaderEmail, `⏳ Contract Expiring in ${daysLeft} days: ${prNumber}`, html);
    } catch (err) {
        console.error(`[Email] Expiry email failed for ${leaderEmail}:`, err.message);
    }
}

module.exports = {
    getSmtpSettings,
    saveSmtpSettings,
    sendEmail,
    sendTestEmail,
    sendOverdueEmail,
    sendAssignmentEmail,
    sendContractExpiryEmail,
    SMTP_KEYS
};
