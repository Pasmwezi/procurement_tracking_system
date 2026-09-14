const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
/* global fetch */

if (!process.env.FINANCIAL_TEST_DATABASE_URL) {
    test('financial route tests require FINANCIAL_TEST_DATABASE_URL (disposable database)', { skip: true }, () => {});
} else {
    process.env.DATABASE_URL = process.env.FINANCIAL_TEST_DATABASE_URL;
    const pool = require('../db/pool');
    let server, base;
    async function request(url, method = 'GET', body, role = 'officer') {
        const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'x-role': role }, body: body ? JSON.stringify(body) : undefined });
        return { status: response.status, data: await response.json() };
    }
    test.before(async () => {
        await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
        await pool.query(fs.readFileSync(path.join(__dirname, '../db/init.sql'), 'utf8'));
        for (const file of fs.readdirSync(path.join(__dirname, '../db')).filter(f => /^migrate-v[34].*\.sql$/.test(f)).sort()) {
            await pool.query(fs.readFileSync(path.join(__dirname, '../db', file), 'utf8'));
        }
        // Exercise the production DDL without starting auth/bootstrap or background jobs.
        const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
        for (const match of source.matchAll(/await pool\.query\(`([\s\S]*?)`\)/g)) {
            if (/^\s*(CREATE TABLE|ALTER TABLE)/.test(match[1])) await pool.query(match[1]);
        }
        await pool.query("INSERT INTO teams(id,name) VALUES (901,'Financial Team'),(902,'Other Team') ON CONFLICT DO NOTHING");
        await pool.query("INSERT INTO users(id,email,display_name,role,team_id) VALUES (901,'financial@example.test','Financial','officer',901),(902,'other-financial@example.test','Other','officer',902)");
        await pool.query("INSERT INTO files(id,pr_number,title,process_name,officer_id,current_step_id,status,basis_of_selection) SELECT 901,'FIN-1','Financial',process_name,901,id,'Completed','lowest_price' FROM process_steps WHERE step_name ILIKE '%solicit%' AND step_name NOT ILIKE '%drafting%' LIMIT 1");
        await pool.query("INSERT INTO files(id,pr_number,title,process_name,officer_id,status) SELECT 902,'FIN-2','Other',process_name,902,'Completed' FROM files WHERE id=901");
        await pool.query("INSERT INTO contracts(id,file_id,contract_number,start_date,end_date) VALUES(901,901,'FIN-C1','2026-01-01','2026-12-01'),(902,902,'FIN-C2','2026-01-01','2026-12-01')");
        await pool.query("INSERT INTO purchase_orders(id,contract_id,po_number,po_date,amount) VALUES(901,901,'FIN-PO1','2026-01-01',100),(902,902,'FIN-PO2','2026-01-01',100)");
        const app = express(); app.use(express.json());
        app.use((req, res, next) => { req.user = { id: 901, role: req.headers['x-role'], teamId: 901 }; next(); });
        app.use('/bids', require('../routes/bids'));
        app.use('/po', require('../routes/purchaseOrders'));
        app.use('/files', require('../routes/files'));
        server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await pool.end(); });
    test('financial amounts and invoice contract linkage reject invalid writes', async () => {
        for (const amount of [-100, 'NaN', 'Infinity', '1x', 0]) {
            assert.equal((await request('/po/901', 'PUT', { amount })).status, 400);
            assert.equal((await request('/po/901/invoices', 'POST', { invoice_number: 'Bad', invoice_date: '2026-01-01', amount })).status, 400);
        }
        assert.equal((await request('/po/901/invoices', 'POST', { contract_id: 902, invoice_number: 'Mismatch', invoice_date: '2026-01-01', amount: 10 })).status, 400);
        const good = await request('/po/901/invoices', 'POST', { invoice_number: 'Good', invoice_date: '2026-01-01', amount: 10 });
        assert.equal(good.status, 201); assert.equal(good.data.contract_id, 901);
        assert.equal((await pool.query('SELECT count(*)::int n FROM invoices')).rows[0].n, 1);
    });
    test('bids reject negative amounts and exclude ineligible winners', async () => {
        assert.equal((await request('/bids', 'POST', { file_id: 901, vendor_name_free: 'Invalid', bid_amount: -5 })).status, 400);
        const created = await request('/bids', 'POST', { file_id: 901, vendor_name_free: 'Eligible', bid_amount: 100 });
        assert.equal(created.status, 201);
        const id = created.data.id;
        assert.equal((await request(`/bids/${id}`, 'PUT', { bid_amount: -5 })).status, 400);
        await pool.query('UPDATE bids SET disqualified=TRUE WHERE id=$1', [id]);
        assert.equal((await request(`/bids/${id}/winner`, 'PUT', {}, 'team_leader')).status, 400);
        await pool.query('UPDATE bids SET disqualified=FALSE WHERE id=$1', [id]);
        await pool.query("UPDATE vendors SET status='Blacklisted' WHERE id=$1", [created.data.vendor_id]);
        assert.equal((await request(`/bids/${id}/winner`, 'PUT', {}, 'team_leader')).status, 400);
        assert.equal((await request('/bids/evaluate/901')).data.recommended_winner, null);
        await pool.query("UPDATE vendors SET status='Active' WHERE id=$1", [created.data.vendor_id]);
        assert.equal((await request(`/bids/${id}/winner`, 'PUT', {}, 'team_leader')).status, 200);
        assert.equal((await pool.query('SELECT is_winner FROM bids WHERE id=$1', [id])).rows[0].is_winner, true);
    });
    test('evaluation rejects invalid weights and threshold ranges', async () => {
        const config = { basis_of_selection: 'highest_combined_rating', minimum_points_threshold: 50, technical_weight_percent: 70, price_weight_percent: 30, maximum_technical_points: 100 };
        for (const change of [{ technical_weight_percent: -50, price_weight_percent: 150 }, { minimum_points_threshold: -100 }, { minimum_points_threshold: 101 }, { maximum_technical_points: 'NaN' }, { technical_weight_percent: '70x' }]) {
            assert.equal((await request('/files/901/basis-of-selection', 'PUT', { ...config, ...change }, 'team_leader')).status, 400);
        }
        assert.equal((await request('/files/901/basis-of-selection', 'PUT', config, 'team_leader')).status, 200);
    });
    test('point-based evaluation rejects scores above the configured/default maximum', async () => {
        await pool.query("UPDATE files SET basis_of_selection='lowest_price_per_point', maximum_technical_points=NULL, minimum_points_threshold=0 WHERE id=901");
        await pool.query('UPDATE bids SET technical_score=101, disqualified=FALSE WHERE file_id=901');
        assert.equal((await request('/bids/evaluate/901')).status, 400);
    });
    test('invoice status is team-scoped and paid invoices cannot be reopened', async () => {
        const own = await pool.query("INSERT INTO invoices(contract_id,po_id,invoice_number,invoice_date,amount,status) VALUES(901,901,'OWN-I','2026-01-01',10,'Pending') RETURNING id");
        const other = await pool.query("INSERT INTO invoices(contract_id,po_id,invoice_number,invoice_date,amount,status) VALUES(902,902,'OTHER-I','2026-01-01',10,'Pending') RETURNING id");
        assert.equal((await request(`/po/invoices/${other.rows[0].id}/status`, 'PUT', { status: 'Approved' }, 'team_leader')).status, 403);
        const approved = await request(`/po/invoices/${own.rows[0].id}/status`, 'PUT', { status: 'Approved' }, 'team_leader');
        assert.equal(approved.status, 200, JSON.stringify(approved.data));
        assert.equal((await request(`/po/invoices/${own.rows[0].id}/status`, 'PUT', { status: 'Paid' }, 'team_leader')).status, 200);
        assert.equal((await request(`/po/invoices/${own.rows[0].id}/status`, 'PUT', { status: 'Pending' }, 'team_leader')).status, 409);
        const state = (await pool.query('SELECT status, paid_date FROM invoices WHERE id=$1', [own.rows[0].id])).rows[0];
        assert.equal(state.status, 'Paid');
        assert.ok(state.paid_date);
    });
    test('PO collection requires file ownership', async () => {
        assert.equal((await request('/po?contract_id=902')).status, 403);
        assert.equal((await request('/po?contract_id=901')).status, 200);
    });
}
