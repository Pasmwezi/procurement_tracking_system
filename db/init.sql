-- =============================================
-- Procurement File Tracking System v2.0 — Schema
-- =============================================

-- Teams table
CREATE TABLE teams (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Unified users table (admin, team_leader, officer)
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(200) NOT NULL UNIQUE,
    password_hash VARCHAR(255),
    display_name VARCHAR(200) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'team_leader', 'officer')),
    team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
    password_changed BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Processes table
CREATE TABLE processes (
    name VARCHAR(100) PRIMARY KEY
);

-- Process steps table
CREATE TABLE process_steps (
    id SERIAL PRIMARY KEY,
    process_name VARCHAR(100) NOT NULL REFERENCES processes(name) ON DELETE CASCADE,
    step_name VARCHAR(200) NOT NULL,
    sla_days INTEGER NOT NULL DEFAULT 0,
    cum_days INTEGER NOT NULL DEFAULT 0,
    step_order INTEGER NOT NULL,
    UNIQUE (process_name, step_order)
);

-- Procurement files table
CREATE TABLE files (
    id SERIAL PRIMARY KEY,
    pr_number VARCHAR(100) NOT NULL UNIQUE,
    title VARCHAR(500) NOT NULL,
    process_name VARCHAR(100) NOT NULL REFERENCES processes(name),
    officer_id INTEGER NOT NULL REFERENCES users(id),
    current_step_id INTEGER REFERENCES process_steps(id),
    status VARCHAR(50) DEFAULT 'Active',
    step_started_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);

-- File step log (history of step transitions)
CREATE TABLE file_step_log (
    id SERIAL PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    step_id INTEGER NOT NULL REFERENCES process_steps(id),
    started_at TIMESTAMP NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP,
    sla_met BOOLEAN,
    comment TEXT
);

