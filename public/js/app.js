// ===== Utility =====
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);
function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
const API = '';
let token = localStorage.getItem('token');
let currentUser = null; // { id, email, displayName, role, teamId, teamName, passwordChanged }
let teamLeaderViewScope = 'me';

// ===== Team Toggle Handlers =====
function setupTeamToggles() {
    const switchScope = (scope) => {
        teamLeaderViewScope = scope;
        // Update UI Dashboard
        $('#btnDashTeamMe').classList.toggle('active', scope === 'me');
        $('#btnDashTeamAll').classList.toggle('active', scope === 'all');
        // Update UI Officers
        $('#btnOfficerTeamMe').classList.toggle('active', scope === 'me');
        $('#btnOfficerTeamAll').classList.toggle('active', scope === 'all');

        // Refresh active views
        const activePage = document.querySelector('.page.active');
        const activePageId = activePage ? activePage.id.replace('page', '').toLowerCase() : '';
        if (activePageId === 'dashboard') loadDashboard();
        if (activePageId === 'officers') loadOfficers();
    };

    $('#btnDashTeamMe').addEventListener('click', () => switchScope('me'));
    $('#btnDashTeamAll').addEventListener('click', () => switchScope('all'));
    $('#btnOfficerTeamMe').addEventListener('click', () => switchScope('me'));
    $('#btnOfficerTeamAll').addEventListener('click', () => switchScope('all'));
}

function authHeaders() { return { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }; }

async function api(path, options = {}) {
    const res = await fetch(API + path, { ...options, headers: { ...authHeaders(), ...options.headers } });
    if (res.status === 401) { logout(); return null; }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
}

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function initials(name) {
    if (!name) return 'U';
    return name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
}

function statusChip(status, isOverdue) {
    if (status === 'Completed') return '<span class="badge badge-completed">Completed</span>';
    if (status === 'Cancelled') return '<span class="badge badge-cancelled">Cancelled</span>';
    if (isOverdue) return '<span class="badge badge-overdue">Overdue</span>';
    return '<span class="badge badge-active">Active</span>';
}

function timeAgo(dateString) {
    if (!dateString) return '';
    const past = new Date(dateString);
    const now = new Date();
    const diffDays = Math.floor((now - past) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 0) return `In ${Math.abs(diffDays)} days`;
    return `${diffDays} days ago`;
}

// ===== Auth =====
function logout() {
    token = null;
    currentUser = null;
    localStorage.removeItem('token');
    showLogin();
}

function showLogin() {
    $('#loginScreen').classList.add('active');
    document.body.classList.remove('authenticated');
}

async function showApp(userData) {
    currentUser = userData;
    token = localStorage.getItem('token');
    $('#loginScreen').classList.remove('active');
    document.body.classList.add('authenticated');

    console.log('showApp called with user:', currentUser);

    // Update user UI
    const initials = currentUser.displayName.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
    const roleLbl = { admin: 'App Admin', team_leader: 'Team Leader', officer: 'Officer' }[currentUser.role] || currentUser.role;
    $('#sidebarAvatar').textContent = initials;
    $('#sidebarUserName').textContent = currentUser.displayName;
    $('#sidebarUserRole').textContent = roleLbl;
    $('#headerAvatar').textContent = initials;
    $('#dropdownName').textContent = currentUser.displayName;
    $('#dropdownRole').textContent = roleLbl;

    // Role-based nav visibility
    applyRoleVisibility();

    // Initialize Team Leader View Toggles
    if (currentUser.role === 'team_leader') setupTeamToggles();

    // Navigate to first visible page
    const visibleNavs = [...$$('.nav-item')].filter(el => el.style.display !== 'none');
    console.log('Visible nav items:', visibleNavs.map(el => el.dataset.page));

    if (visibleNavs.length > 0) {
        console.log('Navigating to first visible page:', visibleNavs[0].dataset.page);
        navigateTo(visibleNavs[0].dataset.page);
    } else {
        console.warn('No visible nav items found for role:', currentUser.role);
    }

    // Check forced password change
    console.log('Password changed?', currentUser.passwordChanged);
    if (currentUser.passwordChanged === false) { // Explicit check
        console.log('Forcing password change...');
        forcePasswordChange();
    }
}

function applyRoleVisibility() {
    console.log('Applying role visibility for:', currentUser.role);
    $$('[data-roles]').forEach(el => {
        const roles = el.dataset.roles.split(' ');
        const isVisible = roles.includes(currentUser.role);
        el.style.display = isVisible ? '' : 'none';
        // console.log(`Element ${el.tagName}.${el.className} [data-roles="${el.dataset.roles}"] -> ${isVisible ? 'VISIBLE' : 'HIDDEN'}`);
    });
}

// ===== Login Form =====
const loginForm = $('#formLogin');
console.log('Login form found:', loginForm);

if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        console.log('Login submitted');
        const email = $('#loginEmail').value.trim();
        const password = $('#loginPassword').value;
        const errDiv = $('#loginError');

        if (!errDiv) {
            console.error('Login error div not found!');
            alert('Internal Error: Missing UI element #loginError');
            return;
        }

        errDiv.style.display = 'none';
        const btn = $('#loginBtn');
        btn.disabled = true;
        btn.textContent = 'Signing in...';

        try {
            console.log('Sending login request for:', email);
            const res = await fetch(API + '/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });

            const data = await res.json();
            console.log('Login response:', res.status, data);

            if (!res.ok) {
                errDiv.textContent = data.error || 'Login failed';
                errDiv.style.display = 'block';
                btn.disabled = false;
                btn.textContent = 'Sign In';
                return;
            }

            token = data.token;
            localStorage.setItem('token', token);
            console.log('Login successful, calling showApp');

            // IMPORTANT: await showApp so errors are caught by catch block
            try {
                await showApp(data.user);
            } catch (uiErr) {
                console.error('showApp failed:', uiErr);
                throw new Error('UI Initialization Failed: ' + uiErr.message);
            }
        } catch (err) {
            console.error('Login error:', err);
            errDiv.textContent = 'Error: ' + err.message;
            errDiv.style.display = 'block';
            btn.disabled = false;
            btn.textContent = 'Sign In';

            // If internal error, show alert too
            if (err.message.includes('UI Initialization Failed')) {
                alert('Login successful but UI crashed. Check console logs.');
            }
        }
    });
} else {
    console.error('Login Form #formLogin not found in DOM');
}

// ===== Init on load =====
async function init() {
    if (!token) { showLogin(); return; }
    try {
        const me = await api('/api/auth/me');
        if (!me) return;
        showApp(me);
    } catch {
        logout();
    }
}

// ===== Navigation =====
const pageTitles = {
    dashboard: 'Dashboard',
    triage: 'File Triage',
    files: 'Procurement Files',
    officers: 'Contracting Officers',
    notifications: 'Notifications',
    admin: 'Administration'
};

function navigateTo(page) {
    $$('.page').forEach(p => p.classList.remove('active'));
    $$('.nav-item').forEach(n => n.classList.remove('active'));
    const pageEl = $(`#page${page.charAt(0).toUpperCase() + page.slice(1)}`);
    const navEl = $(`.nav-item[data-page="${page}"]`);
    if (pageEl) pageEl.classList.add('active');
    if (navEl) navEl.classList.add('active');
    if (page === 'dashboard' && currentUser) {
        const roleLbl = { admin: 'Admin', team_leader: 'Team Leader', officer: 'Officer' }[currentUser.role] || currentUser.role;
        $('#pageTitle').innerHTML = `Dashboard <span class="title-role-badge">${roleLbl}</span>`;
    } else {
        $('#pageTitle').textContent = pageTitles[page] || page;
    }

    // Load page data
    if (page === 'dashboard') loadDashboard();
    else if (page === 'triage') loadTriage();
    else if (page === 'files') loadFiles();
    else if (page === 'officers') loadOfficers();
    else if (page === 'notifications') loadNotifications();
    else if (page === 'admin') loadAdmin();
}

$$('.nav-item').forEach(item => {
    item.addEventListener('click', () => navigateTo(item.dataset.page));
});

// ===== Modal =====
function openModal(id) {
    console.log('openModal called for:', id);
    const els = $$('.modal');
    console.log(`Found ${els.length} modals to hide`);
    els.forEach(m => m.style.display = 'none');

    const target = $(`#${id}`);
    if (target) {
        console.log('Showing target modal:', id);
        target.style.display = 'block';
    } else {
        console.error('Target modal not found:', id);
        alert('Internal Error: Modal ' + id + ' not found');
        return;
    }

    console.log('Activating overlay');
    const overlay = $('#modalOverlay');
    if (overlay) {
        overlay.classList.add('active');
    } else {
        console.error('Overlay not found!');
        alert('Internal Error: Overlay not found');
    }
}

function closeModal() {
    if ($('#modalOverlay').classList.contains('locked')) return;
    $('#modalOverlay').classList.remove('active');
    $$('.modal').forEach(m => m.style.display = 'none');
}

$$('[data-close]').forEach(btn => btn.addEventListener('click', closeModal));
$('#modalOverlay').addEventListener('click', (e) => {
    if (e.target === $('#modalOverlay')) closeModal();
});

function escHtml(str) {
    const p = document.createElement('p');
    p.textContent = str;
    return p.innerHTML;
}

function adjustForWeekend(date) {
    const d = new Date(date);
    const day = d.getDay();
    if (day === 6) d.setDate(d.getDate() + 2); // Saturday -> Monday
    else if (day === 0) d.setDate(d.getDate() + 1); // Sunday -> Monday
    return d;
}

// ===== Toast =====
function showToast(msg, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = msg;
    $('#toastContainer').appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3500);
}

