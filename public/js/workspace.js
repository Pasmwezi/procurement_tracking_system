/* Presentation enhancements only: no API calls or workflow state changes. */
(() => {
    const sidebar = document.getElementById('sidebar');
    const toggle = document.getElementById('btnHamburger');
    const backdrop = document.getElementById('sidebarBackdrop');
    const mobile = window.matchMedia('(max-width: 768px)');
    function syncNavigation() {
        const open = sidebar.classList.contains('open') && mobile.matches;
        document.body.classList.toggle('nav-open', open);
        toggle.setAttribute('aria-expanded', String(open));
        sidebar.inert = mobile.matches && !open;
    }
    function dismissNavigation() {
        sidebar.classList.remove('open');
        syncNavigation();
        toggle.focus();
    }
    backdrop.addEventListener('click', dismissNavigation);
    new MutationObserver(syncNavigation).observe(sidebar, { attributes: true, attributeFilter: ['class'] });
    mobile.addEventListener('change', syncNavigation);
    document.querySelectorAll('.nav-item').forEach(item => {
        item.setAttribute('role', 'button');
        item.tabIndex = 0;
        item.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                item.click();
            }
        });
    });
    const descriptions = {
        dashboard: ['Your procurement overview', 'Monitor workload, upcoming deadlines and recent file activity in one place.'],
        files: ['Procurement files', 'Follow each file from assignment through its procurement process.'],
        triage: ['Intake & triage', 'Review incoming requests, resolve missing documents and track assignment to award.'],
        contracts: ['Contract register', 'Review awarded files, contract periods and related purchasing records.'],
        vendors: ['Vendor directory', 'Find supplier contact details and manage vendor records.'],
        officers: ['Your procurement team', 'Review officer workload and file assignments.'],
        notifications: ['Stay on top of deadlines', 'Review SLA alerts and updates across your procurement files.'],
        admin: ['Workspace administration', 'Manage users, teams, procurement processes and system settings.']
    };
    Object.entries(descriptions).forEach(([page, copy]) => {
        const section = document.getElementById(`page${page[0].toUpperCase()}${page.slice(1)}`);
        if (!section) return;
        const intro = document.createElement('div');
        intro.className = 'workspace-intro';
        const heading = document.createElement('h2');
        heading.textContent = copy[0];
        const subtitle = document.createElement('p');
        subtitle.textContent = copy[1];
        intro.append(heading, subtitle);
        section.prepend(intro);
    });
    // Dynamic tables keep every field and action readable on narrow screens.
    function enhanceContent() {
        document.querySelectorAll('.data-table').forEach(table => {
            const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
            if (!headers.length) return;
            table.classList.add('mobile-labelled');
            table.querySelectorAll('tbody tr').forEach(row => {
                [...row.cells].forEach((cell, index) => {
                    if (cell.colSpan === 1 && headers[index]) cell.dataset.label = headers[index];
                });
            });
        });
        document.querySelectorAll('input, select, textarea').forEach(input => {
            if (input.type === 'hidden' || input.labels?.length || input.hasAttribute('aria-label')) return;
            const label = input.getAttribute('placeholder') || input.getAttribute('title') || input.options?.[0]?.textContent;
            if (label) input.setAttribute('aria-label', label.replace('🔍', '').trim());
        });
        document.querySelectorAll('button[title], .btn-close').forEach(button => {
            if (!button.hasAttribute('aria-label')) button.setAttribute('aria-label', button.title || 'Close dialog');
        });
        document.querySelectorAll('.nav-item').forEach(item => {
            if (item.classList.contains('active')) item.setAttribute('aria-current', 'page');
            else item.removeAttribute('aria-current');
        });
    }
    new MutationObserver(enhanceContent).observe(document.querySelector('.main-content'), { childList: true, subtree: true });
    new MutationObserver(enhanceContent).observe(document.getElementById('modalOverlay'), { childList: true, subtree: true });
    document.querySelectorAll('.modal').forEach((modal, index) => {
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        const heading = modal.querySelector('h2');
        if (heading) {
            if (!heading.id) heading.id = `workspace-dialog-${index}`;
            modal.setAttribute('aria-labelledby', heading.id);
        }
    });
    let priorFocus;
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        new MutationObserver(() => {
            if (overlay.classList.contains('active')) {
                priorFocus = document.activeElement;
                const field = [...overlay.querySelectorAll('input:not([type="hidden"]), select, textarea, button')].find(el => el.getClientRects().length && !el.disabled);
                field?.focus();
            } else if (priorFocus?.isConnected) priorFocus.focus();
        }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
    });
    document.addEventListener('keydown', event => {
        const overlay = document.querySelector('.modal-overlay.active');
        if (overlay && event.key === 'Tab') {
            const fields = [...overlay.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')].filter(el => el.getClientRects().length && !el.disabled);
            const first = fields[0], last = fields[fields.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
        if (event.key === 'Escape' && sidebar.classList.contains('open')) dismissNavigation();
    });
    syncNavigation();
    enhanceContent();
})();