-- Notifications table
CREATE TABLE notifications (
    id SERIAL PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    officer_id INTEGER NOT NULL REFERENCES users(id),
    step_id INTEGER NOT NULL REFERENCES process_steps(id),
    message TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_notifications_officer ON notifications(officer_id, is_read);
CREATE INDEX idx_files_officer ON files(officer_id);
CREATE INDEX idx_files_status ON files(status);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_team ON users(team_id);

-- Default App Admin: email=admin@filetracker.local, password set by server at startup
INSERT INTO users (email, password_hash, display_name, role)
VALUES ('admin@filetracker.local', 'NEEDS_REHASH', 'App Administrator', 'admin');

-- =============================================
-- Seed data: Processes
-- =============================================
INSERT INTO processes (name) VALUES
    ('Sole_Source'),
    ('Two_Phase_Solic'),
    ('One_Phase_Solic'),
    ('Service_Solic_Above_TA'),
    ('Service_Solic_Under_TA');

-- =============================================
-- Seed data: Process Steps
-- =============================================

-- Sole_Source
INSERT INTO process_steps (process_name, step_name, sla_days, cum_days, step_order) VALUES
    ('Sole_Source', 'File assigned', 0, 0, 1),
    ('Sole_Source', 'Initial Review', 4, 4, 2),
    ('Sole_Source', 'Drafting Contractual Document', 3, 7, 3),
    ('Sole_Source', 'Client review', 7, 14, 4),
    ('Sole_Source', 'Team Lead Review (Contract)', 2, 16, 5),
    ('Sole_Source', 'Contract Award', 3, 19, 6),
    ('Sole_Source', 'Completed', 0, 19, 7);

-- Two_Phase_Solic
INSERT INTO process_steps (process_name, step_name, sla_days, cum_days, step_order) VALUES
    ('Two_Phase_Solic', 'File assigned', 0, 0, 1),
    ('Two_Phase_Solic', 'Initial Review', 4, 4, 2),
    ('Two_Phase_Solic', 'Drafting Phase 1 Document', 3, 7, 3),
    ('Two_Phase_Solic', 'Client review (RFQ)', 7, 14, 4),
    ('Two_Phase_Solic', 'Translation (If Necessary)', 14, 28, 5),
    ('Two_Phase_Solic', 'Team Lead review (RFQ)', 3, 31, 6),
    ('Two_Phase_Solic', 'RFQ (Solicitaion)', 15, 46, 7),
    ('Two_Phase_Solic', 'Evaluation', 7, 53, 8),
    ('Two_Phase_Solic', 'Drafting Phase 2 Document', 3, 56, 9),
    ('Two_Phase_Solic', 'Client review (ITT)', 3, 59, 10),
    ('Two_Phase_Solic', 'Translation (If Necessary)', 14, 73, 11),
    ('Two_Phase_Solic', 'Team Lead review (ITT)', 3, 76, 12),
    ('Two_Phase_Solic', 'ITT (Solicitaion)', 15, 91, 13),
    ('Two_Phase_Solic', 'Drafting Contract Document', 3, 94, 14),
    ('Two_Phase_Solic', 'Team Lead Review (Contract)', 2, 96, 15),
    ('Two_Phase_Solic', 'Contract Award', 3, 99, 16),
    ('Two_Phase_Solic', 'Completed', 0, 99, 17);

-- One_Phase_Solic
INSERT INTO process_steps (process_name, step_name, sla_days, cum_days, step_order) VALUES
    ('One_Phase_Solic', 'File assigned', 0, 0, 1),
    ('One_Phase_Solic', 'Initial Review', 4, 4, 2),
    ('One_Phase_Solic', 'Drafting ITT Document', 3, 7, 3),
    ('One_Phase_Solic', 'Client review', 7, 14, 4),
    ('One_Phase_Solic', 'Translation (If Necessary)', 14, 28, 5),
    ('One_Phase_Solic', 'Team Lead Review', 2, 30, 6),
    ('One_Phase_Solic', 'ITT (Solicitation)', 15, 45, 7),
    ('One_Phase_Solic', 'Drafting Contractual Document', 2, 47, 8),
    ('One_Phase_Solic', 'Team Lead Review (Contract)', 2, 49, 9),
    ('One_Phase_Solic', 'Contract Award', 3, 52, 10),
    ('One_Phase_Solic', 'Completed', 0, 52, 11);

-- Service_Solic_Above_TA
INSERT INTO process_steps (process_name, step_name, sla_days, cum_days, step_order) VALUES
    ('Service_Solic_Above_TA', 'File assigned', 0, 0, 1),
    ('Service_Solic_Above_TA', 'Initial Review', 4, 4, 2),
    ('Service_Solic_Above_TA', 'Drafting Solicitation Document', 3, 7, 3),
    ('Service_Solic_Above_TA', 'Team Lead Review', 14, 21, 4),
    ('Service_Solic_Above_TA', 'Client review', 7, 28, 5),
    ('Service_Solic_Above_TA', 'Translation', 15, 43, 6),
    ('Service_Solic_Above_TA', 'Tendering (Solicitation)', 25, 68, 7),
    ('Service_Solic_Above_TA', 'Evaluation', 14, 82, 8),
    ('Service_Solic_Above_TA', 'Drafting Contractual Document', 7, 89, 9),
    ('Service_Solic_Above_TA', 'Team Lead Review (Contract)', 2, 91, 10),
    ('Service_Solic_Above_TA', 'Contract Award', 3, 94, 11),
    ('Service_Solic_Above_TA', 'Completed', 0, 94, 12);

-- Service_Solic_Under_TA
INSERT INTO process_steps (process_name, step_name, sla_days, cum_days, step_order) VALUES
    ('Service_Solic_Under_TA', 'File assigned', 0, 0, 1),
    ('Service_Solic_Under_TA', 'Initial Review', 4, 4, 2),
    ('Service_Solic_Under_TA', 'Drafting Solicitation Document', 3, 7, 3),
    ('Service_Solic_Under_TA', 'Team Lead Review', 14, 21, 4),
    ('Service_Solic_Under_TA', 'Client review', 7, 28, 5),
    ('Service_Solic_Under_TA', 'Tendering (Solicitation)', 15, 43, 6),
    ('Service_Solic_Under_TA', 'Evaluation', 14, 57, 7),
    ('Service_Solic_Under_TA', 'Drafting Contractual Document', 7, 64, 8),
    ('Service_Solic_Under_TA', 'Team Lead Review (Contract)', 2, 66, 9),
    ('Service_Solic_Under_TA', 'Contract Award', 3, 69, 10),
    ('Service_Solic_Under_TA', 'Completed', 0, 69, 11);

-- App Settings (key-value store for SMTP config, etc.)
CREATE TABLE IF NOT EXISTS app_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP DEFAULT NOW()
);