// ===== Notification Badge =====
async function updateNotifBadge() {
    try {
        const data = await api('/api/notifications/count');
        if (!data) return;
        const c = parseInt(data.count);
        const badge = $('#headerNotifBadge');
        const navBadge = $('#navNotifBadge');
        if (c > 0) {
            badge.textContent = c;
            badge.style.display = '';
            navBadge.textContent = c;
            navBadge.style.display = '';
        } else {
            badge.style.display = 'none';
            navBadge.style.display = 'none';
        }
    } catch { }
}

// ===== Dashboard =====
async function loadDashboard() {
    try {
        const url = '/api/files/stats/summary' + (currentUser.role === 'team_leader' && teamLeaderViewScope === 'me' ? '?team_id=me' : '');
        const stats = await api(url);
        if (!stats) return;
        $('#statTotal').textContent = stats.total_files || 0;
        $('#statActive').textContent = stats.active_files || 0;
        $('#statOverdue').textContent = stats.overdue_files || 0;
        $('#statCompleted').textContent = stats.completed_files || 0;

        // Triage stats for team_leader dashboard card
        if (currentUser.role === 'team_leader') {
            try {
                const ts = await api('/api/triage/stats');
                if (ts) {
                    const pending = (parseInt(ts.triaged) || 0) + (parseInt(ts.missing_docs) || 0);
                    $('#statPendingTriage').textContent = pending;
                    const missingEl = $('#statTriageMissing');
                    if (parseInt(ts.missing_docs) > 0) {
                        missingEl.textContent = `${ts.missing_docs} missing docs`;
                    } else {
                        missingEl.textContent = '';
                    }
                }
            } catch (e) { /* triage stats optional */ }
        }

        // Officer chart (only for team_leader)
        const chart = $('#officerChart');
        if (stats.by_officer && stats.by_officer.length > 0) {
            const max = Math.max(...stats.by_officer.map(o => parseInt(o.active_count) || 0));
            chart.innerHTML = stats.by_officer.map(o => {
                const count = parseInt(o.active_count) || 0;
                const width = max ? (count / max * 100) : 0;
                return `
                <div class="officer-bar">
                    <div class="officer-bar-info">
                        <div class="officer-bar-avatar">${initials(o.officer_name)}</div>
                        <span class="officer-bar-name">${escHtml(o.officer_name)}</span>
                    </div>
                    <div class="officer-bar-track">
                        <div class="officer-bar-fill" style="width:${width}%">
                            <span class="officer-bar-inner-label">${count}</span>
                        </div>
                    </div>
                    <span class="officer-bar-detail">${count} active</span>
                </div>
                `;
            }).join('');
        } else {
            chart.innerHTML = '<p class="empty-hint">No officer data</p>';
        }

        // Process chart
        const pChart = $('#processChart');
        if (stats.by_process && stats.by_process.length > 0) {
            const total = stats.by_process.reduce((sum, p) => sum + parseInt(p.file_count), 0);
            const pMax = Math.max(...stats.by_process.map(p => parseInt(p.file_count)));

            pChart.innerHTML = stats.by_process.map(p => {
                const count = parseInt(p.file_count);
                const activeCount = parseInt(p.active_count) || 0;
                const pct = total ? Math.round((count / total) * 100) : 0;
                const width = pMax ? (count / pMax * 100) : 0;
                return `
                <div class="process-bar">
                    <div class="process-bar-header">
                        <span class="process-bar-badge process-${p.process_name}">${p.process_name.replace(/_/g, ' ')}</span>
                    </div>
                    <div class="process-bar-track">
                        <div class="process-bar-fill process-${p.process_name}" style="width:${width}%">
                            <span class="process-bar-pct">${pct}%</span>
                        </div>
                    </div>
                    <div class="process-bar-footer">
                        <span>${count} files</span>
                        <span>${activeCount} active</span>
                    </div>
                </div>
                `;
            }).join('');
        } else {
            pChart.innerHTML = '<p class="empty-hint">No data</p>';
        }

        // Upcoming deadlines
        const deadlines = $('#upcomingDeadlines');
        if (stats.upcoming_deadlines && stats.upcoming_deadlines.length > 0) {
            deadlines.innerHTML = stats.upcoming_deadlines.map(d => {
                const startStr = d.step_started_at.includes('T') ? d.step_started_at : `${d.step_started_at}T12:00:00`;
                let deadline = new Date(startStr);
                deadline.setDate(deadline.getDate() + d.sla_days);
                deadline = adjustForWeekend(deadline);
                const now = new Date();
                const daysLeft = Math.ceil((deadline - now) / 86400000);

                let statusClass = 'deadline-safe';
                let labelText = `${daysLeft} DAYS REMAINING`;
                if (daysLeft < 0) {
                    statusClass = 'deadline-overdue';
                    labelText = `${Math.abs(daysLeft)} DAYS OVERDUE`;
                } else if (daysLeft <= 2) {
                    statusClass = 'deadline-critical';
                } else if (daysLeft <= 5) {
                    statusClass = 'deadline-warning';
                }

                return `
                <div class="deadline-item ${statusClass}">
                    <div class="deadline-left">
                        <div class="deadline-urgency">
                            <div class="deadline-dot"></div>
                            <span class="deadline-days">${labelText}</span>
                        </div>
                        <div class="deadline-pr">${d.pr_number}</div>
                        <div class="deadline-meta">${escHtml(d.step_name)} · ${escHtml(d.officer_name)}</div>
                    </div>
                    <div class="deadline-right">
                        <div class="deadline-date">${deadline.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
                    </div>
                </div>`;
            }).join('');
        } else {
            deadlines.innerHTML = '<p class="empty-hint">No upcoming deadlines</p>';
        }

        // Recent files
        const recent = $('#recentFiles');
        const files = await api('/api/files?status=Active');
        if (files && files.length > 0) {
            recent.innerHTML = files.slice(0, 5).map(f => `
                <div class="recent-file-item" style="cursor:pointer" onclick="viewFileDetail(${f.id})">
                    <div class="recent-file-left">
                        <div class="recent-file-avatar">${initials(f.officer_name)}</div>
                        <div class="recent-file-info">
                            <div class="recent-file-pr">${f.pr_number}</div>
                            <div class="recent-file-title">${escHtml(f.title)}</div>
                        </div>
                    </div>
                    <div class="recent-file-right">
                        <span class="process-tag process-${f.process_name}">${f.process_name.replace(/_/g, ' ')}</span>
                        ${statusChip(f.status, f.is_overdue)}
                    </div>
                </div>
            `).join('');
        } else {
            recent.innerHTML = '<p class="empty-hint">No active files</p>';
        }

        updateNotifBadge();
    } catch (err) {
        console.error('Dashboard error:', err);
    }
}

// ===== Files =====
let allOfficers = [];
let allProcesses = [];

async function loadFiles() {
    try {
        // Load officer filter
        if (currentUser.role === 'team_leader') {
            allOfficers = await api('/api/officers') || [];
            const sel = $('#filterOfficer');
            sel.innerHTML = '<option value="team_me">My Team</option>' +
                '<option value="">All Officers</option>' +
                allOfficers.map(o => `<option value="${o.id}">${o.name}${o.team_name ? ' (' + o.team_name + ')' : ''}</option>`).join('');
        }

        // Load process filter
        allProcesses = await api('/api/processes') || [];
        const pSel = $('#filterProcess');
        pSel.innerHTML = '<option value="">All Processes</option>' +
            allProcesses.map(p => `<option value="${p.name}">${p.name.replace(/_/g, ' ')}</option>`).join('');

        await refreshFilesTable();
    } catch (err) {
        console.error('Files load error:', err);
    }
}

async function refreshFilesTable() {
    const params = new URLSearchParams();
    const officer = $('#filterOfficer').value;
    const process = $('#filterProcess').value;
    const status = $('#filterStatus').value;

    if (officer === 'team_me' && currentUser.role === 'team_leader') {
        params.set('team_id', 'me');
    } else if (officer && officer !== 'team_me') {
        params.set('officer_id', officer);
    }

    if (process) params.set('process_name', process);
    if (status) params.set('status', status);

    const files = await api(`/api/files?${params}`);
    if (!files) return;

    const tbody = $('#filesBody');
    const empty = $('#filesEmpty');
    if (files.length === 0) {
        tbody.innerHTML = '';
        empty.style.display = 'flex';
        return;
    }
    empty.style.display = 'none';

    tbody.innerHTML = files.map(f => {
        const rowCls = f.status === 'Completed' ? 'row-completed' : f.status === 'Cancelled' ? 'row-cancelled' : f.is_overdue ? 'row-overdue' : 'row-active';
        const statusDotCls = f.status === 'Completed' ? 'status-dot-completed' : f.status === 'Cancelled' ? 'status-dot-cancelled' : f.is_overdue ? 'status-dot-overdue' : 'status-dot-active';
        const statusLbl = f.status === 'Completed' ? 'Completed' : f.status === 'Cancelled' ? 'Cancelled' : f.is_overdue ? 'Overdue' : 'Active';
        const canAdvance = currentUser.role === 'team_leader' && f.status === 'Active';

        const dateObj = new Date(f.created_at);
        const dateStr = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
        const relTime = timeAgo(f.created_at);

        const progressPct = f.total_steps ? Math.round((f.step_order / f.total_steps) * 100) : 0;

        let dueDateHtml = '<span style="color:var(--text-muted)">—</span>';
        if (f.status === 'Active' && f.step_due_date) {
            const dueObj = new Date(f.step_due_date);
            const dueStr = dueObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            const dueRel = timeAgo(f.step_due_date);
            const dueColor = f.is_overdue ? 'var(--danger)' : 'var(--text-muted)';
            const fw = f.is_overdue ? '600' : 'normal';
            dueDateHtml = `
            <div class="date-cell">
                <div class="date-main">${dueStr}</div>
                <div class="date-sub" style="color: ${dueColor}; font-weight: ${fw}">${dueRel}</div>
            </div>`;
        } else if (f.status === 'Completed') {
            dueDateHtml = '<span style="color:var(--text-muted)">Completed</span>';
        } else if (f.status === 'Cancelled') {
            dueDateHtml = '<span style="color:var(--text-muted)">Cancelled</span>';
        }

        return `<tr class="${rowCls}">
            <td><span class="pr-number">${f.pr_number}</span></td>
            <td><div class="file-title-cell">${escHtml(f.title)}</div></td>
            <td><span class="process-tag process-${f.process_name}">${f.process_name.replace(/_/g, ' ')}</span></td>
            <td>
                <div class="officer-identity">
                    <div class="officer-avatar-sm">${initials(f.officer_name)}</div>
                    <span>${escHtml(f.officer_name)}</span>
                </div>
            </td>
            <td>
                <div class="date-cell">
                    <div class="date-main">${dateStr}</div>
                    <div class="date-sub">${relTime}</div>
                </div>
            </td>
            <td>
                <div class="step-cell">
                    <div class="step-name">${escHtml(f.current_step_name) || '—'}</div>
                    <div class="step-progress-wrapper">
                        <div class="step-progress-bar" style="width: ${progressPct}%"></div>
                    </div>
                    <div class="step-count">${f.step_order || 0}/${f.total_steps || 0}</div>
                </div>
            </td>
            <td>${dueDateHtml}</td>
            <td>
                <div class="status-indicator">
                    <div class="status-dot ${statusDotCls}"></div>
                    <span>${statusLbl}</span>
                </div>
            </td>
            <td>
                <div class="btn-action-group">
                    <button class="btn-action btn-view" onclick="viewFileDetail(${f.id})">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                        View
                    </button>
                    ${canAdvance ? `<button class="btn-action btn-advance" onclick="advanceFile(${f.id})">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
                        Advance
                    </button>` : ''}
                </div>
            </td>
        </tr>`;
    }).join('');
}

