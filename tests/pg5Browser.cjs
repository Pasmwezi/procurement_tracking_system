// Disposable authenticated Chromium regression; never point at production.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const url = process.env.PG5_BROWSER_DATABASE_URL;
if (!url || !/^pg5_browser$/.test(new URL(url).pathname.slice(1)) || new URL(url).hostname !== '127.0.0.1') throw Error('Dedicated loopback pg5_browser DB required');
const pool = new Pool({ connectionString: url });
const secret = crypto.randomBytes(48).toString('hex');
const port = 35439;
const origin = `http://127.0.0.1:${port}`;
let server, browser;
(async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    for (const file of ['init.sql', 'migrate-v3-triage.sql', 'migrate-v4-basis-of-selection.sql']) {
        await pool.query(fs.readFileSync(path.join(__dirname, '../db', file), 'utf8'));
    }
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    await pool.query(`INSERT INTO teams(id,name) VALUES(901,'QA Own Team'),(902,'QA Other Team');
        INSERT INTO users(id,email,display_name,role,team_id,password_changed) VALUES
        (901,'qa-leader@example.invalid','QA Leader','team_leader',901,TRUE),
        (902,'qa-own@example.invalid','QA Own Officer','officer',901,TRUE),
        (903,'qa-other@example.invalid','QA Other Officer','officer',902,TRUE),
        (904,'qa-admin@example.invalid','QA Admin','admin',NULL,TRUE);
        INSERT INTO files(id,pr_number,title,process_name,officer_id,status) VALUES
        (901,'QA-OWN','Own active file','Sole_Source',902,'Active'),
        (902,'QA-OTHER','Other team file','Sole_Source',903,'Active')`);
    await pool.query('UPDATE users SET password_hash=$1', [hash]);
    // Restrict the real server's fixed 0.0.0.0 listener to loopback for this QA child only.
    const launcher = `const net = require('node:net'); const listen = net.Server.prototype.listen;
        net.Server.prototype.listen = function (...args) {
            if (args[1] === '0.0.0.0') args[1] = '127.0.0.1';
            return listen.apply(this, args);
        }; require('./server');`;
    server = spawn(process.execPath, ['-e', launcher], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_URL: url, JWT_SECRET: secret, PORT: String(port) }, stdio: ['ignore','pipe','pipe'] });
    let logs = '';
    server.stdout.on('data', data => { logs += data; });
    server.stderr.on('data', data => { logs += data; });
    let healthy = false;
    for (let i = 0; i < 100; i++) {
        try { if ((await fetch(origin + '/api/health')).ok) { healthy = true; break; } } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(healthy, logs);
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/home/clawserver/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });
    if (process.env.PG5_STALE_APP_PATH) {
        const staleContext = await browser.newContext();
        const stalePage = await staleContext.newPage();
        const staleApp = fs.readFileSync(process.env.PG5_STALE_APP_PATH, 'utf8');
        await stalePage.route('**/js/app.js?*', route => route.fulfill({ contentType: 'application/javascript', body: staleApp }));
        await stalePage.goto(origin);
        const token = jwt.sign({ id: 901, purpose: 'access', tokenVersion: 0 }, secret, { expiresIn: '10m' });
        await stalePage.evaluate(token => localStorage.setItem('token', token), token);
        await stalePage.reload({ waitUntil: 'networkidle' });
        await stalePage.locator('.nav-item[data-page="teamLeadership"]').click();
        assert.equal(await stalePage.locator('#pageTitle').innerText(), 'teamLeadership');
        assert.equal(await stalePage.locator('#tlActiveFiles').innerText(), '—');
        assert.equal(await stalePage.locator('#tlClassificationOfficer option').count(), 0);
        console.log(JSON.stringify({ stage: 'simulated-pre-PG5-cache', title: 'teamLeadership', summary: '—', officerChoices: 0 }));
        await stalePage.unroute('**/js/app.js?*');
        await stalePage.route('**/js/app.js?v=5.1', route => route.fulfill({ contentType: 'application/javascript', body: staleApp }));
        await stalePage.reload({ waitUntil: 'networkidle' });
        await stalePage.locator('.nav-item[data-page="teamLeadership"]').click();
        await stalePage.waitForFunction(() => document.getElementById('tlActiveFiles').textContent === '1');
        assert.equal(await stalePage.locator('#pageTitle').innerText(), 'Team Leader');
        console.log(JSON.stringify({ stage: 'old-cache-key-retained-new-key-loads', title: 'Team Leader', active: 1 }));
        await staleContext.close();
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    // Tokens exist only in memory and are scoped to localStorage on this origin.
    async function login(id) {
        await page.waitForLoadState('networkidle');
        const token = jwt.sign({ id, purpose: 'access', tokenVersion: 0 }, secret, { expiresIn: '10m' });
        if (!page.url().startsWith(origin)) await page.goto(origin);
        await page.evaluate(token => localStorage.setItem('token', token), token);
        await page.reload({ waitUntil: 'networkidle' });
        await page.locator('.nav-item[data-page="teamLeadership"]').click();
        await page.waitForFunction(() => document.getElementById('tlReviewsBody').textContent.trim() || document.getElementById('teamLeadershipError').textContent.trim());
    }
    await login(901);
    const before = await page.locator('#pageTeamLeadership').ariaSnapshot();
    console.log(JSON.stringify({ stage: 'authenticated-repro', title: await page.locator('#pageTitle').innerText(), officers: await page.locator('#tlClassificationOfficer').innerText(), active: await page.locator('#tlActiveFiles').innerText(), error: await page.locator('#teamLeadershipError').innerText(), snapshot: before }));
    assert.equal(await page.locator('#pageTitle').innerText(), 'Team Leader');
    assert.equal(await page.locator('#tlClassificationOfficer option').count(), 1);
    assert.match(await page.locator('#tlClassificationOfficer').innerText(), /QA Own Officer/);
    assert.equal(await page.locator('#tlActiveFiles').innerText(), '1');
    await login(902);
    assert.equal(await page.locator('#tlReviewFile option[value="901"]').count(), 1, 'officer active file choices must load');
    await login(901);
    assert.equal(await page.locator('#formPg5CompletedReview').count(), 1, 'manager completed-review controls missing');
    assert.equal(await page.locator('#tlCompletedReviewFile option[value="902"]').count(), 0);
    const leaderToken = jwt.sign({ id: 901, purpose: 'access', tokenVersion: 0 }, secret, { expiresIn: '10m' });
    const officerToken = jwt.sign({ id: 902, purpose: 'access', tokenVersion: 0 }, secret, { expiresIn: '10m' });
    const deniedCrossTeam = await context.request.post(origin + '/api/team-leadership/reviews', {
        headers: { Authorization: `Bearer ${leaderToken}` }, data: { file_id: 902, gate: 'strategy', status: 'cleared', decision_note: 'Forbidden' }
    });
    assert.equal(deniedCrossTeam.status(), 403);
    const deniedSelfClear = await context.request.post(origin + '/api/team-leadership/reviews', {
        headers: { Authorization: `Bearer ${officerToken}` }, data: { file_id: 901, gate: 'strategy', status: 'cleared', decision_note: 'Forbidden' }
    });
    assert.equal(deniedSelfClear.status(), 403);
    await page.locator('#tlCompletedReviewFile').selectOption('901');
    await page.locator('#tlCompletedReviewGate').selectOption('strategy');
    await page.locator('#tlCompletedReviewOutcome').selectOption('conditionally cleared');
    await page.locator('#tlCompletedReviewNote').fill('QA conditions confirmed');
    const created = page.waitForResponse(response => response.url().endsWith('/api/team-leadership/reviews') && response.request().method() === 'POST');
    await page.locator('#formPg5CompletedReview button').click();
    assert.equal((await created).status(), 201);
    await page.waitForFunction(() => document.getElementById('tlReviewsBody').textContent.includes('conditionally cleared'));
    const saved = await pool.query("SELECT * FROM pg5_reviews WHERE file_id=901 AND gate='strategy'");
    assert.equal(saved.rows.length, 1);
    assert.equal(saved.rows[0].decided_by, 901);
    assert.equal(saved.rows[0].decision_note, 'QA conditions confirmed');
    assert.ok(saved.rows[0].decided_at);
    assert.equal((await pool.query("SELECT id FROM audit_log WHERE action='pg5_review.record_completed' AND entity_id=$1", [saved.rows[0].id])).rowCount, 1);
    await page.reload();
    await page.locator('.nav-item[data-page="teamLeadership"]').click();
    await page.waitForFunction(() => document.getElementById('tlReviewsBody').textContent.includes('conditionally cleared'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(350); // Let responsive sidebar transitions settle before pixel QA.
    if (await page.locator('#sidebarBackdrop').isVisible()) await page.locator('#sidebarBackdrop').click();
    await page.locator('#tlCompletedReviewFile').selectOption('901');
    await page.locator('#tlCompletedReviewGate').selectOption('close-out');
    await page.locator('#tlCompletedReviewOutcome').selectOption('cleared');
    await page.locator('#tlCompletedReviewNote').fill('QA mobile completed review');
    const mobileCreated = page.waitForResponse(response => response.url().endsWith('/api/team-leadership/reviews') && response.request().method() === 'POST');
    await page.locator('#formPg5CompletedReview button').click();
    assert.equal((await mobileCreated).status(), 201);
    await page.waitForFunction(() => document.getElementById('tlReviewsBody').textContent.includes('close-out'));
    await page.screenshot({ path: process.env.PG5_SCREENSHOT || path.join(__dirname, '../../pg5-mobile.png'), fullPage: true });
    const widths = await page.evaluate(() => ({ inner: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(widths.document <= widths.inner, JSON.stringify(widths));
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(902);
    assert.equal(await page.locator('#formPg5CompletedReview').isVisible(), false);
    await page.locator('#tlReviewFile').selectOption('901');
    await page.locator('#tlReviewGate').selectOption('pre-award');
    await page.locator('#tlReviewSubmissionNote').fill('Officer submission');
    const submitted = page.waitForResponse(response => response.url().endsWith('/api/team-leadership/reviews') && response.request().method() === 'POST');
    await page.locator('#formPg5ReviewSubmission button').click();
    assert.equal((await submitted).status(), 201);
    const review = (await pool.query("SELECT * FROM pg5_reviews WHERE file_id=901 AND gate='pre-award'")).rows[0];
    await login(901);
    page.once('dialog', dialog => dialog.accept('Please revise'));
    await page.locator(`#tlReviewsBody select[onchange*="(${review.id},"]`).selectOption('returned');
    await page.waitForFunction(() => document.getElementById('tlReviewsBody').textContent.includes('returned'));
    await login(902);
    page.once('dialog', dialog => dialog.accept('Revised officer submission'));
    const resubmitted = page.waitForResponse(response => response.url().endsWith(`/reviews/${review.id}/status`) && response.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Resubmit', exact: true }).click();
    assert.equal((await resubmitted).status(), 200);
    const updated = (await pool.query('SELECT * FROM pg5_reviews WHERE id=$1', [review.id])).rows[0];
    assert.equal(updated.status, 'resubmitted');
    assert.equal(updated.decision_note, 'Please revise');
    assert.equal(updated.submission_note, 'Revised officer submission');
    await pool.query(`INSERT INTO files(id,pr_number,title,process_name,officer_id,status)
        SELECT n, 'QA-PAGE-' || n, 'Pagination file ' || n, 'Sole_Source', 902, 'Active'
        FROM generate_series(1000,1100) n`);
    await login(901);
    assert.equal(await page.locator('#tlCompletedReviewFile option:not([value=""])').count(), 102);
    await login(902);
    assert.equal(await page.locator('#tlReviewFile option:not([value=""])').count(), 102);
    assert.equal(await page.locator('#tlReviewFile option[value="902"]').count(), 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'PASS', chromium: await browser.version(), origin, widths, flows: ['own-team loading','manager conditional clearance + audit + reload','mobile completed clearance 390x844','officer submission','leader return','officer resubmission','102 active files paginated for both roles'], authorization: { crossTeam: deniedCrossTeam.status(), selfClear: deniedSelfClear.status() }, consoleErrors: errors }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
    if (browser) await browser.close();
    if (server) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
    await pool.end();
});
