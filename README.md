# Procurement Tracking System

A self-hosted operations application for managing procurement work from intake and triage through solicitation, evaluation, contract award, and close-out.

The system gives procurement teams a shared, auditable view of every file: who owns it, which workflow step it has reached, how long that step should take, what is overdue, what documentation is missing, and what decisions were recorded. It is designed for internal procurement units that need more structure and accountability than a spreadsheet or shared mailbox, without adopting a large commercial procurement suite.

> **Scope:** This is an internal file-management and workflow-tracking system. It is not a public tendering portal, supplier self-service portal, financial system of record, or substitute for an organization's procurement policies and delegated authorities.

## What the project addresses

Procurement files commonly move between clients, contracting officers, team leaders, evaluators, and vendors over many weeks or months. When tracking is spread across email, spreadsheets, and personal notes, teams can lose visibility into:

- whether an intake package is complete;
- who is responsible for the next action;
- how long a file has remained at a workflow step;
- which files are late or at risk;
- why a file was transferred, cancelled, or advanced;
- which bids and financial values supported an award decision; and
- what contracts or purchase orders resulted from the procurement.

This application centralizes those operational records and applies role-aware workflows, SLA monitoring, validation, notifications, and audit logging.

## Procurement lifecycle

```text
Request intake
    ↓
Triage and missing-document follow-up
    ↓
Assignment to a contracting officer and workflow
    ↓
Drafting, review, solicitation, and evaluation steps
    ↓
Bid evaluation and award decision
    ↓
Contract / purchase-order tracking
    ↓
Completion, reporting, and audit history
```

A file follows an ordered procurement process. Each process contains configurable steps and an expected number of days per step. The application records step start and completion times, comments, ownership changes, and lifecycle decisions so that current status and historical context remain visible.

## Main capabilities

### Intake and triage

- Register requests before formal procurement work starts.
- Record estimated value, business owner, notes, and missing documents.
- Track whether required documents have been received.
- Import and export triage records using Excel.
- Assign a complete intake record to an officer and create the corresponding procurement file.
- Keep triage status synchronized when a linked procurement is awarded or cancelled.

### Procurement file management

- Create, search, filter, and review procurement files by status, process, officer, or team.
- Move active files through controlled, ordered process steps.
- Record comments and timestamps against the step history.
- Backdate imported files and initialize them at the correct current step.
- Explicitly complete or cancel work while preserving its history.
- Transfer one or more active files between officers with validation and audit records.

### Workflow and service-level tracking

- Five seeded workflows cover sole-source, one-phase, two-phase, and services solicitations above or below the trade-agreement threshold.
- Administrators can maintain process steps, ordering, and SLA durations.
- An hourly background job identifies overdue work and creates notifications.
- Dashboards summarize active, completed, cancelled, and overdue files, along with officer workload.

### Vendors, bids, awards, and contracts

- Maintain vendor records used in bid and contract activity.
- Record bid amounts and technical and financial scores.
- Validate evaluation values and identify the selected bid.
- Track resulting contracts and purchase orders, including key dates and values.
- Report on procurement workload, lifecycle status, and operational outcomes.

### Administration and accountability

- Organize users into teams with administrator, team-leader, and officer roles.
- Scope operational access and actions according to role, ownership, and team.
- Configure email delivery for assignment and operational notifications.
- Preserve an audit trail for material administrative and procurement actions.
- Revoke active sessions when passwords or account state change.

## Roles

| Role | Primary responsibilities |
|---|---|
| **Administrator** | Configure teams, users, procurement processes, application settings, and cross-team administration. |
| **Team Leader** | Manage team intake, assign and transfer files, control workflow progression, oversee evaluations, and access team reporting. |
| **Contracting Officer** | Work assigned files, review their timelines and notifications, maintain permitted file details, and record bid-related information. |

Authorization is enforced by the API. Hiding a control in the browser is not treated as a security boundary.

---

## 🏗️ Architecture

| Layer          | Technology                |
|----------------|---------------------------|
| Frontend       | HTML / CSS / Vanilla JS   |
| Backend        | Node.js 20 + Express      |
| Database       | PostgreSQL 16 (Alpine)    |
| Orchestration  | Docker Compose            |

```
┌────────────────────────────────────┐
│          Browser (SPA)             │
│   HTML + CSS + Vanilla JavaScript  │
└──────────────┬─────────────────────┘
               │ HTTP / REST
┌──────────────▼─────────────────────┐
│        Node.js + Express           │
│  ┌──────────┐  ┌────────────────┐  │
│  │ Auth JWT │  │ SLA Cron (1hr) │  │
│  └──────────┘  └────────────────┘  │
│  Auth, triage, files, bids,         │
│  contracts, reports, administration│
└──────────────┬─────────────────────┘
               │ pg (TCP :5432)
┌──────────────▼─────────────────────┐
│         PostgreSQL 16              │
│  Tables: users, teams, files,      │
│  processes, process_steps,         │
│  file_step_log, notifications,     │
│  triage, vendors, bids, contracts,  │
│  purchase orders, audit records     │
└────────────────────────────────────┘
```

