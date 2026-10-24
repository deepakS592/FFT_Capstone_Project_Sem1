# MediFlow Simple

MediFlow Simple is a standalone rebuild of the professor-approved MediFlow clinic portal. It retains the original public clinic sections and the Administrator, Doctor, Receptionist, and Patient workspaces, using plain HTML, CSS, browser JavaScript, Express, PostgreSQL, and the `pg` library.

This is a university demonstration with synthetic records. Do not enter real patient information. It is not a production healthcare system.

## Project layout

```text
MediFlow-Simple/
├── public/
│   ├── index.html       Browser entry point, served directly by Express
│   ├── style.css        Original MediFlow global CSS and responsive design rules
│   ├── app.js           Vanilla JavaScript routes, forms, rendering, and API calls
│   └── assets/
│       ├── images/      Original favicon; original clinic photos are remote URLs
│       └── fonts/       No local fonts were included in the source ZIP
├── server.js            Express routes, sessions, authorization, validation, SQL workflows
├── db.js                Shared PostgreSQL connection pool
├── schema.sql           SQL version of the source project's Prisma migration
├── seed.js              Guarded synthetic development data; never deletes records
├── tests/api.test.js    Automated API and static frontend checks
├── package.json
├── package-lock.json
├── .env.example
└── README.md
```

## Source review and preserved pages

The supplied ZIP was inspected as the primary source. It contains the Next.js pages, `LandingPage.tsx`, `MediFlow.tsx`, the complete global stylesheet, `lib/data.ts`, the Prisma model, its SQL migration, the seed routine, and Express workflow/authentication code. The source application has these actual route groups:

| Source page/workflow | Simple project implementation |
| --- | --- |
| Public home, About, Doctors, Departments, Services, Expertise, Patients, Contact | Sections and anchors on `/`, with the original site CSS, copy, navigation, photo URLs, doctor search, and department filter |
| Login and patient registration | `/login` and `/register`; Express session authentication and a real patient-only database registration endpoint |
| Admin dashboard, analytics, doctors, receptionists, patients, appointments, departments, queries, notifications, settings | `/admin/:page`; database-backed dashboard and authorized management forms |
| Doctor dashboard, appointments, patients and patient detail, consultation, prescriptions, queries, profile | `/doctor/:page`; patient scope comes from assigned appointments/consultations; consultation and prescription writes share one transaction |
| Reception dashboard, patient registration, patients, appointments, prescriptions, queries, billing, notifications, profile | `/reception/:page`; patient registration, appointment decisions, prescription processing, query routing, and payment status use the API |
| Patient dashboard, profile, appointments, booking, prescriptions, history, messages/queries, notifications | `/patient/:page`; the server scopes records to the signed-in patient's profile |

Original entity names and quoted PostgreSQL identifiers are retained: `User`, `Department`, `DoctorProfile`, `PatientProfile`, `ReceptionProfile`, `Appointment`, `Consultation`, `Diagnosis`, `Prescription`, `Medicine`, `PrescriptionItem`, `PatientQuery`, `QueryMessage`, `Notification`, `Bill`, `ClinicSettings`, and `AuditLog`.

The workspace uses the original CSS file from the ZIP. The ZIP had one local image (the favicon); the original landing and sign-in designs referenced Unsplash image URLs, which are kept. The old UI used Lucide SVG icons; this rebuild uses simple text glyphs in some icon positions. No screenshot comparison was available during implementation, so this is a close style reuse, not a claim of pixel-perfect rendering. The new patient registration screen is added because the requested simple app must create real patient accounts; the source only had staff-assisted patient registration.

## How the application works

```text
Browser (index.html + style.css + app.js)
             │ same-origin JSON requests; HTTP-only cookie
             ▼
Express (server.js) ─── role checks, validation, transactions, bcryptjs
             │ parameterized SQL through pg
             ▼
PostgreSQL (original quoted tables) ─── session table (connect-pg-simple)
```

The browser requests `/api/app/bootstrap` after login. Express reads the user's role and only selects that user's permitted records. Forms send JSON to `/api/...`; Express validates the input, checks the role on the server, and runs SQL with `$1`, `$2`, ... placeholders. The browser keeps only the light/dark display preference in local storage; user accounts, clinic records, and sessions are held by PostgreSQL.

Patient registration always writes role `PATIENT` in server code. It validates and normalizes email, checks for duplicates, hashes the password with bcryptjs, then inserts the `User`, related `PatientProfile`, and audit entry in one transaction. The role cannot be provided by the registration form. Successful registration signs the patient in.