// File detail
async function viewFileDetail(id) {
    try {
        const f = await api(`/api/files/${id}`);
        if (!f) return;

        $('#detailTitle').innerHTML = `<span class="pr-accent">${f.pr_number}</span> &mdash; ${escHtml(f.title)}`;

        const statusDotCls = f.status === 'Completed' ? 'status-dot-completed' : f.status === 'Cancelled' ? 'status-dot-cancelled' : f.is_overdue ? 'status-dot-overdue' : 'status-dot-active';
        const statusLbl = f.status === 'Completed' ? 'Completed' : f.status === 'Cancelled' ? 'Cancelled' : f.is_overdue ? 'Overdue' : 'Active';
        const dateStr = new Date(f.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

        let html = `
        <div class="modal-meta-grid">
            <div class="meta-box">
                <span class="meta-label">PR NUMBER</span>
                <span class="meta-value">${f.pr_number}</span>
            </div>
            <div class="meta-box">
                <span class="meta-label">PROCESS</span>
                <span class="meta-value">${f.process_name.replace(/_/g, ' ')}</span>
            </div>
            <div class="meta-box">
                <span class="meta-label">OFFICER</span>
                <span class="meta-value">${escHtml(f.officer_name)}</span>
            </div>
            <div class="meta-box">
                <span class="meta-label">STATUS</span>
                <span class="meta-value">
                    <div class="status-indicator" style="background: rgba(255,255,255,0.05); padding: 4px 8px; border-radius: 4px;">
                        <div class="status-dot ${statusDotCls}"></div>
                        <span>${statusLbl}</span>
                    </div>
                </span>
            </div>
            <div class="meta-box">
                <span class="meta-label">CREATED</span>
                <span class="meta-value">${dateStr}</span>
            </div>
            <div class="meta-box">
                <span class="meta-label">CURRENT STEP</span>
                <span class="meta-value">${escHtml(f.current_step_name) || 'None'}</span>
            </div>
        </div>
        
        <h3 class="timeline-title">Step Timeline</h3>
        <div class="timeline-vertical">`;

        let canAdvanceCurrent = false;

        for (const step of f.steps) {
            const log = f.step_log.find(l => l.step_id === step.id);
            let stateCls = 'timeline-pending';
            let dateInfo = '';

            if (log && log.completed_at) {
                stateCls = 'timeline-completed';
                const sDate = new Date(log.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                const dDate = new Date(log.completed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                dateInfo = `Started: ${sDate} &nbsp; Done: ${dDate}`;
            } else if (log && !log.completed_at) {
                stateCls = 'timeline-active';
                const sDate = new Date(log.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                dateInfo = `Started: ${sDate} &nbsp; <span class="${f.is_overdue ? 'text-danger' : 'text-accent'}">${f.is_overdue ? 'Overdue' : 'In Progress'}</span>`;
                if (currentUser.role === 'team_leader') canAdvanceCurrent = true;
            }

            let commentHtml = '';
            if (log) {
                const isTeamLeader = currentUser.role === 'team_leader';
                commentHtml = `
                <div class="timeline-comment-box">
                    <div class="comment-icon">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg> 
                        COMMENT
                    </div>
                    <textarea class="comment-input" placeholder="${isTeamLeader ? 'Add a comment about SLA status...' : 'No comment provided.'}" id="stepComment_${log.id}" ${!isTeamLeader ? 'readonly' : ''}>${log.comment || ''}</textarea>
                    ${isTeamLeader ? `<button class="btn-save-comment" onclick="saveStepComment(${f.id}, ${log.id})">Save Comment</button>` : ''}
                </div>`;
            }

            html += `
            <div class="timeline-item ${stateCls}">
                <div class="timeline-dot"></div>
                <div class="timeline-content">
                    <div class="timeline-header">
                        <span class="step-name">${escHtml(step.step_name)}</span>
                    </div>
                    <div class="timeline-meta">
                        <span>SLA: ${step.sla_days} days</span>
                        <span>Cumulative: ${step.cum_days} days</span>
                        <span class="timeline-dates">${dateInfo}</span>
                    </div>
                    ${commentHtml}
                </div>
            </div>`;
        }

        html += `</div>`;

        if (canAdvanceCurrent) {
            html += `
            <div class="modal-advance-area">
                <button class="btn btn-primary btn-full" onclick="advanceFile(${f.id})">Advance to Next Step</button>
            </div>`;
        }
        if (currentUser.role === 'team_leader' && f.status === 'Active') {
            html += `
            <div class="modal-advance-area" style="margin-top: 10px;">
                <button class="btn btn-danger btn-full" onclick="cancelFile(${f.id})">Cancel File</button>
            </div>`;
        }

        $('#detailBody').innerHTML = html;
        openModal('modalFileDetail');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function saveStepComment(fileId, logId) {
    const input = $(`#stepComment_${logId}`);
    try {
        await api(`/api/files/${fileId}/steps/${logId}/comment`, {
            method: 'PUT', body: JSON.stringify({ comment: input.value })
        });
        showToast('Comment saved');
        viewFileDetail(fileId);
    } catch (err) { showToast(err.message, 'error'); }
}

async function advanceFile(id) {
    try {
        await api(`/api/files/${id}/advance`, { method: 'PUT', body: JSON.stringify({}) });
        showToast('File advanced to next step');
        closeModal();
        refreshFilesTable();
    } catch (err) { showToast(err.message, 'error'); }
}

async function cancelFile(id) {
    const reason = prompt("Enter cancellation reason:");
    if (!reason || !reason.trim()) {
        showToast('Cancellation requires a reason', 'info');
        return;
    }
    try {
        await api(`/api/files/${id}/cancel`, { method: 'PUT', body: JSON.stringify({ reason: reason.trim() }) });
        showToast('File cancelled successfully');
        closeModal();
        refreshFilesTable();
        // Since dashboard metrics may have changed
        const activePage = document.querySelector('.page.active');
        const activePageId = activePage ? activePage.id.replace('page', '').toLowerCase() : '';
        if (activePageId === 'dashboard') loadDashboard();
    } catch (err) { showToast(err.message, 'error'); }
}

// Event: filter changes
['filterOfficer', 'filterProcess', 'filterStatus'].forEach(id => {
    $(`#${id}`).addEventListener('change', refreshFilesTable);
});

// New file button
$('#btnNewFile').addEventListener('click', async () => {
    // Populate process select
    const procs = await api('/api/processes');
    const pSel = $('#inputProcess');
    pSel.innerHTML = procs.map(p => `<option value="${p.name}">${p.name.replace(/_/g, ' ')}</option>`).join('');

    // Populate officer select
    const officers = await api('/api/officers');
    const oSel = $('#inputOfficer');
    oSel.innerHTML = officers.map(o => `<option value="${o.id}">${o.name}${o.team_name ? ' (' + o.team_name + ')' : ''}</option>`).join('');

    // Populate step select based on process
    async function updateSteps() {
        const pName = pSel.value;
        const steps = procs.find(p => p.name === pName);
        if (pName) {
            const stepsData = await api(`/api/processes/${pName}/steps`);
            const sSel = $('#inputCurrentStep');
            sSel.innerHTML = '<option value="">Step 1 (start from beginning)</option>' +
                stepsData.filter(s => s.step_name !== 'Completed').map(s =>
                    `<option value="${s.step_order}">Step ${s.step_order}: ${s.step_name}</option>`
                ).join('');
        }
    }
    pSel.addEventListener('change', updateSteps);
    updateSteps();

    openModal('modalNewFile');
});

// Submit new file
$('#formNewFile').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
        await api('/api/files', {
            method: 'POST',
            body: JSON.stringify({
                pr_number: $('#inputPR').value,
                title: $('#inputTitle').value,
                process_name: $('#inputProcess').value,
                officer_id: parseInt($('#inputOfficer').value),
                assigned_date: $('#inputAssignedDate').value || undefined,
                current_step_order: $('#inputCurrentStep').value || undefined
            })
        });
        closeModal();
        e.target.reset();
        showToast('File created');
        refreshFilesTable();
    } catch (err) { showToast(err.message, 'error'); }
});

// ===== Officers =====
async function loadOfficers() {
    try {
        const url = '/api/officers' + (currentUser.role === 'team_leader' && teamLeaderViewScope === 'me' ? '?team_id=me' : '');
        const officers = await api(url);
        if (!officers) return;
        const grid = $('#officersGrid');
        const empty = $('#officersEmpty');

        if (officers.length === 0) {
            grid.innerHTML = '';
            empty.style.display = 'flex';
            return;
        }
        empty.style.display = 'none';

        grid.innerHTML = officers.map(o => {
            const initials = o.name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
            return `<div class="officer-card">
                <div class="officer-card-header">
                    <div class="officer-avatar">${initials}</div>
                    <div class="officer-info">
                        <h3>${o.name}</h3>
                        <span class="officer-email">${o.email}</span>
                        ${o.team_name ? `<span class="officer-team">${o.team_name}</span>` : ''}
                    </div>
                </div>
                <div class="officer-stats">
                    <div class="officer-stat">
                        <span class="officer-stat-value">${o.file_count || 0}</span>
                        <span class="officer-stat-label">Total</span>
                    </div>
                    <div class="officer-stat">
                        <span class="officer-stat-value">${o.active_count || 0}</span>
                        <span class="officer-stat-label">Active</span>
                    </div>
                    <div class="officer-stat">
                        <span class="officer-stat-value">${o.completed_count || 0}</span>
                        <span class="officer-stat-label">Done</span>
                    </div>
                </div>
                <div class="officer-card-actions">
                    <button class="btn btn-sm btn-secondary" onclick="openTransfer(${o.id}, '${o.name}')">Transfer</button>
                    ${parseInt(o.file_count) === 0 && currentUser.role === 'team_leader' ? `<button class="btn btn-sm btn-danger" onclick="deleteOfficer(${o.id})">Remove</button>` : ''}
                </div>
            </div>`;
        }).join('');
    } catch (err) {
        console.error('Officers load error:', err);
    }
}

// New Officer
$('#btnNewOfficer').addEventListener('click', () => openModal('modalNewOfficer'));
$('#formNewOfficer').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
        await api('/api/officers', {
            method: 'POST',
            body: JSON.stringify({
                name: $('#inputOfficerName').value,
                email: $('#inputOfficerEmail').value
            })
        });
        closeModal();
        e.target.reset();
        showToast('Officer added');
        loadOfficers();
    } catch (err) { showToast(err.message, 'error'); }
});

