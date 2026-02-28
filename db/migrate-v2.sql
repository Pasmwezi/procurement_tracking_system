-- =============================================
-- v2.0 Migration: Role-Based Access & Teams
-- Run this ONCE against an existing v1 database
-- =============================================

BEGIN;

-- 1. Create teams table
CREATE TABLE IF NOT EXISTS teams (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 2. Create unified users table
CREATE TABLE IF NOT EXISTS users (
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

-- 3. Migrate existing admin → users (as app admin)
INSERT INTO users (email, password_hash, display_name, role, password_changed, created_at, updated_at)
SELECT
    COALESCE(username, 'admin') || '@filetracker.local',
    password_hash,
    display_name,
    'admin',
    COALESCE(password_changed, FALSE),
    created_at,
    updated_at
FROM admin
ON CONFLICT (email) DO NOTHING;

-- 4. Migrate existing officers → users (as officers, no password yet)
INSERT INTO users (email, display_name, role, created_at)
SELECT email, name, 'officer', created_at
FROM officers
ON CONFLICT (email) DO NOTHING;

-- 5. Remap files.officer_id from old officers to new users
ALTER TABLE files ADD COLUMN new_officer_id INTEGER;

UPDATE files f
SET new_officer_id = u.id
FROM officers o
JOIN users u ON u.email = o.email AND u.role = 'officer'
WHERE f.officer_id = o.id;

ALTER TABLE files DROP CONSTRAINT files_officer_id_fkey;
ALTER TABLE files DROP COLUMN officer_id;
ALTER TABLE files RENAME COLUMN new_officer_id TO officer_id;
ALTER TABLE files ADD CONSTRAINT files_officer_id_fkey
    FOREIGN KEY (officer_id) REFERENCES users(id);
ALTER TABLE files ALTER COLUMN officer_id SET NOT NULL;

-- 6. Remap notifications.officer_id
ALTER TABLE notifications ADD COLUMN new_officer_id INTEGER;

UPDATE notifications n
SET new_officer_id = u.id
FROM officers o
JOIN users u ON u.email = o.email AND u.role = 'officer'
WHERE n.officer_id = o.id;

ALTER TABLE notifications DROP CONSTRAINT notifications_officer_id_fkey;
ALTER TABLE notifications DROP COLUMN officer_id;
ALTER TABLE notifications RENAME COLUMN new_officer_id TO officer_id;
ALTER TABLE notifications ADD CONSTRAINT notifications_officer_id_fkey
    FOREIGN KEY (officer_id) REFERENCES users(id);
ALTER TABLE notifications ALTER COLUMN officer_id SET NOT NULL;

-- 7. Recreate indexes
DROP INDEX IF EXISTS idx_notifications_officer;
DROP INDEX IF EXISTS idx_files_officer;
CREATE INDEX idx_notifications_officer ON notifications(officer_id, is_read);
CREATE INDEX idx_files_officer ON files(officer_id);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_team ON users(team_id);

-- 8. Drop old tables
DROP TABLE IF EXISTS admin CASCADE;
DROP TABLE IF EXISTS officers CASCADE;

COMMIT;