Login fetches the user by normalized email, compares the submitted password with the stored bcrypt hash, regenerates the Express session ID, then stores only user identity and role in a PostgreSQL-backed session. Logout destroys the session and expires the HTTP-only cookie. Cookies use `SameSite=Strict`, `HttpOnly`, and `Secure` in production. A rate limiter protects login and registration.

Appointment changes check the selected patient, active doctor, department, valid future time, and existing schedule conflicts. The original PostgreSQL exclusion constraints remain in `schema.sql`, and the API also reports a readable conflict response. Consultation, diagnosis, prescription, prescription items, notifications, appointment completion, and audit entry are committed or rolled back together.

Role checks are applied in Express, not just in page navigation. Patients only see their own profile, visits, messages, notifications, bills, and available prescriptions. Doctors see patients linked to their appointments or consultations and may only record care for an assigned patient. Reception staff manage front-desk workflows but cannot create a diagnosis. Admin-only staff and department management is enforced on the server.

## Requirements

- Node.js 20 or later
- npm
- PostgreSQL with the same tables and columns as the source migration; Neon PostgreSQL works
- `psql` for initial schema setup when you are creating a new, empty database

## Run locally

1. Create a local PostgreSQL database, or use a dedicated development database on Neon. Never point tests or seed commands at a production database.
2. From this folder, create the environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Set `DATABASE_URL` and `SESSION_SECRET` in `.env`. Use a URL-safe development password and a random secret with at least 32 characters. `PGSSLMODE=disable` is only for local PostgreSQL without TLS.
4. For a **new empty database only**, load the schema:

   ```powershell
   psql $env:DATABASE_URL -f .\schema.sql
   ```

   If the database already contains the MediFlow tables, do not run the initial `CREATE TABLE` script again. Inspect its schema first. This project does not drop or reset tables. The app intentionally uses the source migration's quoted names and columns. If a hosted database differs, create a separate additive migration after reviewing the difference; do not rename or drop existing data to fit the app.
5. Install and optionally seed synthetic development data:

   ```powershell
   npm install
   npm run seed
   ```

   Seeding requires `NODE_ENV=development` and a `SEED_DEMO_PASSWORD` of at least 12 characters. It refuses to run if the database already has any users. In that case use the accounts already provisioned for the database; do not delete users to make the seed pass. All seeded accounts use the one local development password held in `.env`. The seed command is not a production setup command.
6. Start the app:

   ```powershell
   npm run dev
   ```

   Then open `http://localhost:4000`. For a non-watching start, run `npm start`. Check `http://localhost:4000/api/health`; the database check is at `/api/health/db`.

   The public shell loads the versioned `/app.js?v=2026-10-17-v2` bundle. If the page remains on “Opening MediFlow…”, check the Network panel for that exact script URL and run `window.__MEDIFLOW_BUILD__` in the browser console; it should return `2026-10-17-v2`. If it is missing or different, the browser is receiving another MediFlow copy or an older cached shell. Check the terminal's working directory and restart the server from this project folder. Startup exceptions are logged to the console and the page will show a fallback message instead of remaining on the loading placeholder.

The seed account emails are `admin@mediflow.com`, `doctor@mediflow.com`, `reception@mediflow.com`, and `patient@mediflow.com`. Their password is the value of `SEED_DEMO_PASSWORD` in your private local `.env`. Demo credentials are never displayed on the public login page.

## Tests

```powershell
npm test
```

The 10 tests exercise the actual Express health endpoint, direct-refresh route fallback, static frontend serving, protected-route response, malformed registration/login input, security headers, and the absence of frontend credential storage or framework code. The startup regression executes the exact served browser bundle, verifies that it replaces “Opening MediFlow…” with the homepage when both directory results are empty, and checks the offline fallback and v2 build marker. Tests do not connect to a database. The registration flow, session persistence across server restarts, actual SQL reads/writes, appointment exclusion constraint, and refresh-after-save scenario need a dedicated disposable PostgreSQL database to verify. No Neon credentials were included in the supplied ZIP, and this rebuild does not connect to or modify a live Neon database.

## Render and Neon deployment

