# 📁 Procurement File Tracking System

A Dockerized web application for team leaders to track procurement files assigned to contracting officers, enforce SLA deadlines, and manage multi-step procurement workflows.

---

## ✨ Features

- **Dashboard** — At-a-glance stats (total, active, overdue, completed files), officer workload chart, and recent files
- **Triage Intake** — Team Leaders can log files pre-procurement, track missing documents, and assign them to start a process
- **File Management** — Create, view, advance, cancel, and track procurement files through multi-step workflows
- **5 Procurement Processes** — Sole Source (7 steps), Two Phase Solicitation (17 steps), One Phase Solicitation (11 steps), Service Solicitation Above TA (12 steps), Service Solicitation Under TA (11 steps)
- **Step Timeline** — Visual timeline for each file showing SLA status per step (met, overdue, pending)
- **Step Comments** — Add or edit notes on any step to document progress and SLA compliance
- **SLA Enforcement** — Automatic hourly SLA checks via cron, with manual trigger option
- **Overdue Notifications** — In-app notification center for overdue files
- **User & Team Management** — Role-based access (Admin, Team Leader, Officer) with team organization
- **File Transfer** — Reassign files between officers (per-file target selection)
- **Past File Import** — Backdate files with a custom assignment date and starting step; prior steps are auto-completed with realistic timestamps
- **Email Notifications** — Automated emails sent to officers upon file assignment utilizing customizable SMTP configuration
- **Authentication** — JWT-based login with forced password change on first sign-in for Admins
- **Dark-Themed UI** — Modern, responsive single-page interface

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
│  Routes: auth, files, officers,    │
│  processes, notifications          │
└──────────────┬─────────────────────┘
               │ pg (TCP :5432)
┌──────────────▼─────────────────────┐
│         PostgreSQL 16              │
│  Tables: users, teams, files,      │
│  processes, process_steps,         │
│  file_step_log, notifications,     │
│  triage_files, triage_missing_docs │
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
cd file_tracking

# Build and start
docker compose up --build -d
```

The app will be available at **http://localhost:3000**

### Default Credentials

| Field    | Value      |
|----------|------------|
| Username | `admin@filetracker.local` |
| Password | `admin123`                |

> **Note:** The admin will be prompted to change the password on first login.

### Stopping the App

```bash
docker compose down        # Stop containers (data is preserved)
docker compose down -v     # Stop containers and delete all data
```

---

## 📖 Usage Guide

### 1. Sign In
Navigate to `http://localhost:3000` and log in. The default admin account is `admin@filetracker.local` / `admin123`. The admin will be prompted to set a new password on first login.

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

All API routes (except `/api/auth/login` and `/api/health`) require a JWT token in the `Authorization: Bearer <token>` header.

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

| Variable        | Default                                                | Description                          |
|-----------------|--------------------------------------------------------|--------------------------------------|
| `DATABASE_URL`  | `postgres://tracker:tracker_pass@db:5432/file_tracking`| PostgreSQL connection string         |
| `JWT_SECRET`    | `file-tracker-secret-key-change-in-production`         | Secret key for JWT signing           |
| `PORT`          | `3000`                                                 | Server port                          |
| `NODE_ENV`      | `production`                                           | Node.js environment                  |

> **⚠️ Production:** Always set a strong, unique `JWT_SECRET` in your environment.

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