async function deleteOfficer(id) {
    if (!confirm('Remove this officer?')) return;
    try {
        await api(`/api/officers/${id}`, { method: 'DELETE' });
        showToast('Officer removed');
        loadOfficers();
    } catch (err) { showToast(err.message, 'error'); }
}

// Transfer
async function openTransfer(officerId, officerName) {
    try {
        const files = await api(`/api/files?officer_id=${officerId}&status=Active`);
        if (!files || files.length === 0) {
            showToast('No active files to transfer', 'info');
            return;
        }
        const officers = await api('/api/officers');
        const otherOfficers = officers.filter(o => o.id !== officerId);

        if (otherOfficers.length === 0) {
            showToast('No other officers available to transfer to', 'info');
            return;
        }

        const total = files.length;

        // Header info
        $('#transferInfo').innerHTML = `
            <p>Select the files you want to transfer from <strong>${escHtml(officerName)}</strong> and choose the target officer for each.</p>
            <div class="transfer-select-all-bar">
                <label class="transfer-select-all-label">
                    <input type="checkbox" id="chkSelectAll" checked> Select / Deselect All
                </label>
                <span class="transfer-count-hint" id="transferCountHint"><span id="transferSelectedCount">${total}</span> of ${total} files selected</span>
            </div>`;

        const officerOptions = otherOfficers.map(o => `<option value="${o.id}">${escHtml(o.name)}${o.team_name ? ' (' + escHtml(o.team_name) + ')' : ''}</option>`).join('');

        $('#transferFileList').innerHTML = files.map(f => `
            <div class="transfer-file-item" data-file-id="${f.id}">
                <label class="transfer-file-check-label">
                    <input type="checkbox" class="transfer-file-chk" checked>
                    <div class="transfer-file-info">
                        <strong>${escHtml(f.pr_number)}</strong> — ${escHtml(f.title)}
                        <span class="transfer-process-tag">${f.process_name.replace(/_/g, ' ')}</span>
                    </div>
                </label>
                <select class="select-input transfer-target">
                    ${officerOptions}
                </select>
            </div>
        `).join('');

        // Update button label to reflect selected count
        function updateConfirmBtn() {
            const checked = [...$$('.transfer-file-chk')].filter(c => c.checked).length;
            $('#transferSelectedCount').textContent = checked;
            const btn = $('#btnConfirmTransfer');
            btn.disabled = checked === 0;
            btn.textContent = checked === 0 ? 'Select at Least One File' : `Transfer ${checked} File${checked !== 1 ? 's' : ''}`;
        }

        // Select / Deselect All
        document.getElementById('chkSelectAll').addEventListener('change', function () {
            $$('.transfer-file-chk').forEach(c => c.checked = this.checked);
            updateConfirmBtn();
        });

        // Individual checkbox change
        $('#transferFileList').addEventListener('change', (e) => {
            if (e.target.classList.contains('transfer-file-chk')) {
                const allChecked = [...$$('.transfer-file-chk')].every(c => c.checked);
                const noneChecked = [...$$('.transfer-file-chk')].every(c => !c.checked);
                const selectAllChk = document.getElementById('chkSelectAll');
                selectAllChk.indeterminate = !allChecked && !noneChecked;
                selectAllChk.checked = allChecked;
                updateConfirmBtn();
            }
        });

        updateConfirmBtn();
        $('#transferOverlay').classList.add('active');

        // Confirm transfer
        $('#btnConfirmTransfer').onclick = async () => {
            const transfers = [...$$('.transfer-file-item')]
                .filter(item => item.querySelector('.transfer-file-chk').checked)
                .map(item => ({
                    file_id: parseInt(item.dataset.fileId),
                    to_officer_id: parseInt(item.querySelector('.transfer-target').value)
                }));

            if (transfers.length === 0) {
                showToast('Please select at least one file to transfer', 'info');
                return;
            }

            try {
                const result = await api(`/api/officers/${officerId}/transfer`, {
                    method: 'PUT', body: JSON.stringify({ transfers })
                });
                $('#transferOverlay').classList.remove('active');
                showToast(`${result.transferred_count} file${result.transferred_count !== 1 ? 's' : ''} transferred successfully`);
                loadOfficers();
            } catch (err) { showToast(err.message, 'error'); }
        };
    } catch (err) { showToast(err.message, 'error'); }
}

$('#btnCloseTransfer').addEventListener('click', () => $('#transferOverlay').classList.remove('active'));
$('#btnCancelTransfer').addEventListener('click', () => $('#transferOverlay').classList.remove('active'));

// ===== Notifications =====
async function loadNotifications() {
    try {
        const notifs = await api('/api/notifications');
        if (!notifs) return;
        const list = $('#notificationsList');
        const empty = $('#notifsEmpty');
        const summary = $('#notifSummaryText');

        if (notifs.length === 0) {
            list.innerHTML = '';
            empty.style.display = 'flex';
            if (summary) summary.textContent = 'All clear! No active alerts.';
            return;
        }
        empty.style.display = 'none';

        const unreadCount = notifs.filter(n => !n.is_read).length;
        if (summary) {
            summary.textContent = unreadCount > 0
                ? `You have ${unreadCount} unread alert${unreadCount === 1 ? '' : 's'}.`
                : 'All alerts caught up.';
        }

        list.innerHTML = notifs.map(n => {
            const isUnread = !n.is_read;
            const isOverdue = n.message.toLowerCase().includes('overdue');
            const statusClass = isOverdue ? 'notif-status-warning' : 'notif-status-info';
            const icon = isOverdue
                ? `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`
                : `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;

            return `
            <div class="notif-card ${isUnread ? 'unread' : ''} ${statusClass}" onclick="markRead(${n.id}, this)">
                <div class="notif-icon-wrap">
                    ${icon}
                </div>
                <div class="notif-details">
                    <div class="notif-message">${escHtml(n.message)}</div>
                    <div class="notif-meta">
                        <div class="notif-time">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                            ${timeAgo(n.created_at)}
                        </div>
                        ${isUnread ? '<div class="unread-dot"></div>' : ''}
                    </div>
                </div>
            </div>
        `;
        }).join('');

        updateNotifBadge();
    } catch (err) {
        console.error('Notifications load error:', err);
    }
}

async function markRead(id, el) {
    try {
        await api(`/api/notifications/${id}/read`, { method: 'PUT' });
        el.classList.remove('unread');
        updateNotifBadge();
    } catch { }
}

$('#btnReadAll').addEventListener('click', async () => {
    try {
        await api('/api/notifications/read-all', { method: 'PUT' });
        showToast('All marked as read');
        loadNotifications();
    } catch (err) { showToast(err.message, 'error'); }
});

// ===== Admin Panel =====
let adminUsers = [];
let adminTeams = [];

async function loadAdmin() {
    await loadAdminUsers();
    await loadAdminTeams();
    await loadAdminProcesses();

    // Populate team filter
    const sel = $('#adminFilterTeam');
    sel.innerHTML = '<option value="">All Teams</option>' +
        adminTeams.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
}

async function loadAdminUsers() {
    try {
        adminUsers = await api('/api/admin/users') || [];
        renderAdminUsers();
    } catch (err) { console.error('Admin users error:', err); }
}

function renderAdminUsers() {
    const roleFilter = $('#adminFilterRole').value;
    const teamFilter = $('#adminFilterTeam').value;
    let filtered = adminUsers;
    if (roleFilter) filtered = filtered.filter(u => u.role === roleFilter);
    if (teamFilter) filtered = filtered.filter(u => String(u.team_id) === teamFilter);

    const tbody = $('#usersBody');
    tbody.innerHTML = filtered.map(u => {
        const roleLbl = { admin: 'Admin', team_leader: 'Team Leader', officer: 'Officer' }[u.role] || u.role;
        const statusCls = u.is_active ? 'badge-active' : 'badge-inactive';
        const statusLbl = u.is_active ? 'Active' : 'Inactive';
        return `<tr>
            <td><strong>${u.display_name}</strong></td>
            <td>${u.email}</td>
            <td><span class="badge badge-role-${u.role}">${roleLbl}</span></td>
            <td>${u.team_name || '—'}</td>
            <td>${u.file_count || 0} (${u.active_count || 0} active)</td>
            <td><span class="badge ${statusCls}">${statusLbl}</span></td>
            <td>
                ${u.role !== 'admin' ? `<button class="btn-icon" title="Edit" onclick="editUser(${u.id})">✏️</button>` : ''}
                ${u.role !== 'admin' ? `<button class="btn-icon" title="Reset password" onclick="resetUserPassword(${u.id}, '${u.display_name.replace(/'/g, "\\'")}')">🔑</button>` : ''}
                ${u.role !== 'admin' && u.is_active ? `<button class="btn-icon" title="Deactivate" onclick="deactivateUser(${u.id})">🚫</button>` : ''}
                ${u.role !== 'admin' && !u.is_active ? `<button class="btn-icon" title="Activate" onclick="activateUser(${u.id})">✅</button>` : ''}
            </td>
        </tr>`;
    }).join('');
}

$('#adminFilterRole').addEventListener('change', renderAdminUsers);
$('#adminFilterTeam').addEventListener('change', renderAdminUsers);

// Admin tabs
$$('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        $$('.admin-tab').forEach(t => t.classList.remove('active'));
        $$('.admin-tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        $(`#adminTab${tab.dataset.adminTab.charAt(0).toUpperCase() + tab.dataset.adminTab.slice(1)}`).classList.add('active');
        // Auto-load email settings when the tab is activated
        if (tab.dataset.adminTab === 'email') loadEmailSettings();
    });
});