1. Create or select a Neon database whose schema matches the original MediFlow migration. Check the table and column names before pointing the app at it. Do not apply `schema.sql` to a database that already has these tables.
2. Create a Render **Web Service** from the `MediFlow-Simple` directory/repository.
3. Use Node 20 or later. Set the build/install command to `npm install` and the start command to `npm start`.
4. Configure these Render environment variables:
   - `NODE_ENV=production`
   - `DATABASE_URL` — private Neon connection string with TLS enabled
   - `SESSION_SECRET` — random secret with at least 32 characters
   - `SESSION_MAX_AGE_HOURS=12` (optional; defaults to 12)
   - `APP_ORIGIN=https://your-service.onrender.com` (recommended exact public origin)
   - Render supplies `PORT`; the server reads it automatically.
5. Deploy and check `/api/health`, then `/api/health/db`. Create staff accounts through an existing authorized administrator. Do not run the development seed against production.

Render's reverse proxy is trusted only in production so Express can honor HTTPS and set Secure cookies. The static website and API are served by this one service, so browser requests remain same-origin. For reliable production availability, configure Render health checks and Neon backups/retention separately.

## Common issues

- **`DATABASE_URL` missing or connection refused:** verify the private URL, database availability, IP/network settings, and TLS requirements.
- **`relation "User" does not exist`:** the connected database does not have the source schema. Confirm the target DB before loading the schema; do not point at an unrelated database.
- **`column ... does not exist`:** the database schema version differs from the source ZIP. Compare the Prisma schema and migration and prepare a reviewed additive migration.
- **`extension btree_gist` permission error:** the appointment overlap constraints use this PostgreSQL extension. Confirm the provider supports it before applying the original migration.
- **Login says incorrect password:** use the password configured when the account was created. Seeded accounts use only the local `SEED_DEMO_PASSWORD`; the source ZIP does not contain usable plaintext demo passwords.
- **Cookie/session problems on Render:** set `NODE_ENV=production`, use HTTPS, keep requests on the same origin, and set a stable secret.
- **Duplicate email:** patient email is unique in both `User` and `PatientProfile`; use another address or sign in to the existing account.
- **Appointment conflict:** choose a different doctor/time; PostgreSQL's exclusion constraint is authoritative even if two requests arrive at once.

## Viva preparation

**Why use HTML, CSS, and vanilla JavaScript?** HTML describes the page, CSS preserves the clinic's visual system, and JavaScript handles navigation, form events, and API requests without a frontend framework or build step.

**What does Express do?** Express serves the static frontend and defines API routes. Middleware validates the session and role before a route can read or change protected clinic data.

**How does the browser communicate with the backend?** The browser uses `fetch()` to send same-origin JSON requests to `/api/...`. Express replies with JSON; the session cookie is sent automatically by the browser.

**How does Express communicate with PostgreSQL?** `db.js` creates a `pg.Pool`. Route handlers use parameterized SQL; multi-table workflows borrow one client and wrap the work in `BEGIN`, `COMMIT`, and `ROLLBACK`.

**Why hash passwords with bcryptjs?** A one-way salted password hash can be checked at login without storing the original password. The app never saves a submitted plaintext password.

**What is an Express session?** It is server-side login state. The browser stores only an unpredictable session identifier in an HTTP-only cookie; the session record is stored in PostgreSQL by `connect-pg-simple`.

**What is role-based authorization?** Each authenticated user has an `ADMIN`, `DOCTOR`, `RECEPTION`, or `PATIENT` role. The API checks that role on every protected operation and scopes patient data by the authenticated identity or a clinical assignment.

**How does a patient appointment persist?** The API identifies the signed-in patient's profile, validates the selected doctor, department, date, and reason, checks conflicts, then inserts the appointment. A PostgreSQL exclusion constraint also prevents overlapping bookings.

**Why use transactions?** Registration and consultation workflows write related rows. A transaction ensures they are all saved together or none of them are, avoiding an account without a profile or a consultation without its associated diagnosis/prescription.

**How does the public registration form prevent staff privilege escalation?** It has no role field, and the server explicitly inserts the `PATIENT` role. Changing browser JavaScript or request JSON cannot select a staff role.

**What is SQL injection and how is it prevented here?** SQL injection is untrusted input changing the meaning of a SQL statement. User values are passed separately to PostgreSQL through `$1` placeholders; dynamic SQL fields are selected from fixed server-side allowlists.

**How is the session protected on deployment?** The cookie is HTTP-only and SameSite Strict, Secure in production; Express trusts the Render proxy in production, session IDs regenerate at login, and login/registration are rate limited.

**Can we claim the database has been tested?** Not yet. Static/API tests pass without a database, but this environment had no dedicated PostgreSQL test URL. Live Neon data was not used or changed.