---

## 🚀 Getting Started

### Prerequisites

- [Docker](https://www.docker.com/get-started) & Docker Compose

### Quick Start

```bash
# Clone the repository
git clone https://github.com/Pasmwezi/procurement_tracking_system.git
cd procurement_tracking_system

# Configure required secrets without committing them.
# For a fresh deployment, generate a new DB password. For an existing
# PostgreSQL volume, preserve the tracker role's current password: changing
# POSTGRES_PASSWORD alone does not rotate an initialized database.
export DB_PASSWORD="$(openssl rand -hex 32)"
export JWT_SECRET="$(openssl rand -hex 32)"
export ADMIN_INITIAL_EMAIL="admin@example.ca"
export ADMIN_INITIAL_PASSWORD="$(openssl rand -base64 36)"

# Build and start
docker compose up --build -d
```

The included Compose configuration publishes the app at **http://localhost:3006**. The application container itself listens on port `3000`.

### Initial Administrator

On an empty database, the first administrator is created from
`ADMIN_INITIAL_EMAIL` and `ADMIN_INITIAL_PASSWORD`. No default account or
repository-known password exists. Remove those bootstrap variables after the
administrator has been created.

### Stopping the App

```bash
docker compose down        # Stop containers (data is preserved)
docker compose down -v     # Stop containers and delete all data
```

---

## 📖 Usage Guide

### 1. Sign In
Navigate to `http://localhost:3006` and log in with the administrator credentials supplied during first startup.

### 2. User & Team Management (Admin)
Go to **Administration**. Admins can create Teams and add Users, assigning them roles of **Team Leader**, **Officer**, or **Admin**.

### 3. Triage Files (Team Leader)
Go to **Triage** → **+ New Triage**:
- Intake files before formal procurement begins.
- Track missing documents and deadlines.
- **Assign** the file to an officer, which officially starts the procurement process.

### 4. Create a Procurement File
Go to **Files** → **+ New File**:
- **PR Number** — Unique purchase requisition number (e.g. `PR-2026-001`)
- **File Title** — Description of the procurement
- **Process** — Select one of the 5 procurement processes
- **Officer** — Assign to a contracting officer
- **Assignment Date** *(optional)* — Set a past date for importing existing files
- **Current Step** *(optional)* — Select which step the file is already on (prior steps will be auto-completed)

### 5. Track Progress & SLAs
- Click **View** on any file to see the full step timeline
- Click **Advance** to move a file to its next step
- Add **Comments** to document SLA compliance or delays
- Files can be explicitly **Cancelled** if the procurement is abandoned
- The **Dashboard** and **Notifications** page list all overdue alerts

### 6. Transfer Files
On the **Officers** page, Team Leaders can click **Transfer Files** on an officer's card to reassign their active files to other officers.

---

## 🔌 API Reference

Except for the intended authentication and health endpoints, API routes require authentication. Authorization is further restricted by role, team, ownership, and file state.

### Authentication

| Method | Endpoint              | Description                    |
|--------|-----------------------|--------------------------------|
| POST   | `/api/auth/login`     | Sign in, receive JWT token     |
| PUT    | `/api/auth/password`  | Change password (auth required)|
| GET    | `/api/auth/me`        | Get current user info          |

### Admin
| Method | Endpoint                        | Description                  |
|--------|---------------------------------|------------------------------|
| GET/POST  | `/api/admin/users`         | List / Create users          |
| PUT/DELETE| `/api/admin/users/:id`     | Update / Delete user         |
| GET/POST  | `/api/admin/teams`         | List / Create teams          |
| GET/PUT   | `/api/admin/email-settings`| Manage SMTP config           |
| GET/POST  | `/api/admin/processes`     | Manage processes             |

### Triage (Team Leader)
| Method | Endpoint                    | Description                              |
|--------|-----------------------------|------------------------------------------|
| GET/POST  | `/api/triage`            | List or create triage files              |
| PUT    | `/api/triage/:id/status`    | Update status (Triaged, Missing Docs)    |
| POST   | `/api/triage/:id/missing-docs`| Add missing document requirements      |
| POST   | `/api/triage/:id/assign`    | Assign to officer, starting a process    |

### Officers (User Management for non-admins)
| Method | Endpoint                      | Description                     |
|--------|-------------------------------|---------------------------------|
| GET    | `/api/officers`               | List all officers               |
| POST   | `/api/officers`               | Create a new officer            |
| DELETE | `/api/officers/:id`           | Remove an officer               |
| PUT    | `/api/officers/:id/transfer`  | Batch transfer files to other officers |

### Files
| Method | Endpoint                    | Description                              |
|--------|-----------------------------|------------------------------------------|
| GET    | `/api/files`                | List files (filterable)                  |
| GET    | `/api/files/:id`            | Get file details with step history       |
| POST   | `/api/files`                | Create a new file (supports backdating)  |
| PUT    | `/api/files/:id/advance`    | Advance file to the next step            |
| PUT    | `/api/files/:id/cancel`     | Cancel an active procurement file        |
| PUT    | `/api/files/:id/steps/:logId/comment` | Add/update a step comment    |
| GET    | `/api/files/stats/summary`  | Dashboard statistics                     |

### Processes

| Method | Endpoint                        | Description                  |
|--------|---------------------------------|------------------------------|
| GET    | `/api/processes`                | List all procurement processes|
| GET    | `/api/processes/:name/steps`    | List steps for a process     |

### Notifications

| Method | Endpoint                           | Description               |
|--------|------------------------------------|---------------------------|
| GET    | `/api/notifications`               | List all notifications    |
| PUT    | `/api/notifications/read-all`      | Mark all as read          |

### Utility

| Method | Endpoint          | Description                |
|--------|--------------------|---------------------------|
| GET    | `/api/health`      | Health check (public)      |
| POST   | `/api/sla-check`   | Trigger manual SLA check   |

---

## 📂 Project Structure

```
file_tracking/
├── db/
│   ├── init.sql              # Database schema + seed data (5 processes, 58 steps)
│   └── pool.js               # PostgreSQL connection pool
├── middleware/
│   └── auth.js               # JWT authentication middleware
├── public/
│   ├── css/
│   │   └── styles.css        # Dark-themed design system
│   ├── js/
│   │   └── app.js            # Frontend SPA logic
│   └── index.html            # Single-page application shell
├── routes/
│   ├── admin.js              # Users, teams, processes, email settings
│   ├── auth.js               # Login, password change, user info
│   ├── files.js              # File CRUD, advance, cancel, comment
│   ├── notifications.js      # Notification listing + mark read
│   ├── officers.js           # Officer CRUD + file transfer
│   ├── processes.js          # Process & step listing
│   └── triage.js             # Triage file intake and assignment
├── services/
│   └── slaChecker.js         # Hourly SLA overdue detection
├── docker-compose.yml        # Two-service stack (db + app)
├── Dockerfile                # Node.js 20 Alpine image
├── package.json              # Dependencies & scripts
└── server.js                 # Express server, cron, startup logic
```

---

## ⚙️ Environment Variables

| Variable                 | Required/default | Description                                      |
|--------------------------|------------------|--------------------------------------------------|
| `DB_PASSWORD`            | Required         | PostgreSQL service password used by Compose      |
| `DATABASE_URL`           | Required         | PostgreSQL connection string                     |
| `JWT_SECRET`             | Required         | Strong, unique JWT signing secret                 |
| `ADMIN_INITIAL_EMAIL`    | First startup    | Initial administrator email                      |
| `ADMIN_INITIAL_PASSWORD` | First startup    | Initial administrator password (minimum 12 chars)|
| `PORT`                   | `3000`           | Server port                                      |
| `NODE_ENV`               | `production`     | Node.js environment                              |

> **⚠️ Production:** Keep all secrets outside source control and rotate any value that has been disclosed.

---

## 🗄️ Database Schema

| Table                    | Purpose                                      |
|--------------------------|----------------------------------------------|
| `users`                  | User accounts (admin, team_leader, officer)  |
| `teams`                  | Team organization for users and files        |
| `processes`              | Procurement process types                    |
| `process_steps`          | Ordered steps per process with SLA days      |
| `files`                  | Procurement files with current step & status |
| `file_step_log`          | Step transition history, timestamps, comments|
| `notifications`          | SLA overdue and assignment notifications     |
| `triage_files`           | Intake files before formal assignment        |
| `triage_missing_docs`    | Required documents for triage files          |
| `triage_status_history`  | Audit log for triage status changes          |

---

## 🔒 Security

- **JWT Authentication** — All API routes (except login and health check) require a valid Bearer token
- **bcrypt Password Hashing** — Admin passwords are hashed with bcryptjs (10 rounds)
- **Forced Password Change** — Admin is required to change the default password on first login
- **Auto-Logout** — Invalid or expired tokens trigger automatic sign-out

---

## 📝 License

This project is provided as-is for internal procurement tracking use.