// ========================================
// Email Settings Functions
// ========================================

async function loadEmailSettings() {
    try {
        const settings = await api('/api/admin/email-settings');
        if (!settings) return;
        const el = (id) => $(id);
        el('#inputSmtpName').value = settings.smtp_server_name || '';
        el('#inputSmtpHost').value = settings.smtp_host || '';
        el('#inputSmtpPort').value = settings.smtp_port || '';
        el('#inputSmtpUsername').value = settings.smtp_username || '';
        el('#inputSmtpPassword').value = settings.smtp_password || '';
        el('#inputSmtpTls').checked = settings.smtp_ignore_tls === 'true';
        el('#inputSmtpSender').value = settings.smtp_sender || '';
    } catch (err) {
        console.error('Failed to load email settings:', err);
    }
}

$('#formEmailSettings').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#btnSaveEmail');
    const origText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-sm"></span> Saving...';

    try {
        const payload = {
            smtp_server_name: $('#inputSmtpName').value.trim(),
            smtp_host: $('#inputSmtpHost').value.trim(),
            smtp_port: $('#inputSmtpPort').value.trim(),
            smtp_username: $('#inputSmtpUsername').value.trim(),
            smtp_password: $('#inputSmtpPassword').value,
            smtp_ignore_tls: String($('#inputSmtpTls').checked),
            smtp_sender: $('#inputSmtpSender').value.trim()
        };

        const res = await api('/api/admin/email-settings', { method: 'PUT', body: JSON.stringify(payload) });
        if (res && res.success) {
            showToast('Email settings saved successfully!', 'success');
            loadEmailSettings(); // Reload to get masked password
        }
    } catch (err) {
        showToast('Failed to save email settings: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = origText;
    }
});

$('#btnTestEmail').addEventListener('click', async () => {
    const btn = $('#btnTestEmail');
    const origText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-sm"></span> Sending...';

    try {
        const res = await api('/api/admin/email-settings/test', { method: 'POST', body: JSON.stringify({}) });
        if (res && res.success) {
            showToast(res.message || 'Test email sent!', 'success');
        }
    } catch (err) {
        showToast('Test email failed: ' + (err.message || 'Check your SMTP settings'), 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = origText;
    }
});

// Create User
$('#btnNewUser').addEventListener('click', async () => {
    $('#modalUserTitle').textContent = 'Create User';
    $('#btnUserSubmit').textContent = 'Create User';
    $('#editUserId').value = '';
    $('#formUser').reset();
    $('#userPasswordGroup').style.display = '';

    // Populate teams
    const teams = await api('/api/admin/teams') || [];
    $('#inputUserTeam').innerHTML = '<option value="">No team</option>' +
        teams.map(t => `<option value="${t.id}">${t.name}</option>`).join('');

    openModal('modalUser');
});

async function editUser(id) {
    const user = adminUsers.find(u => u.id === id);
    if (!user) return;

    $('#modalUserTitle').textContent = 'Edit User';
    $('#btnUserSubmit').textContent = 'Save Changes';
    $('#editUserId').value = id;
    $('#inputUserName').value = user.display_name;
    $('#inputUserEmail').value = user.email;
    $('#inputUserRole').value = user.role;
    $('#userPasswordGroup').style.display = 'none';

    const teams = await api('/api/admin/teams') || [];
    $('#inputUserTeam').innerHTML = '<option value="">No team</option>' +
        teams.map(t => `<option value="${t.id}" ${t.id === user.team_id ? 'selected' : ''}>${t.name}</option>`).join('');

    openModal('modalUser');
}

$('#formUser').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = $('#editUserId').value;
    const data = {
        email: $('#inputUserEmail').value,
        display_name: $('#inputUserName').value,
        role: $('#inputUserRole').value,
        team_id: $('#inputUserTeam').value ? parseInt($('#inputUserTeam').value) : null
    };
    if (!editId) {
        const pwd = $('#inputUserPassword').value;
        if (pwd) data.password = pwd;
    }

    try {
        if (editId) {
            await api(`/api/admin/users/${editId}`, { method: 'PUT', body: JSON.stringify(data) });
            showToast('User updated');
        } else {
            await api('/api/admin/users', { method: 'POST', body: JSON.stringify(data) });
            showToast('User created');
        }
        closeModal();
        loadAdminUsers();
    } catch (err) { showToast(err.message, 'error'); }
});

function resetUserPassword(id, name) {
    $('#resetUserId').value = id;
    $('#resetUserName').textContent = name;
    $('#formResetPassword').reset();
    openModal('modalResetPassword');
}

$('#formResetPassword').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#resetUserId').value;
    try {
        await api(`/api/admin/users/${id}/reset-password`, {
            method: 'PUT',
            body: JSON.stringify({ password: $('#inputResetPassword').value })
        });
        closeModal();
        showToast('Password reset');
    } catch (err) { showToast(err.message, 'error'); }
});

async function deactivateUser(id) {
    if (!confirm('Deactivate this user?')) return;
    try {
        await api(`/api/admin/users/${id}`, { method: 'DELETE' });
        showToast('User deactivated');
        loadAdminUsers();
    } catch (err) { showToast(err.message, 'error'); }
}

async function activateUser(id) {
    try {
        await api(`/api/admin/users/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: true }) });
        showToast('User activated');
        loadAdminUsers();
    } catch (err) { showToast(err.message, 'error'); }
}

// ===== Teams =====
async function loadAdminTeams() {
    try {
        adminTeams = await api('/api/admin/teams') || [];
        const grid = $('#teamsGrid');
        const empty = $('#teamsEmpty');

        if (adminTeams.length === 0) {
            grid.innerHTML = '';
            empty.style.display = 'flex';
            return;
        }
        empty.style.display = 'none';

        grid.innerHTML = adminTeams.map(t => `
            <div class="officer-card team-card">
                <div class="officer-card-header">
                    <div class="officer-avatar team-avatar">🏢</div>
                    <div class="officer-info">
                        <h3>${t.name}</h3>
                        <span class="officer-email">Created ${new Date(t.created_at).toLocaleDateString()}</span>
                    </div>
                </div>
                <div class="officer-stats">
                    <div class="officer-stat">
                        <span class="officer-stat-value">${t.member_count || 0}</span>
                        <span class="officer-stat-label">Members</span>
                    </div>
                    <div class="officer-stat">
                        <span class="officer-stat-value">${t.leader_count || 0}</span>
                        <span class="officer-stat-label">Leaders</span>
                    </div>
                    <div class="officer-stat">
                        <span class="officer-stat-value">${t.officer_count || 0}</span>
                        <span class="officer-stat-label">Officers</span>
                    </div>
                </div>
                <div class="officer-card-actions">
                    <button class="btn btn-sm btn-secondary" onclick="editTeam(${t.id}, '${t.name.replace(/'/g, "\\'")}')">Edit</button>
                    ${parseInt(t.member_count) === 0 ? `<button class="btn btn-sm btn-danger" onclick="deleteTeam(${t.id})">Delete</button>` : ''}
                </div>
            </div>
        `).join('');
    } catch (err) { console.error('Teams load error:', err); }
}

$('#btnNewTeam').addEventListener('click', () => {
    $('#modalTeamTitle').textContent = 'Create Team';
    $('#btnTeamSubmit').textContent = 'Create Team';
    $('#editTeamId').value = '';
    $('#formTeam').reset();
    openModal('modalTeam');
});

function editTeam(id, name) {
    $('#modalTeamTitle').textContent = 'Edit Team';
    $('#btnTeamSubmit').textContent = 'Save Changes';
    $('#editTeamId').value = id;
    $('#inputTeamName').value = name;
    openModal('modalTeam');
}

$('#formTeam').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = $('#editTeamId').value;
    const body = { name: $('#inputTeamName').value };
    try {
        if (editId) {
            await api(`/api/admin/teams/${editId}`, { method: 'PUT', body: JSON.stringify(body) });
            showToast('Team updated');
        } else {
            await api('/api/admin/teams', { method: 'POST', body: JSON.stringify(body) });
            showToast('Team created');
        }
        closeModal();
        loadAdminTeams();
    } catch (err) { showToast(err.message, 'error'); }
});

async function deleteTeam(id) {
    if (!confirm('Delete this team?')) return;
    try {
        await api(`/api/admin/teams/${id}`, { method: 'DELETE' });
        showToast('Team deleted');
        loadAdminTeams();
    } catch (err) { showToast(err.message, 'error'); }
}

// ===== Admin Processes =====
let adminProcesses = [];
let editProcessStepsData = [];

async function loadAdminProcesses() {
    try {
        adminProcesses = await api('/api/admin/processes') || [];
        const tbody = $('#processesBody');
        tbody.innerHTML = adminProcesses.map(p => `
            <tr>
                <td><strong>${p.name}</strong></td>
                <td>${p.step_count}</td>
                <td>${p.total_sla_days} days</td>
                <td>
                    <button class="btn btn-sm btn-secondary" onclick="openProcessStepsModal('${p.name.replace(/'/g, "\\'")}')">Edit Steps</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteProcess('${p.name.replace(/'/g, "\\'")}')">Delete</button>
                </td>
            </tr>
        `).join('') || `<tr><td colspan="4" class="text-center text-muted" style="padding: 1rem;">No processes found.</td></tr>`;
    } catch (err) { console.error('Processes load error:', err); }
}

$('#btnNewProcess').addEventListener('click', async () => {
    const name = prompt('Enter new process name:');
    if (!name || !name.trim()) return;
    try {
        await api('/api/admin/processes', { method: 'POST', body: JSON.stringify({ name }) });
        showToast('Process created');
        loadAdminProcesses();
    } catch (err) { showToast(err.message, 'error'); }
});

window.deleteProcess = async function (name) {
    if (!confirm(`Are you sure you want to delete the process "${name}"? This will fail if files are using it.`)) return;
    try {
        await api(`/api/admin/processes/${name}`, { method: 'DELETE' });
        showToast('Process deleted');
        loadAdminProcesses();
    } catch (err) { showToast(err.message, 'error'); }
};

// Modal Steps Logic
window.openProcessStepsModal = async function (name) {
    $('#modalProcessTitle').textContent = `Edit Steps: ${name}`;
    $('#editProcessName').value = name;
    try {
        const steps = await api(`/api/admin/processes/${name}/steps`) || [];
        editProcessStepsData = steps.map(s => ({
            id: s.id,
            step_name: s.step_name,
            sla_days: s.sla_days,
            step_order: s.step_order
        }));
        renderProcessStepsList();
        openModal('modalProcessSteps');
    } catch (err) { showToast(err.message, 'error'); }
};

function renderProcessStepsList() {
    const container = $('#processStepsList');
    container.innerHTML = editProcessStepsData.map((step, index) => `
        <div class="step-edit-row" data-index="${index}">
            <div class="step-edit-drag" title="Drag handles (up/down array visually)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="8" x2="20" y2="8"></line><line x1="4" y1="16" x2="20" y2="16"></line></svg>
            </div>
            <div class="step-edit-order">${index + 1}.</div>
            <input type="text" class="text-input step-edit-input" value="${escapeHtml(step.step_name)}" placeholder="Step Name" onchange="updateStepData(${index}, 'step_name', this.value)">
            <input type="number" class="text-input step-edit-sla" value="${step.sla_days}" min="0" title="SLA Days" onchange="updateStepData(${index}, 'sla_days', this.value)">
            <span class="text-muted" style="font-size:0.8rem;">days</span>
            
            <div style="margin-left:auto; display:flex; gap:4px;">
                <button class="btn-step-action" onclick="moveStep(${index}, -1)" ${index === 0 ? 'disabled style="opacity:0.3"' : ''} title="Move Up">▲</button>
                <button class="btn-step-action" onclick="moveStep(${index}, 1)" ${index === editProcessStepsData.length - 1 ? 'disabled style="opacity:0.3"' : ''} title="Move Down">▼</button>
                <button class="btn-step-action danger" onclick="removeStep(${index})" title="Remove Step">✖</button>
            </div>
        </div>
    `).join('') || `<div class="text-center text-muted" style="padding: 20px;">No steps defined yet. Minimum 1 required.</div>`;
}

window.updateStepData = function (index, field, value) {
    if (field === 'sla_days') value = parseInt(value) || 0;
    editProcessStepsData[index][field] = value;
};

window.moveStep = function (index, dir) {
    const newIdx = index + dir;
    if (newIdx < 0 || newIdx >= editProcessStepsData.length) return;
    const temp = editProcessStepsData[index];
    editProcessStepsData[index] = editProcessStepsData[newIdx];
    editProcessStepsData[newIdx] = temp;
    renderProcessStepsList();
};

window.removeStep = function (index) {
    editProcessStepsData.splice(index, 1);
    renderProcessStepsList();
};

$('#btnAddProcessStep').addEventListener('click', () => {
    editProcessStepsData.push({
        id: null,
        step_name: '',
        sla_days: 0,
        step_order: editProcessStepsData.length + 1
    });
    renderProcessStepsList();
});

$('#btnSaveProcessSteps').addEventListener('click', async () => {
    const processName = $('#editProcessName').value;

    const invalid = editProcessStepsData.find(s => !s.step_name.trim());
    if (invalid) return showToast('All steps must have a name', 'error');
    if (editProcessStepsData.length === 0) return showToast('Must have at least one step', 'error');

    try {
        await api(`/api/admin/processes/${processName}/steps`, {
            method: 'PUT',
            body: JSON.stringify({ steps: editProcessStepsData })
        });
        showToast('Process steps updated!');
        closeModal();
        loadAdminProcesses();
    } catch (err) { showToast(err.message, 'error'); }
});

// ===== Triage =====
function triageStatusBadge(status) {
    const cls = {
        'Triaged': 'badge-triaged',
        'Missing Document(s)': 'badge-missing-docs',
        'Assigned': 'badge-assigned',
        'Awarded': 'badge-awarded',
        'Cancelled': 'badge-cancelled'
    }[status] || 'badge-active';
    return `<span class="badge ${cls}">${status}</span>`;
}

function formatCurrency(val) {
    if (!val && val !== 0) return '—';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'CAD' }).format(val);
}

async function loadTriage() {
    try {
        // Load stats
        const stats = await api('/api/triage/stats');
        if (stats) {
            $('#triageStatTriaged').textContent = stats.triaged || 0;
            $('#triageStatMissing').textContent = stats.missing_docs || 0;
            $('#triageStatAssigned').textContent = stats.assigned || 0;
            $('#triageStatAwarded').textContent = stats.awarded || 0;
            $('#triageStatCancelled').textContent = stats.cancelled || 0;
        }
        await refreshTriageTable();
    } catch (err) {
        console.error('Triage load error:', err);
    }
}

async function refreshTriageTable() {
    const params = new URLSearchParams();
    const status = $('#filterTriageStatus').value;
    if (status) params.set('status', status);

    const items = await api(`/api/triage?${params}`);
    if (!items) return;

    const tbody = $('#triageBody');
    const empty = $('#triageEmpty');
    if (items.length === 0) {
        tbody.innerHTML = '';
        empty.style.display = 'flex';
        return;
    }
    empty.style.display = 'none';

    tbody.innerHTML = items.map(t => {
        const dateStr = new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const canAssign = t.status === 'Triaged';
        const canManage = t.status === 'Triaged' || t.status === 'Missing Document(s)';

        return `<tr>
            <td><span class="pr-number">${escHtml(t.pr_number)}</span></td>
            <td><div class="file-title-cell">${escHtml(t.title)}</div></td>
            <td>${escHtml(t.business_owner)}</td>
            <td>${formatCurrency(t.estimated_value)}</td>
            <td>${escHtml(t.team_name || '—')}</td>
            <td>${triageStatusBadge(t.status)}</td>
            <td>
                <div class="date-cell">
                    <div class="date-main">${dateStr}</div>
                    <div class="date-sub">${timeAgo(t.created_at)}</div>
                </div>
            </td>
            <td>
                <div class="btn-action-group">
                    <button class="btn-action btn-view" onclick="viewTriageDetail(${t.id})">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                        View
                    </button>
                    ${canAssign ? `<button class="btn-action btn-advance" onclick="openAssignTriage(${t.id})">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><line x1="19" y1="8" x2="19" y2="14"></line><line x1="22" y1="11" x2="16" y2="11"></line></svg>
                        Assign
                    </button>` : ''}
                    ${canManage ? `<button class="btn-action btn-view" onclick="openMissingDocs(${t.id})" style="color: var(--warning)">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg>
                        Docs
                    </button>` : ''}
                </div>
            </td>
        </tr>`;
    }).join('');
}

$('#filterTriageStatus').addEventListener('change', refreshTriageTable);

// New triage
$('#btnNewTriage').addEventListener('click', () => openModal('modalNewTriage'));
$('#formNewTriage').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
        await api('/api/triage', {
            method: 'POST',
            body: JSON.stringify({
                pr_number: $('#inputTriagePR').value,
                title: $('#inputTriageTitle').value,
                estimated_value: $('#inputTriageValue').value || undefined,
                business_owner: $('#inputTriageOwner').value
            })
        });
        closeModal();
        e.target.reset();
        showToast('Triage file created');
        loadTriage();
    } catch (err) { showToast(err.message, 'error'); }
});

// Triage detail
async function viewTriageDetail(id) {
    try {
        const t = await api(`/api/triage/${id}`);
        if (!t) return;

        $('#triageDetailTitle').innerHTML = `<span class="pr-accent">${escHtml(t.pr_number)}</span> &mdash; ${escHtml(t.title)}`;

        const dateStr = new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

        let html = `
        <div class="modal-meta-grid">
            <div class="meta-box">
                <span class="meta-label">PR NUMBER</span>
                <span class="meta-value">${escHtml(t.pr_number)}</span>
            </div>
            <div class="meta-box">
                <span class="meta-label">TITLE</span>
                <span class="meta-value">${escHtml(t.title)}</span>
            </div>
            <div class="meta-box">
                <span class="meta-label">BUSINESS OWNER</span>
                <span class="meta-value">${escHtml(t.business_owner)}</span>
            </div>
            <div class="meta-box">
                <span class="meta-label">TEAM</span>
                <span class="meta-value">${escHtml(t.team_name || '—')}</span>
            </div>
            <div class="meta-box">
                <span class="meta-label">ESTIMATED VALUE</span>
                <span class="meta-value">${formatCurrency(t.estimated_value)}</span>
            </div>
            <div class="meta-box">
                <span class="meta-label">STATUS</span>
                <span class="meta-value">${triageStatusBadge(t.status)}</span>
            </div>
            <div class="meta-box">
                <span class="meta-label">CREATED</span>
                <span class="meta-value">${dateStr}</span>
            </div>
            <div class="meta-box">
                <span class="meta-label">TRIAGED BY</span>
                <span class="meta-value">${escHtml(t.created_by_name || '—')}</span>
            </div>
        </div>`;

        // Missing documents section
        if (t.missing_docs && t.missing_docs.length > 0) {
            const deadlineStr = t.doc_deadline
                ? new Date(t.doc_deadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                : '—';
            const isOverdue = t.doc_deadline && new Date() > new Date(t.doc_deadline);

            html += `
            <h3 class="timeline-title" style="margin-top:24px;">Missing Documents</h3>
            <div class="missing-docs-deadline">
                <span>Deadline: <strong style="color:${isOverdue ? 'var(--danger)' : 'var(--text)'}">${deadlineStr}</strong></span>
                ${isOverdue ? '<span class="badge badge-cancelled">OVERDUE</span>' : ''}
            </div>
            <div class="missing-docs-list">`;

            for (const doc of t.missing_docs) {
                html += `
                <div class="missing-doc-item ${doc.provided ? 'doc-provided' : 'doc-pending'}">
                    <label class="doc-check-label">
                        <input type="checkbox" ${doc.provided ? 'checked' : ''} onchange="toggleDocProvided(${t.id}, ${doc.id}, this.checked)">
                        <span class="doc-name">${escHtml(doc.document_name)}</span>
                    </label>
                    <button class="btn-icon" onclick="removeDoc(${t.id}, ${doc.id})" title="Remove">✖</button>
                </div>`;
            }
            html += `</div>`;
        }

        // Action buttons
        if (t.status === 'Triaged') {
            const subject = encodeURIComponent(`PR #${t.pr_number} Triaged - ${t.title}`);
            const bodyStr = `Hello ${t.business_owner},\n\nThis is to inform you that your PR #${t.pr_number} for ${t.title} has been received, triaged by Procurement services, and will be assigned to the next available Contracting Officer.\n\nThank you for your patience.`;
            const body = encodeURIComponent(bodyStr);

            html += `
            <div class="modal-advance-area" style="margin-top:24px;">
                <a href="mailto:?subject=${subject}&body=${body}" class="btn btn-secondary btn-full" style="text-align:center; display:block; text-decoration:none; margin-bottom:10px;">Email Business Owner (Triaged)</a>
                <button class="btn btn-primary btn-full" onclick="closeModal(); openAssignTriage(${t.id});">Assign to Officer</button>
            </div>
            <div class="modal-advance-area" style="margin-top:10px;">
                <button class="btn btn-secondary btn-full" onclick="closeModal(); openMissingDocs(${t.id});">Mark Missing Document(s)</button>
            </div>`;
        }
        if (t.status === 'Missing Document(s)') {
            const pendingDocs = t.missing_docs.filter(d => !d.provided).map(d => d.document_name);
            if (pendingDocs.length > 0) {
                const deadlineStr = t.doc_deadline
                    ? new Date(t.doc_deadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                    : 'N/A';

                const subject = encodeURIComponent(`Missing Documents for PR #${t.pr_number} - ${t.title}`);
                const bodyStr = `Hello ${t.business_owner},\n\nThe Procurement Services has received your PR# ${t.pr_number} for ${t.title} in our queue.  Before we are able to triage and assign your file to an available contracting officer, missing forms need to be added to your PR in SAP.\n\nPlease find the link to the Procurement Services landing page, which can help you in identifying requirements for your procurement initiatives:  Contracting process forms <https://intranet.ent.dfo-mpo.ca/cfo-dpf/en/node/2430> .\n\nThe following form(s) are missing from your request and must be attached to the PR in SAP:\n\n${pendingDocs.map(d => '- ' + d).join('\n')}\n\nPlease note that missing document(s) will not be accepted by e-mail and must be attached the PR in SAP.\n\nPlease attach the missing form(s) to the PR no later than ${deadlineStr} . Please advise as soon as the document(s) have been uploaded to SAP so that we may continue to triage your file. (Please note that SAP does not notify procurement when new documents have been uploaded to an existing PR so if you don't advise us, we will be unaware and your file will not be processed.)\n\nShould DFO Procurement Services not receive the missing document(s) within the given timeframe, your PR will have to be cancelled and will be removed from the queue. In exceptional circumstances, additional time may be provided when requested prior to the above deadline.\n\nPlease reach out if you need clarification.\n\nRegards,`;
                const body = encodeURIComponent(bodyStr);

                html += `
                <div class="modal-advance-area" style="margin-top:24px;">
                    <a href="mailto:?subject=${subject}&body=${body}" class="btn btn-primary btn-full" style="text-align:center; display:block; text-decoration:none;">Email Business Owner (Missing Docs)</a>
                </div>`;
            }
        }

        if (t.status === 'Triaged' || t.status === 'Missing Document(s)') {
            html += `
            <div class="modal-advance-area" style="margin-top:10px;">
                <button class="btn btn-danger btn-full" onclick="cancelTriageFile(${t.id})">Cancel File</button>
            </div>`;
        }
        if (t.status === 'Assigned') {
            const officerName = t.assigned_officer_name || '[Officer]';
            const subject = encodeURIComponent(`PR #${t.pr_number} Assigned - ${t.title}`);
            const bodyStr = `Hello ${t.business_owner},\n\nThis is to inform you that your PR #${t.pr_number} for ${t.title} has been assigned to ${officerName} and will be contacting within 48 hours to introduce themselves.\n\nThank you,`;
            const body = encodeURIComponent(bodyStr);

            html += `
            <div class="modal-advance-area" style="margin-top:24px;">
                <a href="mailto:?subject=${subject}&body=${body}" class="btn btn-secondary btn-full" style="text-align:center; display:block; text-decoration:none; margin-bottom:10px;">Email Business Owner (Assigned)</a>
                <button class="btn btn-primary btn-full" onclick="awardTriageFile(${t.id})">Mark as Awarded</button>
            </div>
            <div class="modal-advance-area" style="margin-top:10px;">
                <button class="btn btn-danger btn-full" onclick="cancelTriageFile(${t.id})">Cancel File</button>
            </div>`;
        }

        // Status history timeline
        if (t.status_history && t.status_history.length > 0) {
            html += `<h3 class="timeline-title" style="margin-top:24px;">Status History</h3>
            <div class="triage-timeline">`;
            for (const h of t.status_history) {
                const when = new Date(h.created_at);
                const dateStr = when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                const timeStr = when.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                html += `
                <div class="triage-timeline-item">
                    <div class="triage-timeline-dot"></div>
                    <div class="triage-timeline-content">
                        <div class="triage-timeline-header">
                            ${h.from_status ? `${triageStatusBadge(h.from_status)} <span class="triage-timeline-arrow">\u2192</span>` : ''}
                            ${triageStatusBadge(h.to_status)}
                        </div>
                        <div class="triage-timeline-meta">
                            <span>${dateStr} at ${timeStr}</span>
                            ${h.changed_by_name ? `<span>\u00b7 by ${escHtml(h.changed_by_name)}</span>` : ''}
                        </div>
                        ${h.note ? `<div class="triage-timeline-note">${escHtml(h.note)}</div>` : ''}
                    </div>
                </div>`;
            }
            html += `</div>`;
        }

        $('#triageDetailBody').innerHTML = html;
        openModal('modalTriageDetail');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function toggleDocProvided(triageId, docId, provided) {
    try {
        const result = await api(`/api/triage/${triageId}/missing-docs/${docId}`, {
            method: 'PUT', body: JSON.stringify({ provided })
        });
        if (result && result.all_provided) {
            showToast('All documents provided — status changed to Triaged');
        }
        viewTriageDetail(triageId);
        loadTriage();
    } catch (err) { showToast(err.message, 'error'); }
}

async function removeDoc(triageId, docId) {
    try {
        await api(`/api/triage/${triageId}/missing-docs/${docId}`, { method: 'DELETE' });
        showToast('Document removed');
        viewTriageDetail(triageId);
    } catch (err) { showToast(err.message, 'error'); }
}

async function cancelTriageFile(id) {
    if (!confirm('Are you sure you want to cancel this triage file?')) return;
    try {
        await api(`/api/triage/${id}/status`, {
            method: 'PUT', body: JSON.stringify({ status: 'Cancelled' })
        });
        showToast('Triage file cancelled');
        closeModal();
        loadTriage();
    } catch (err) { showToast(err.message, 'error'); }
}

async function awardTriageFile(id) {
    if (!confirm('Mark this file as Awarded?')) return;
    try {
        await api(`/api/triage/${id}/status`, {
            method: 'PUT', body: JSON.stringify({ status: 'Awarded' })
        });
        showToast('File marked as Awarded');
        closeModal();
        loadTriage();
    } catch (err) { showToast(err.message, 'error'); }
}

// Missing docs modal
function openMissingDocs(triageId) {
    $('#missingDocsTriageId').value = triageId;
    $('#missingDocsInputList').innerHTML = `
        <div class="missing-doc-input-row">
            <input type="text" class="text-input missing-doc-name" placeholder="Document name" required>
            <button type="button" class="btn-icon" onclick="this.parentElement.remove()" title="Remove">✖</button>
        </div>`;
    openModal('modalMissingDocs');
}

$('#btnAddDocInput').addEventListener('click', () => {
    const row = document.createElement('div');
    row.className = 'missing-doc-input-row';
    row.innerHTML = `
        <input type="text" class="text-input missing-doc-name" placeholder="Document name" required>
        <button type="button" class="btn-icon" onclick="this.parentElement.remove()" title="Remove">✖</button>`;
    $('#missingDocsInputList').appendChild(row);
});

$('#btnSubmitMissingDocs').addEventListener('click', async () => {
    const triageId = $('#missingDocsTriageId').value;
    const inputs = $$('#missingDocsInputList .missing-doc-name');
    const documents = [...inputs].map(i => i.value.trim()).filter(v => v);
    if (documents.length === 0) { showToast('Enter at least one document name', 'error'); return; }

    try {
        await api(`/api/triage/${triageId}/missing-docs`, {
            method: 'POST', body: JSON.stringify({ documents })
        });
        closeModal();
        showToast('Missing documents added — deadline set to 7 days');
        loadTriage();
    } catch (err) { showToast(err.message, 'error'); }
});

// Assign triage
async function openAssignTriage(triageId) {
    try {
        const t = await api(`/api/triage/${triageId}`);
        if (!t) return;
        if (t.status !== 'Triaged') { showToast('Only Triaged files can be assigned', 'error'); return; }

        $('#assignTriageId').value = triageId;
        $('#assignTriageInfo').innerHTML = `
            <div class="triage-assign-summary">
                <strong>${escHtml(t.pr_number)}</strong> — ${escHtml(t.title)}<br>
                <span style="color:var(--text-secondary)">Business Owner: ${escHtml(t.business_owner)} · Est. Value: ${formatCurrency(t.estimated_value)}</span>
            </div>`;

        // Populate process select
        const procs = await api('/api/processes');
        $('#assignTriageProcess').innerHTML = procs.map(p =>
            `<option value="${p.name}">${p.name.replace(/_/g, ' ')}</option>`
        ).join('');

        // Populate officer select
        const officers = await api('/api/officers');
        $('#assignTriageOfficer').innerHTML = officers.map(o =>
            `<option value="${o.id}">${o.name}${o.team_name ? ' (' + o.team_name + ')' : ''}</option>`
        ).join('');

        openModal('modalAssignTriage');
    } catch (err) { showToast(err.message, 'error'); }
}

$('#formAssignTriage').addEventListener('submit', async (e) => {
    e.preventDefault();
    const triageId = $('#assignTriageId').value;
    try {
        await api(`/api/triage/${triageId}/assign`, {
            method: 'POST',
            body: JSON.stringify({
                officer_id: parseInt($('#assignTriageOfficer').value),
                process_name: $('#assignTriageProcess').value,
                assigned_date: $('#assignTriageDate').value || undefined
            })
        });
        closeModal();
        e.target.reset();
        showToast('File assigned to officer!');
        loadTriage();
    } catch (err) { showToast(err.message, 'error'); }
});

// ===== SLA Check =====
$('#btnCheckSLA').addEventListener('click', async () => {
    try {
        await api('/api/sla-check', { method: 'POST' });
        showToast('SLA check completed');
        updateNotifBadge();
    } catch (err) { showToast(err.message, 'error'); }
});

// ===== Header & Sidebar =====
$('#btnHamburger').addEventListener('click', () => {
    $('#sidebar').classList.toggle('open');
});

// Close sidebar on nav click (mobile)
$$('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
        if (window.innerWidth <= 768) $('#sidebar').classList.remove('open');
    });
});

// Header notification bell
$('#btnHeaderNotif').addEventListener('click', () => navigateTo('notifications'));

// User dropdown
function setupUserMenu() {
    const trigger = $('#btnUserMenu');
    const dropdown = $('#userDropdown');

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.toggle('active');
    });
    document.addEventListener('click', () => dropdown.classList.remove('active'));

    // Change password
    $('#btnChangePassword').addEventListener('click', () => {
        dropdown.classList.remove('active');
        openModal('modalChangePassword');
    });

    // Logout
    $('#btnLogout').addEventListener('click', () => {
        dropdown.classList.remove('active');
        logout();
        showToast('Signed out successfully', 'info');
    });
}

// ===== Change Password =====
$('#formChangePassword').addEventListener('submit', async (e) => {
    e.preventDefault();
    const newPwd = $('#inputNewPassword').value;
    const confirm = $('#inputConfirmPassword').value;
    if (newPwd !== confirm) { showToast('Passwords do not match', 'error'); return; }

    try {
        await api('/api/auth/password', {
            method: 'PUT',
            body: JSON.stringify({
                currentPassword: $('#inputCurrentPassword').value,
                newPassword: newPwd
            })
        });

        // Remove forced password change lock
        $('#modalOverlay').classList.remove('locked');
        const modal = $('#modalChangePassword');
        const hClose = modal.querySelector('.btn-close');
        if (hClose) hClose.style.display = '';
        const cancel = modal.querySelector('.modal-footer .btn-secondary');
        if (cancel) cancel.style.display = '';
        const msg = modal.querySelector('.force-msg');
        if (msg) msg.remove();

        closeModal();
        e.target.reset();
        currentUser.passwordChanged = true;
        showToast('Password updated');
    } catch (err) { showToast(err.message, 'error'); }
});

// ===== Force Password Change =====
function forcePasswordChange() {
    console.log('forcePasswordChange called');
    const modalId = 'modalChangePassword';
    const modal = $('#' + modalId);
    console.log('Modal element:', modal);

    if (!modal) {
        console.error('CRITICAL: modalChangePassword not found in DOM');
        alert('Error: Password change modal missing');
        return;
    }

    try {
        console.log('Opening modal via openModal...');
        openModal(modalId);
        console.log('Modal opened (style.display set to block)');

        const headerClose = modal.querySelector('.btn-close');
        if (headerClose) headerClose.style.display = 'none';

        const cancelBtn = modal.querySelector('.modal-footer .btn-secondary');
        if (cancelBtn) cancelBtn.style.display = 'none';

        let msg = modal.querySelector('.force-msg');
        if (!msg) {
            console.log('Creating force-msg');
            msg = document.createElement('div');
            msg.className = 'force-msg';
            msg.style.cssText = 'background: var(--warning-bg, #fff3cd); color: var(--warning-text, #856404); padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 0.9rem;';
            msg.innerHTML = '⚠️ <strong>Password change required.</strong> Please set a new password to continue.';
            const form = modal.querySelector('.modal-body');
            if (form) form.insertBefore(msg, form.firstChild);
        }

        console.log('Adding locked class to overlay');
        $('#modalOverlay').classList.add('locked');
        console.log('forcePasswordChange complete');
    } catch (e) {
        console.error('forcePasswordChange crashed:', e);
        alert('Error in forcePasswordChange: ' + e.message);
    }
}

// ===== Admin styles badge CSS classes =====
// Injected dynamically
const adminStyle = document.createElement('style');
adminStyle.textContent = `
            .admin - tabs { display: flex; gap: 0; border - bottom: 2px solid var(--border); margin - bottom: 24px; }
    .admin - tab { padding: 12px 24px; background: none; border: none; font - size: 0.95rem; font - weight: 500; color: var(--text - secondary); cursor: pointer; border - bottom: 2px solid transparent; margin - bottom: -2px; transition: all 0.2s; }
    .admin - tab.active { color: var(--primary); border - bottom - color: var(--primary); }
    .admin - tab:hover { color: var(--text); }
    .admin - tab - content { display: none; }
    .admin - tab - content.active { display: block; }
    .badge - role - admin { background: linear - gradient(135deg, #667eea, #764ba2); color: #fff; }
    .badge - role - team_leader { background: linear - gradient(135deg, #11998e, #38ef7d); color: #fff; }
    .badge - role - officer { background: linear - gradient(135deg, #4facfe, #00f2fe); color: #fff; }
    .badge - inactive { background: var(--bg - secondary); color: var(--text - secondary); }
    .team - avatar { font - size: 1.4rem; display: flex; align - items: center; justify - content: center; }
    .officer - team { display: block; font - size: 0.8rem; color: var(--text - secondary); margin - top: 2px; }
    .btn - danger { background: linear - gradient(135deg, #e53e3e, #c53030); color: #fff; border: none; }
    .btn - danger:hover { opacity: 0.9; }
    .btn - sm { padding: 6px 12px; font - size: 0.8rem; }
    .btn - icon { background: none; border: none; cursor: pointer; padding: 4px; font - size: 1rem; }
    .btn - icon:hover { opacity: 0.7; }
        `;
document.head.appendChild(adminStyle);

// ===== Boot =====
setupUserMenu();
init();
