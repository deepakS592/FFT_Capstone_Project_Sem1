require('dotenv').config();

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple')(session);
const { rateLimit } = require('express-rate-limit');
const { pool, query, closeDatabase } = require('./db');

const app = express();
const port = Number(process.env.PORT) || 4000;
const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET || '';

if (!process.env.DATABASE_URL) console.warn('DATABASE_URL is not set. Database-backed routes will not work.');
if (isProduction && sessionSecret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters in production.');
if (!isProduction && sessionSecret.length < 32) console.warn('Set SESSION_SECRET to a random value of at least 32 characters.');

app.set('trust proxy', isProduction ? 1 : false);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'https://images.unsplash.com', 'data:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

const PgSession = connectPgSimple;
app.use(session({
  name: 'mediflow.sid',
  secret: sessionSecret || 'development-only-change-this-session-secret-123456',
  resave: false,
  saveUninitialized: false,
  store: new PgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: isProduction,
    maxAge: 1000 * 60 * 60 * Number(process.env.SESSION_MAX_AGE_HOURS || 12),
  },
}));

// Same-origin requests are expected. This rejects cross-site form and fetch requests.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const fetchSite = req.get('sec-fetch-site');
  const origin = req.get('origin');
  const expected = process.env.APP_ORIGIN;
  if (fetchSite === 'cross-site' || (origin && expected && origin !== expected)) {
    return res.status(403).json({ error: 'This request origin is not allowed.' });
  }
  return next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait and try again.' },
});
const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many registration attempts. Please try again later.' },
});

const roles = ['ADMIN', 'DOCTOR', 'RECEPTION', 'PATIENT'];
const activeStatuses = ['Pending', 'Confirmed', 'Rescheduled'];
const appointmentStatuses = ['Pending','Confirmed','Completed','Rescheduled','Cancelled','Rejected'];
const makeId = (prefix) => prefix + '-' + crypto.randomUUID().slice(0, 8).toUpperCase();
const asDate = (value) => value ? new Date(value).toISOString().slice(0, 10) : '';
const displayTime = (value) => {
  const date = new Date(value);
  const hour = date.getUTCHours();
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return String(hour % 12 || 12).padStart(2, '0') + ':' + minute + ' ' + (hour >= 12 ? 'PM' : 'AM');
};
const cleanEmail = (value) => String(value || '').trim().toLowerCase();
const validEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
const text = (value, max, required) => {
  const result = typeof value === 'string' ? value.trim() : '';
  if (required && !result) throw httpError(400, 'Please complete all required fields.');
  if (result.length > max) throw httpError(400, 'One of the submitted fields is too long.');
  return result;
};
function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Please sign in to continue.' });
  return next();
}
function allowRoles() {
  const allowed = new Set(Array.from(arguments));
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Please sign in to continue.' });
    if (!allowed.has(req.session.user.role)) return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    return next();
  };
}
function transaction(work) {
  return async (req, res, next) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client, req);
      await client.query('COMMIT');
      return res.json(result || { saved: true });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  };
}
function audit(client, actorId, action, entity, entityId) {
  return client.query('INSERT INTO "AuditLog" ("id", "actorId", "action", "entity", "entityId") VALUES ($1,$2,$3,$4,$5)', [crypto.randomUUID(), actorId, action, entity, entityId]);
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'MediFlow Simple' }));
app.get('/api/health/db', async (_req, res, next) => {
  try { await query('SELECT 1'); return res.json({ status: 'ok', database: 'connected' }); }
  catch (error) { return next(error); }
});

app.post('/api/auth/register', registrationLimiter, async (req, res, next) => {
  let client;
  try {
    const name = text(req.body.name, 160, true);
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || '');
    const phone = text(req.body.phone, 60, true);
    if (!validEmail(email)) throw httpError(400, 'Enter a valid email address.');
    if (password.length < 12 || password.length > 200) throw httpError(400, 'Use a password between 12 and 200 characters.');
    if (!/^\+?[\d ()-]{7,60}$/.test(phone)) throw httpError(400, 'Enter a valid phone number.');
    const birthDate=validateBirthDate(req.body.dob);
    client = await pool.connect();
    await client.query('BEGIN');
    const existing = await client.query('SELECT 1 FROM "User" WHERE "email"=$1 UNION SELECT 1 FROM "PatientProfile" WHERE "email"=$1', [email]);
    if (existing.rowCount) throw httpError(409, 'An account already uses that email address.');
    const userId = 'USR-' + crypto.randomUUID();
    const patientId = makeId('PT');
    const hash = await bcrypt.hash(password, 12);
    await client.query('INSERT INTO "User" ("id","email","passwordHash","name","role","active","updatedAt") VALUES ($1,$2,$3,$4,\'PATIENT\',true,NOW())', [userId, email, hash, name]);
    await client.query('INSERT INTO "PatientProfile" ("id","userId","fullName","email","phone","dateOfBirth","gender","bloodGroup","address","emergencyContact","identification","status","registeredAt","departmentId","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,\'Pending\',NOW(),$12,NOW())', [patientId, userId, name, email, phone, birthDate, text(req.body.gender, 40, true), text(req.body.blood, 5, false), text(req.body.address, 400, false), text(req.body.emergency, 240, false), text(req.body.identification, 100, false), req.body.departmentId || null]);
    await client.query('INSERT INTO "AuditLog" ("id","actorId","action","entity","entityId") VALUES ($1,$2,\'REGISTER\',\'patient\',$3)', [crypto.randomUUID(), userId, patientId]);
    await client.query('COMMIT');
    await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
    req.session.user = { id: userId, role: 'PATIENT', name, email, patientId };
    return req.session.save((error) => error ? next(error) : res.status(201).json({ user: publicUser(req.session.user) }));
  } catch (error) {
    if(client) await client.query('ROLLBACK').catch(() => {});
    return next(error);
  } finally { if(client) client.release(); }
});

function publicUser(user) { return { id: user.id, role: user.role, name: user.name, email: user.email }; }
app.post('/api/auth/login', loginLimiter, async (req, res, next) => {
  try {
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || '');
    if (!validEmail(email) || password.length < 1 || password.length > 200) throw httpError(400, 'Enter a valid email and password.');
    const result = await query('SELECT u."id",u."email",u."name",u."role",u."passwordHash",u."active",p."id" AS "patientId" FROM "User" u LEFT JOIN "PatientProfile" p ON p."userId"=u."id" WHERE u."email"=$1', [email]);
    const user = result.rows[0];
    if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) throw httpError(401, 'Email or password is incorrect.');
    await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
    req.session.user = { id: user.id, role: user.role, name: user.name, email: user.email, patientId: user.patientId };
    return req.session.save((error) => error ? next(error) : res.json({ user: publicUser(req.session.user) }));
  } catch (error) { return next(error); }
});
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(req.session.user) }));
app.post('/api/auth/logout', requireAuth, (req, res, next) => req.session.destroy((error) => {
  if (error) return next(error);
  res.clearCookie('mediflow.sid', { httpOnly: true, sameSite: 'strict', secure: isProduction });
  return res.json({ loggedOut: true });
}));

async function getStore(user) {
  const patient = user.role === 'PATIENT' ? { id: user.patientId } : null;
  if (user.role === 'PATIENT' && !patient.id) throw httpError(404, 'Patient profile not found.');
  let appointmentSql = 'SELECT a.*, p."fullName" AS "patientName", p."userId" AS "patientUserId", d."name" AS "doctorName", dep."name" AS "departmentName" FROM "Appointment" a JOIN "PatientProfile" p ON p."id"=a."patientId" JOIN "User" d ON d."id"=a."doctorId" JOIN "Department" dep ON dep."id"=a."departmentId"';
  const appointmentValues = [];
  if (user.role === 'PATIENT') { appointmentSql += ' WHERE a."patientId"=$1'; appointmentValues.push(patient.id); }
  if (user.role === 'DOCTOR') { appointmentSql += ' WHERE a."doctorId"=$1'; appointmentValues.push(user.id); }
  appointmentSql += ' ORDER BY a."scheduledAt"';
  const patientFilter = user.role === 'PATIENT' ? ' WHERE p."id"=$1' : user.role === 'DOCTOR' ? ' WHERE EXISTS (SELECT 1 FROM "Appointment" ax WHERE ax."patientId"=p."id" AND ax."doctorId"=$1) OR EXISTS (SELECT 1 FROM "Consultation" cx WHERE cx."patientId"=p."id" AND cx."doctorId"=$1)' : '';
  const patientValues = user.role === 'PATIENT' || user.role === 'DOCTOR' ? [patient ? patient.id : user.id] : [];
  const consultationFilter = user.role === 'PATIENT' ? ' WHERE c."patientId"=$1' : user.role === 'DOCTOR' ? ' WHERE c."doctorId"=$1' : '';
  const prescriptionFilter = user.role === 'PATIENT' ? ' WHERE rx."patientId"=$1 AND rx."status"=\'Available\'' : user.role === 'DOCTOR' ? ' WHERE rx."doctorId"=$1' : '';
  const queryFilter = user.role === 'PATIENT' ? ' WHERE q."patientId"=$1' : user.role === 'DOCTOR' ? ' WHERE q."status"=\'Forwarded to Doctor\'' : '';
  const billFilter = user.role === 'PATIENT' ? ' WHERE b."patientId"=$1' : user.role === 'ADMIN' || user.role === 'RECEPTION' ? '' : ' WHERE false';
  const patientScoped = user.role === 'PATIENT';
  const patientParam = patientScoped ? [patient.id] : user.role === 'DOCTOR' ? [user.id] : [];
  const jobs = [
    query(appointmentSql, appointmentValues),
    query('SELECT p.*,p."fullName" AS name,COALESCE(dep."name",\'\') AS department,COALESCE(u."email",p."email") AS email,COALESCE(u."name",p."fullName") AS name FROM "PatientProfile" p LEFT JOIN "User" u ON u."id"=p."userId" LEFT JOIN "Department" dep ON dep."id"=p."departmentId"' + patientFilter + ' ORDER BY p."registeredAt" DESC', patientValues),
    query('SELECT d."id",u."name",u."email",d."phone",d."specialty",dep."name" AS department,d."status",d."experience",d."patients" FROM "DoctorProfile" d JOIN "User" u ON u."id"=d."userId" JOIN "Department" dep ON dep."id"=d."departmentId" ORDER BY u."name"'),
    query('SELECT r."id",u."name",u."email",r."phone",r."shift",r."status" FROM "ReceptionProfile" r JOIN "User" u ON u."id"=r."userId" ORDER BY u."name"'),
    query('SELECT d."id",d."name",d."description",u."name" AS head,(SELECT count(*)::int FROM "DoctorProfile" dp WHERE dp."departmentId"=d."id") AS doctors FROM "Department" d LEFT JOIN "User" u ON u."id"=d."headDoctorId" ORDER BY d."name"'),
    query('SELECT c.*,p."fullName" AS patient,d."name" AS doctor,COALESCE(string_agg(di."description", \'; \'),\'\') AS diagnosis FROM "Consultation" c JOIN "PatientProfile" p ON p."id"=c."patientId" JOIN "User" d ON d."id"=c."doctorId" LEFT JOIN "Diagnosis" di ON di."consultationId"=c."id"' + consultationFilter + ' GROUP BY c."id",p."fullName",d."name" ORDER BY c."date" DESC', user.role === 'PATIENT' || user.role === 'DOCTOR' ? [patientScoped ? patient.id : user.id] : []),
    query('SELECT rx.*,p."fullName" AS patient,d."name" AS doctor,COALESCE(json_agg(json_build_object(\'medicine\',COALESCE(m."name",ri."medicineName"),\'dosage\',ri."dosage",\'frequency\',ri."frequency",\'duration\',ri."duration",\'food\',ri."food",\'instructions\',ri."instructions",\'quantity\',ri."quantity\')) FILTER (WHERE ri."id" IS NOT NULL),\'[]\') AS items FROM "Prescription" rx JOIN "PatientProfile" p ON p."id"=rx."patientId" JOIN "User" d ON d."id"=rx."doctorId" LEFT JOIN "PrescriptionItem" ri ON ri."prescriptionId"=rx."id" LEFT JOIN "Medicine" m ON m."id"=ri."medicineId"' + prescriptionFilter + ' GROUP BY rx."id",p."fullName",d."name" ORDER BY rx."date" DESC', user.role === 'PATIENT' || user.role === 'DOCTOR' ? [patientScoped ? patient.id : user.id] : []),
    query('SELECT q."id",q."patientId",p."fullName" AS patient,q."subject",q."category",q."status",q."updatedAt",COALESCE(json_agg(json_build_object(\'from\',qm."senderName",\'role\',qm."senderRole",\'text\',qm."text",\'date\',qm."createdAt")) FILTER (WHERE qm."id" IS NOT NULL),\'[]\') AS messages FROM "PatientQuery" q JOIN "PatientProfile" p ON p."id"=q."patientId" LEFT JOIN "QueryMessage" qm ON qm."queryId"=q."id"' + queryFilter + ' GROUP BY q."id",p."fullName" ORDER BY q."updatedAt" DESC', patientScoped ? [patient.id] : []),
    query('SELECT n.*,\'' + user.role.toLowerCase() + '\' AS role FROM "Notification" n WHERE n."userId"=$1 ORDER BY n."createdAt" DESC', [user.id]),
    query('SELECT b.*,p."fullName" AS patient FROM "Bill" b JOIN "PatientProfile" p ON p."id"=b."patientId"' + billFilter + ' ORDER BY b."createdAt" DESC', patientScoped ? [patient.id] : []),
    query('SELECT * FROM "ClinicSettings" WHERE "id"=1'),
  ];
  const [appointments, patients, doctors, receptionists, departments, consultations, prescriptions, queries, notifications, bills, settings] = await Promise.all(jobs);
  const appointmentItems = appointments.rows.map((a) => ({ id:a.id, patient:a.patientName, patientId:a.patientId, doctor:a.doctorName, department:a.departmentName, date:asDate(a.scheduledAt), time:displayTime(a.scheduledAt), reason:a.reason, notes:a.notes, status:a.status }));
  return {
    patients: patients.rows.map((p) => ({ id:p.id, name:p.name, email:p.email, phone:p.phone, dob:asDate(p.dateOfBirth), gender:p.gender, blood:p.bloodGroup, address:p.address, emergency:p.emergencyContact, identification:p.identification, status:p.status, registered:asDate(p.registeredAt), department:p.department })),
    doctors: doctors.rows,
    receptionists: ['ADMIN','RECEPTION'].includes(user.role) ? receptionists.rows : [],
    departments: departments.rows,
    appointments: appointmentItems,
    consultations: consultations.rows.map((c) => ({ id:c.id, patient:c.patient, patientId:c.patientId, doctor:c.doctor, date:asDate(c.date), appointment:c.appointmentId || '', symptoms:c.symptoms, diagnosis:c.diagnosis, notes:c.notes, followup:c.followUp, prescriptionId:'' })),
    prescriptions: prescriptions.rows.map((rx) => ({ id:rx.id, patient:rx.patient, patientId:rx.patientId, doctor:rx.doctor, date:asDate(rx.date), diagnosis:rx.diagnosis, status:rx.status, items:rx.items })),
    queries: queries.rows.map((q) => ({ id:q.id, patient:q.patient, patientId:q.patientId, subject:q.subject, category:q.category, status:q.status, updated:asDate(q.updatedAt), messages:q.messages })),
    notifications: notifications.rows.map((n) => ({ id:n.id, role:n.role, patientId:n.patientId, message:n.message, date:asDate(n.createdAt), read:n.read, type:n.type, related:n.relatedId })),
    bills: bills.rows.map((b) => ({ id:b.id, patient:b.patient, patientId:b.patientId, date:asDate(b.createdAt), registration:Number(b.registrationFee), consultation:Number(b.consultationFee), other:Number(b.otherFee), status:b.status })),
    settings: settings.rows[0] ? { clinicName:settings.rows[0].clinicName, address:settings.rows[0].address, phone:settings.rows[0].phone, email:settings.rows[0].email, theme:'light' } : {},
  };
}
app.get('/api/app/bootstrap', requireAuth, async (req, res, next) => {
  try { return res.json({ store: await getStore(req.session.user) }); }
  catch (error) { return next(error); }
});

async function findPatient(client, actor, data) {
  if (actor.role === 'PATIENT') {
    const result = await client.query('SELECT * FROM "PatientProfile" WHERE "userId"=$1', [actor.id]);
    if (!result.rows[0]) throw httpError(404, 'Patient profile not found.');
    return result.rows[0];
  }
  if (data.patientId) {
    const result = await client.query('SELECT * FROM "PatientProfile" WHERE "id"=$1', [data.patientId]);
    if (result.rows[0]) return result.rows[0];
  }
  const result = await client.query('SELECT * FROM "PatientProfile" WHERE "fullName"=$1 OR "id"=$1 LIMIT 1', [data.patient || '']);
  if (!result.rows[0]) throw httpError(404, 'Patient record not found.');
  return result.rows[0];
}
async function findDoctor(client, name) {
  const result = await client.query('SELECT u."id",d."departmentId" FROM "User" u JOIN "DoctorProfile" d ON d."userId"=u."id" WHERE u."name"=$1 AND u."role"=\'DOCTOR\' AND u."active"=true AND d."status"=\'Active\'', [name]);
  if (!result.rows[0]) throw httpError(400, 'The selected doctor is unavailable.');
  return result.rows[0];
}
function timeAsUtc(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !/^((1[0-2])|[1-9]):[0-5]\d\s*(AM|PM)$/i.test(String(time))) throw httpError(400, 'Choose a valid date and appointment time.');
  const match = time.match(/^((1[0-2])|[1-9]):([0-5]\d)\s*(AM|PM)$/i);
  let hour = Number(match[1]) % 12;
  if (match[4].toUpperCase() === 'PM') hour += 12;
  const value = new Date(date + 'T' + String(hour).padStart(2,'0') + ':' + match[3] + ':00.000Z');
  if (Number.isNaN(value.getTime()) || value.toISOString().slice(0,10) !== date || value <= new Date()) throw httpError(400, 'Appointments must be scheduled at a valid future time.');
  return value.toISOString();
}
function validateBirthDate(value){
  if(!value)return null;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value)))throw httpError(400,'Enter a valid date of birth.');
  const parsed=new Date(value+'T00:00:00.000Z');
  if(Number.isNaN(parsed.getTime())||parsed.toISOString().slice(0,10)!==value||parsed>new Date())throw httpError(400,'Enter a valid date of birth.');
  return value;
}
async function addNotification(client, userId, message, type, relatedId, patientId) {
  await client.query('INSERT INTO "Notification" ("id","userId","patientId","message","type","relatedId") VALUES ($1,$2,$3,$4,$5,$6)', [crypto.randomUUID(),userId,patientId || null,message,type,relatedId || '']);
}
async function notifyRole(client, role, message, type, relatedId, patientId) {
  const users = await client.query('SELECT "id" FROM "User" WHERE "role"=$1 AND "active"=true', [role]);
  for (const user of users.rows) await addNotification(client,user.id,message,type,relatedId,patientId);
}

async function applyChange(client, actor, change) {
  const data = change.data || {};
  const id = String(change.id || '');
  const action = change.action;
  if (!['create','update','delete'].includes(action)) throw httpError(400, 'Unsupported change.');
  if (change.collection === 'appointments' && action === 'create') {
    if (!['ADMIN','RECEPTION','PATIENT'].includes(actor.role)) throw httpError(403, 'You cannot create appointments.');
    const patient = await findPatient(client,actor,data);
    const doctor = await findDoctor(client,data.doctor);
    const department = await client.query('SELECT "id" FROM "Department" WHERE "name"=$1', [data.department]);
    if (!department.rows[0]) throw httpError(400, 'Choose a valid department.');
    if(doctor.departmentId!==department.rows[0].id)throw httpError(400,'Choose a clinician from the selected department.');
    const scheduledAt = timeAsUtc(data.date,data.time);
    const status=actor.role==='PATIENT'?'Pending':data.status||'Pending';
    if(!appointmentStatuses.includes(status))throw httpError(400,'Choose a valid appointment status.');
    const clash = await client.query('SELECT 1 FROM "Appointment" WHERE ("doctorId"=$1 OR "patientId"=$2) AND "status"=ANY($3::text[]) AND tstzrange("scheduledAt","scheduledAt"+("durationMins" * interval \'1 minute\'),\'[)\') && tstzrange($4::timestamptz,$4::timestamptz+interval \'30 minutes\',\'[)\') LIMIT 1', [doctor.id,patient.id,activeStatuses,scheduledAt]);
    if (clash.rowCount) throw httpError(409, 'That appointment time is already booked. Choose another time.');
    await client.query('INSERT INTO "Appointment" ("id","patientId","doctorId","departmentId","scheduledAt","reason","notes","status","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())', [id,patient.id,doctor.id,department.rows[0].id,scheduledAt,text(data.reason,500,true),text(data.notes,1500,false),status]);
    if (actor.role === 'PATIENT') await notifyRole(client,'RECEPTION','New appointment request from '+patient.fullName,'Appointment',id,patient.id);
    await audit(client,actor.id,'CREATE','appointment',id); return;
  }
  if (change.collection === 'patients' && action === 'create') {
    if (!['ADMIN','RECEPTION'].includes(actor.role)) throw httpError(403,'You cannot register patients here.');
    const name = text(data.name,160,true); const email=cleanEmail(data.email); const password=String(data.password||'');
    if (!validEmail(email) || password.length<12 || password.length>200) throw httpError(400,'Enter a valid email and a password of at least 12 characters.');
    const birthDate=validateBirthDate(data.dob);
    const hash=await bcrypt.hash(password,12); const userId='USR-'+crypto.randomUUID();
    await client.query('INSERT INTO "User" ("id","email","passwordHash","name","role","updatedAt") VALUES ($1,$2,$3,$4,\'PATIENT\',NOW())',[userId,email,hash,name]);
    await client.query('INSERT INTO "PatientProfile" ("id","userId","fullName","email","phone","dateOfBirth","gender","bloodGroup","address","emergencyContact","identification","status","departmentId","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,\'Pending\',$12,NOW())',[id,userId,name,email,text(data.phone,60,true),birthDate,text(data.gender,40,false),text(data.blood,5,false),text(data.address,400,false),text(data.emergency,240,false),text(data.identification,100,false),data.departmentId||null]);
    await audit(client,actor.id,'CREATE','patient',id); await notifyRole(client,'ADMIN','New patient registration for '+name+' needs verification','Registration',id,id); return;
  }
  if (change.collection === 'doctors' && action === 'create') {
    if(actor.role!=='ADMIN') throw httpError(403,'Only administrators can add clinicians.');
    const name=text(data.name,160,true),email=cleanEmail(data.email),password=String(data.password||'');
    if(!validEmail(email)||password.length<12) throw httpError(400,'Enter a valid email and a password of at least 12 characters.');
    const department=await client.query('SELECT "id" FROM "Department" WHERE "name"=$1',[data.department]); if(!department.rows[0]) throw httpError(400,'Choose a department.');
    const userId='USR-'+crypto.randomUUID();
    await client.query('INSERT INTO "User" ("id","email","passwordHash","name","role","updatedAt") VALUES ($1,$2,$3,$4,\'DOCTOR\',NOW())',[userId,email,await bcrypt.hash(password,12),name]);
    await client.query('INSERT INTO "DoctorProfile" ("id","userId","departmentId","phone","specialty","experience","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,NOW())',[id,userId,department.rows[0].id,text(data.phone,60,false),text(data.specialty,100,false),text(data.experience,40,false)]); await audit(client,actor.id,'CREATE','doctor',id); return;
  }
  if (change.collection === 'receptionists' && action === 'create') {
    if(actor.role!=='ADMIN') throw httpError(403,'Only administrators can add receptionists.');
    const name=text(data.name,160,true),email=cleanEmail(data.email),password=String(data.password||'');
    if(!validEmail(email)||password.length<12) throw httpError(400,'Enter a valid email and a password of at least 12 characters.');
    const userId='USR-'+crypto.randomUUID();
    await client.query('INSERT INTO "User" ("id","email","passwordHash","name","role","updatedAt") VALUES ($1,$2,$3,$4,\'RECEPTION\',NOW())',[userId,email,await bcrypt.hash(password,12),name]);
    await client.query('INSERT INTO "ReceptionProfile" ("id","userId","phone","shift","updatedAt") VALUES ($1,$2,$3,$4,NOW())',[id,userId,text(data.phone,60,false),text(data.shift,40,false)||'Morning']); await audit(client,actor.id,'CREATE','receptionist',id); return;
  }
  if (change.collection === 'departments' && action === 'create') {
    if(actor.role!=='ADMIN') throw httpError(403,'Only administrators can manage departments.');
    let headId=null;if(data.head){const head=await client.query('SELECT "id" FROM "User" WHERE "name"=$1 AND "role"=\'DOCTOR\'',[data.head]);if(!head.rowCount)throw httpError(400,'Select an existing clinician.');headId=head.rows[0].id;}
    await client.query('INSERT INTO "Department" ("id","name","description","headDoctorId","updatedAt") VALUES ($1,$2,$3,$4,NOW())',[id,text(data.name,100,true),text(data.description,500,false),headId]); await audit(client,actor.id,'CREATE','department',id); return;
  }
  if (change.collection === 'queries' && action === 'create') {
    if(actor.role!=='PATIENT') throw httpError(403,'Only patients can open a new support query.');
    const patient=await findPatient(client,actor,data);
    const subject=text(data.subject,200,true),category=text(data.category,80,false)||'Other';
    const firstMessage=Array.isArray(data.messages)?data.messages[0]:{text:data.message};
    await client.query('INSERT INTO "PatientQuery" ("id","patientId","subject","category","updatedAt") VALUES ($1,$2,$3,$4,NOW())',[id,patient.id,subject,category]);
    await client.query('INSERT INTO "QueryMessage" ("id","queryId","senderId","senderName","senderRole","text") VALUES ($1,$2,$3,$4,$5,$6)',[crypto.randomUUID(),id,actor.id,actor.name,actor.role,text(firstMessage && firstMessage.text,4000,true)]);
    await notifyRole(client,'RECEPTION','New patient query: '+subject,'Query',id,patient.id);
    await audit(client,actor.id,'CREATE','query',id);return;
  }
  if (change.collection === 'notifications' && action === 'create') {
    const requested=String(data.role||'').toUpperCase();
    const targets={ADMIN:['ADMIN','DOCTOR','RECEPTION','PATIENT'],DOCTOR:['PATIENT','RECEPTION'],RECEPTION:['PATIENT','DOCTOR','ADMIN'],PATIENT:['RECEPTION']};
    const target=roles.includes(requested)?requested:'PATIENT';
    if(!targets[actor.role].includes(target))throw httpError(403,'You cannot send notifications to that role.');
    if(target==='PATIENT'){
      let patient;
      if(actor.role==='PATIENT'||data.patientId||data.patient)patient=await findPatient(client,actor,data);
      else if(data.related){const related=await client.query('SELECT "patientId" FROM "Appointment" WHERE "id"=$1 UNION SELECT "patientId" FROM "Prescription" WHERE "id"=$1 UNION SELECT "patientId" FROM "Consultation" WHERE "id"=$1 UNION SELECT "patientId" FROM "PatientQuery" WHERE "id"=$1 LIMIT 1',[data.related]);if(!related.rowCount)throw httpError(404,'Related patient record not found.');const found=await client.query('SELECT * FROM "PatientProfile" WHERE "id"=$1',[related.rows[0].patientId]);patient=found.rows[0];if(actor.role==='DOCTOR'){const assigned=await client.query('SELECT 1 FROM "Appointment" WHERE "doctorId"=$1 AND "patientId"=$2 UNION SELECT 1 FROM "Consultation" WHERE "doctorId"=$1 AND "patientId"=$2 LIMIT 1',[actor.id,patient.id]);if(!assigned.rowCount)throw httpError(403,'You cannot notify an unassigned patient.');}}
      else throw httpError(400,'Choose a patient for this notification.');
      if(patient.userId)await addNotification(client,patient.userId,text(data.message,500,true),text(data.type,80,false)||'Update',data.related,patient.id);
    }else await notifyRole(client,target,text(data.message,500,true),text(data.type,80,false)||'Update',data.related,data.patientId);
    return;
  }
  if (change.collection === 'bills' && action === 'create') {
    if(actor.role!=='RECEPTION')throw httpError(403,'Only reception can create bills.');
    const patient=await findPatient(client,actor,data);
    const amounts=['registration','consultation','other'].map((key)=>Number(data[key]||0));
    if(amounts.some((value)=>!Number.isFinite(value)||value<0))throw httpError(400,'Enter valid non-negative bill amounts.');
    await client.query('INSERT INTO "Bill" ("id","patientId","createdById","registrationFee","consultationFee","otherFee","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,NOW())',[id,patient.id,actor.id,...amounts]);
    await audit(client,actor.id,'CREATE','bill',id);return;
  }
  if (change.collection === 'appointments' && action === 'update') {
    if(!['ADMIN','RECEPTION','DOCTOR'].includes(actor.role)) throw httpError(403,'You cannot update appointments.');
    const current=await client.query('SELECT * FROM "Appointment" WHERE "id"=$1',[id]); if(!current.rows[0]) throw httpError(404,'Appointment not found.');
    const ap=current.rows[0];
    if(actor.role==='DOCTOR'&&ap.doctorId!==actor.id) throw httpError(403,'This appointment is not assigned to you.');
    if(actor.role==='DOCTOR'&&(Object.keys(data).some(k=>k!=='status')||data.status!=='Completed')) throw httpError(403,'Doctors can only complete their assigned appointments.');
    if(data.status!==undefined&&!appointmentStatuses.includes(data.status))throw httpError(400,'Choose a valid appointment status.');
    const nextDoctor=data.doctor?await findDoctor(client,data.doctor):await client.query('SELECT "departmentId" FROM "DoctorProfile" WHERE "userId"=$1',[ap.doctorId]).then((result)=>({id:ap.doctorId,departmentId:result.rows[0]?.departmentId}));
    const nextDepartment=data.department?await client.query('SELECT "id" FROM "Department" WHERE "name"=$1',[data.department]).then((result)=>result.rows[0]):{id:ap.departmentId};
    if(!nextDepartment)throw httpError(400,'Choose a valid department.');
    if(nextDoctor.departmentId!==nextDepartment.id)throw httpError(400,'Choose a clinician from the selected department.');
    const fields=[]; const values=[]; const set=(column,value)=>{values.push(value);fields.push('"'+column+'"=$'+values.length)};
    if(typeof data.status==='string') set('status',data.status);
    if(typeof data.reason==='string') set('reason',text(data.reason,500,false));
    if(typeof data.notes==='string') set('notes',text(data.notes,1500,false));
    if(data.date||data.time) set('scheduledAt',timeAsUtc(data.date||asDate(ap.scheduledAt),data.time||''));
    if(data.doctor){set('doctorId',(await findDoctor(client,data.doctor)).id)}
    if(data.department){const dep=await client.query('SELECT "id" FROM "Department" WHERE "name"=$1',[data.department]);if(!dep.rows[0])throw httpError(400,'Choose a valid department.');set('departmentId',dep.rows[0].id)}
    if(fields.length){values.push(id);await client.query('UPDATE "Appointment" SET '+fields.join(',')+',"updatedAt"=NOW() WHERE "id"=$'+values.length,values)}
    if(data.status&&data.status!==ap.status&&['Confirmed','Rejected','Rescheduled'].includes(data.status)){const recipient=await client.query('SELECT p."id" AS "patientId",p."userId",p."fullName" AS "patientName",a."doctorId" FROM "Appointment" a JOIN "PatientProfile" p ON p."id"=a."patientId" WHERE a."id"=$1',[id]);if(recipient.rows[0]){const row=recipient.rows[0];const msg=data.status==='Confirmed'?'Your appointment '+id+' has been confirmed':data.status==='Rejected'?'Your appointment request '+id+' was declined':'Your appointment '+id+' has been rescheduled';if(row.userId)await addNotification(client,row.userId,msg,'Appointment',id,row.patientId);if(data.status==='Confirmed')await addNotification(client,row.doctorId,'Appointment confirmed for '+row.patientName,'Appointment',id,row.patientId)}}
    await audit(client,actor.id,'UPDATE','appointment',id); return;
  }
  if (change.collection === 'prescriptions' && action === 'update') {
    if(actor.role!=='RECEPTION'||Object.keys(data).some(k=>k!=='status')||!['Awaiting processing','Available'].includes(data.status)) throw httpError(403,'Reception can update prescription processing status only.');
    await client.query('UPDATE "Prescription" SET "status"=$1,"updatedAt"=NOW() WHERE "id"=$2',[data.status,id]);
    const rx=await client.query('SELECT p."userId",p."id" FROM "Prescription" r JOIN "PatientProfile" p ON p."id"=r."patientId" WHERE r."id"=$1',[id]);
    if(rx.rows[0].userId) await addNotification(client,rx.rows[0].userId,'Your prescription '+id+' is ready to view','Prescription',id,rx.rows[0].id);
    await audit(client,actor.id,'PROCESS','prescription',id); return;
  }
  if (change.collection === 'notifications' && action === 'update') {
    if(typeof data.read!=='boolean'||Object.keys(data).some(k=>k!=='read')) throw httpError(400,'Notification update is invalid.');
    await client.query('UPDATE "Notification" SET "read"=$1 WHERE "id"=$2 AND "userId"=$3',[data.read,id,actor.id]); return;
  }
  if (change.collection === 'bills' && action === 'update') {
    if(actor.role!=='RECEPTION'||!['Pending','Paid','Refunded'].includes(data.status)) throw httpError(403,'Only reception can update bill payment status.');
    await client.query('UPDATE "Bill" SET "status"=$1,"updatedAt"=NOW() WHERE "id"=$2',[data.status,id]); await audit(client,actor.id,'UPDATE','bill',id); return;
  }
  if (change.collection === 'patients' && action === 'update') {
    if(!['ADMIN','RECEPTION'].includes(actor.role)) throw httpError(403,'You cannot edit patient records.');
    const mapping={name:'fullName',email:'email',phone:'phone',dob:'dateOfBirth',gender:'gender',blood:'bloodGroup',address:'address',emergency:'emergencyContact',identification:'identification',status:'status'};
    const fields=[],values=[]; for(const [key,column] of Object.entries(mapping)) if(data[key]!==undefined){ values.push(key==='email'?cleanEmail(data[key]):key==='dob'?validateBirthDate(data[key]):data[key]); fields.push('"'+column+'"=$'+values.length); }
    if(data.departmentId!==undefined){values.push(data.departmentId||null);fields.push('"departmentId"=$'+values.length)}
    if(fields.length){values.push(id);await client.query('UPDATE "PatientProfile" SET '+fields.join(',')+',"updatedAt"=NOW() WHERE "id"=$'+values.length,values)}
    const account=await client.query('SELECT "userId" FROM "PatientProfile" WHERE "id"=$1',[id]);
    if(account.rows[0]&&account.rows[0].userId){const userFields=[],userValues=[];if(data.name!==undefined){userValues.push(text(data.name,160,true));userFields.push('"name"=$'+userValues.length)}if(data.email!==undefined){userValues.push(cleanEmail(data.email));userFields.push('"email"=$'+userValues.length)}if(userFields.length){userValues.push(account.rows[0].userId);await client.query('UPDATE "User" SET '+userFields.join(',')+',"updatedAt"=NOW() WHERE "id"=$'+userValues.length,userValues)}}
    await audit(client,actor.id,'UPDATE','patient',id); return;
  }
  if(change.collection==='doctors'&&action==='update'){
    if(actor.role!=='ADMIN')throw httpError(403,'Only administrators can edit clinician records.');
    const found=await client.query('SELECT "userId" FROM "DoctorProfile" WHERE "id"=$1',[id]);if(!found.rowCount)throw httpError(404,'Doctor not found.');
    const profileFields=[],profileValues=[],userFields=[],userValues=[];
    for(const [key,column] of [['phone','phone'],['specialty','specialty'],['experience','experience'],['status','status']])if(data[key]!==undefined){profileValues.push(text(data[key],key==='experience'?40:100,false));profileFields.push('"'+column+'"=$'+profileValues.length)}
    if(data.department){const dep=await client.query('SELECT "id" FROM "Department" WHERE "name"=$1',[data.department]);if(!dep.rowCount)throw httpError(400,'Choose a department.');profileValues.push(dep.rows[0].id);profileFields.push('"departmentId"=$'+profileValues.length)}
    for(const [key,column] of [['name','name'],['email','email']])if(data[key]!==undefined){userValues.push(key==='email'?cleanEmail(data[key]):text(data[key],160,true));userFields.push('"'+column+'"=$'+userValues.length)}
    if(profileFields.length){profileValues.push(id);await client.query('UPDATE "DoctorProfile" SET '+profileFields.join(',')+',"updatedAt"=NOW() WHERE "id"=$'+profileValues.length,profileValues)}
    if(userFields.length){userValues.push(found.rows[0].userId);await client.query('UPDATE "User" SET '+userFields.join(',')+',"updatedAt"=NOW() WHERE "id"=$'+userValues.length,userValues)}
    if(data.status!==undefined)await client.query('UPDATE "User" SET "active"=$1,"updatedAt"=NOW() WHERE "id"=$2',[data.status==='Active',found.rows[0].userId]);
    await audit(client,actor.id,'UPDATE','doctor',id);return;
  }
  if(change.collection==='receptionists'&&action==='update'){
    if(actor.role!=='ADMIN')throw httpError(403,'Only administrators can edit receptionist records.');
    const found=await client.query('SELECT "userId" FROM "ReceptionProfile" WHERE "id"=$1',[id]);if(!found.rowCount)throw httpError(404,'Receptionist not found.');
    const profileFields=[],profileValues=[],userFields=[],userValues=[];
    for(const [key,column] of [['phone','phone'],['shift','shift'],['status','status']])if(data[key]!==undefined){profileValues.push(text(data[key],60,false));profileFields.push('"'+column+'"=$'+profileValues.length)}
    for(const [key,column] of [['name','name'],['email','email']])if(data[key]!==undefined){userValues.push(key==='email'?cleanEmail(data[key]):text(data[key],160,true));userFields.push('"'+column+'"=$'+userValues.length)}
    if(profileFields.length){profileValues.push(id);await client.query('UPDATE "ReceptionProfile" SET '+profileFields.join(',')+',"updatedAt"=NOW() WHERE "id"=$'+profileValues.length,profileValues)}
    if(userFields.length){userValues.push(found.rows[0].userId);await client.query('UPDATE "User" SET '+userFields.join(',')+',"updatedAt"=NOW() WHERE "id"=$'+userValues.length,userValues)}
    if(data.status!==undefined)await client.query('UPDATE "User" SET "active"=$1,"updatedAt"=NOW() WHERE "id"=$2',[data.status==='Active',found.rows[0].userId]);
    await audit(client,actor.id,'UPDATE','receptionist',id);return;
  }
  if (change.collection === 'queries' && action === 'update') {
    const record=await client.query('SELECT * FROM "PatientQuery" WHERE "id"=$1',[id]);if(!record.rows[0])throw httpError(404,'Query not found.');const q=record.rows[0];
    if(actor.role==='PATIENT'&&q.patientId!==actor.patientId)throw httpError(403,'You cannot access another patient’s query.');
    if(actor.role==='DOCTOR'&&q.status!=='Forwarded to Doctor')throw httpError(403,'This query has not been forwarded to your clinical team.');
    if(data.status){const allowed=actor.role==='PATIENT'?['In Progress','Resolved']:actor.role==='DOCTOR'?['Forwarded to Doctor','In Progress','Resolved']:['Pending','In Progress','Forwarded to Doctor','Resolved'];if(!allowed.includes(data.status))throw httpError(403,'You cannot set that query status.');await client.query('UPDATE "PatientQuery" SET "status"=$1,"updatedAt"=NOW() WHERE "id"=$2',[data.status,id]);}
    if(data.appendMessage){await client.query('INSERT INTO "QueryMessage" ("id","queryId","senderId","senderName","senderRole","text") VALUES ($1,$2,$3,$4,$5,$6)',[crypto.randomUUID(),id,actor.id,actor.name,actor.role,text(data.appendMessage,4000,true)]);const messageStatus=data.status||(actor.role==='DOCTOR'?'Resolved':'In Progress');const finalStatus=actor.role==='PATIENT'&&q.status==='Resolved'?'In Progress':messageStatus;await client.query('UPDATE "PatientQuery" SET "status"=$1,"updatedAt"=NOW() WHERE "id"=$2',[finalStatus,id]);const recipient=await client.query('SELECT p."id",p."userId" FROM "PatientProfile" p WHERE p."id"=$1',[q.patientId]);if(actor.role==='PATIENT')await notifyRole(client,'RECEPTION','Patient added a message to: '+q.subject,'Query',id,q.patientId);else if(recipient.rows[0].userId)await addNotification(client,recipient.rows[0].userId,'A response was added to your query: '+q.subject,'Query',id,recipient.rows[0].id);}
    if(Array.isArray(data.messages)){const count=await client.query('SELECT count(*)::int AS total FROM "QueryMessage" WHERE "queryId"=$1',[id]);const additions=data.messages.slice(count.rows[0].total);if(additions.length>5)throw httpError(400,'Send fewer query messages at a time.');for(const message of additions){await client.query('INSERT INTO "QueryMessage" ("id","queryId","senderId","senderName","senderRole","text") VALUES ($1,$2,$3,$4,$5,$6)',[crypto.randomUUID(),id,actor.id,actor.name,actor.role,text(message.text,4000,true)]);}if(additions.length)await client.query('UPDATE "PatientQuery" SET "updatedAt"=NOW() WHERE "id"=$1',[id]);}
    await audit(client,actor.id,'RESPOND','query',id);return;
  }
  if (change.collection === 'settings' && action === 'update') {
    if(actor.role!=='ADMIN')throw httpError(403,'Only administrators can change clinic settings.');const s=data.settings||data;
    await client.query('INSERT INTO "ClinicSettings" ("id","clinicName","address","phone","email","updatedAt") VALUES (1,$1,$2,$3,$4,NOW()) ON CONFLICT ("id") DO UPDATE SET "clinicName"=EXCLUDED."clinicName","address"=EXCLUDED."address","phone"=EXCLUDED."phone","email"=EXCLUDED."email","updatedAt"=NOW()',[text(s.clinicName,160,true),text(s.address,400,false),text(s.phone,60,false),cleanEmail(s.email)]);return;
  }
  if(change.collection==='departments'&&action==='update'){
    if(actor.role!=='ADMIN')throw httpError(403,'Only administrators can manage departments.');
    let headId;
    if(data.head!==undefined){if(data.head){const head=await client.query('SELECT "id" FROM "User" WHERE "name"=$1 AND "role"=\'DOCTOR\'',[data.head]);if(!head.rowCount)throw httpError(400,'Select an existing clinician.');headId=head.rows[0].id}else headId=null}
    await client.query('UPDATE "Department" SET "name"=COALESCE($1,"name"),"description"=COALESCE($2,"description"),"headDoctorId"=COALESCE($3,"headDoctorId"),"updatedAt"=NOW() WHERE "id"=$4',[data.name||null,data.description===undefined?null:data.description,headId===undefined?null:headId,id]);await audit(client,actor.id,'UPDATE','department',id);return;
  }
  throw httpError(400,'This record change is not supported.');
}

app.post('/api/app/changes', requireAuth, async (req,res,next)=>{
  const changes=req.body.changes;
  if(!Array.isArray(changes)||changes.length<1||changes.length>50)return res.status(400).json({error:'Submit between 1 and 50 changes.'});
  const client=await pool.connect();
  try{await client.query('BEGIN');for(const change of changes)await applyChange(client,req.session.user,change);await client.query('COMMIT');return res.json({saved:changes.length});}
  catch(error){await client.query('ROLLBACK').catch(()=>{});return next(error)}finally{client.release()}
});

app.post('/api/consultations', requireAuth, allowRoles('DOCTOR'), async (req,res,next)=>{
  const client=await pool.connect();
  try{
    const patientId=text(req.body.patientId,100,true),symptoms=text(req.body.symptoms,3000,true),diagnosis=text(req.body.diagnosis,2000,true);
    await client.query('BEGIN');
    const assignment=await client.query('SELECT * FROM "Appointment" WHERE "id"=$1 AND "doctorId"=$2 AND "patientId"=$3 AND "status"=ANY($4::text[])',[req.body.appointmentId||'',req.session.user.id,patientId,['Confirmed','Completed']]);
    const prior=!req.body.appointmentId?await client.query('SELECT 1 FROM "Appointment" WHERE "doctorId"=$1 AND "patientId"=$2 AND "status"=ANY($3::text[]) LIMIT 1',[req.session.user.id,patientId,['Confirmed','Completed']]):null;
    if(req.body.appointmentId&&!assignment.rowCount)throw httpError(403,'This appointment is not assigned to your clinical workspace.');
    if(!req.body.appointmentId&&!prior.rowCount)throw httpError(403,'You do not have an authorized clinical relationship with this patient.');
    const patient=await client.query('SELECT * FROM "PatientProfile" WHERE "id"=$1',[patientId]);if(!patient.rowCount)throw httpError(404,'Patient record not found.');
    const consultationId=makeId('CN');
    await client.query('INSERT INTO "Consultation" ("id","patientId","doctorId","appointmentId","symptoms","notes","followUp","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())',[consultationId,patientId,req.session.user.id,req.body.appointmentId||null,symptoms,text(req.body.notes,5000,false),text(req.body.followup,500,false)]);
    await client.query('INSERT INTO "Diagnosis" ("id","consultationId","description") VALUES ($1,$2,$3)',[crypto.randomUUID(),consultationId,diagnosis]);
    if(req.body.appointmentId)await client.query('UPDATE "Appointment" SET "status"=\'Completed\',"updatedAt"=NOW() WHERE "id"=$1',[req.body.appointmentId]);
    let prescriptionId=null;
    const items=Array.isArray(req.body.items)?req.body.items.filter((item)=>item.medicine&&item.dosage):[];
    if(items.length){
      if(items.length>20)throw httpError(400,'A prescription can have up to 20 items.');
      const pResult=await client.query('INSERT INTO "Prescription" ("id","consultationId","patientId","doctorId","diagnosis","updatedAt") VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING "id"',[makeId('RX'),consultationId,patientId,req.session.user.id,diagnosis]);
      prescriptionId=pResult.rows[0].id;
      for(const item of items){const med=text(item.medicine,160,true);const found=await client.query('SELECT "id","name" FROM "Medicine" WHERE lower("name")=lower($1) AND "active"=true',[med]);if(!found.rowCount)throw httpError(400,'Medicine '+med+' is not in the clinic formulary.');await client.query('INSERT INTO "PrescriptionItem" ("id","prescriptionId","medicineId","medicineName","dosage","frequency","duration","food","instructions") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[crypto.randomUUID(),prescriptionId,found.rows[0].id,found.rows[0].name,text(item.dosage,100,true),text(item.frequency,100,true),text(item.duration,100,true),text(item.food,100,false),text(item.instructions,500,false)]);}
      await notifyRole(client,'RECEPTION','Prescription '+prescriptionId+' is awaiting processing','Prescription',prescriptionId,patientId);
    }
    if(patient.rows[0].userId)await addNotification(client,patient.rows[0].userId,'Your consultation record has been updated','Consultation',consultationId,patientId);
    await audit(client,req.session.user.id,'CREATE','consultation',consultationId);await client.query('COMMIT');return res.status(201).json({consultationId,prescriptionId});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});return next(error)}finally{client.release()}
});

app.get('/api/departments', async (_req,res,next)=>{try{return res.json({departments:(await query('SELECT "id","name","description" FROM "Department" ORDER BY "name"')).rows})}catch(e){return next(e)}});
app.get('/api/doctors', async (_req,res,next)=>{try{return res.json({doctors:(await query('SELECT d."id",u."name",u."email",d."phone",d."specialty",dep."name" AS department,d."status" FROM "DoctorProfile" d JOIN "User" u ON u."id"=d."userId" JOIN "Department" dep ON dep."id"=d."departmentId" ORDER BY u."name"')).rows})}catch(e){return next(e)}});
app.post('/api/appointments', requireAuth, async(req,res,next)=>{try{const id=makeId('AP');await applyStandalone(req,res,next,{collection:'appointments',id,action:'create',data:req.body});}catch(e){next(e)}});
async function applyStandalone(req,res,next,change){const client=await pool.connect();try{await client.query('BEGIN');await applyChange(client,req.session.user,change);await client.query('COMMIT');return res.status(201).json({id:change.id})}catch(e){await client.query('ROLLBACK').catch(()=>{});return next(e)}finally{client.release()}}
app.post('/api/queries', requireAuth, allowRoles('PATIENT'), async(req,res,next)=>{try{const id=makeId('Q');await applyStandalone(req,res,next,{collection:'queries',id,action:'create',data:{...req.body,patientId:req.session.user.patientId}})}catch(e){next(e)}});
app.post('/api/queries/:id/messages', requireAuth, async(req,res,next)=>{try{const q=await query('SELECT "id" FROM "PatientQuery" WHERE "id"=$1',[req.params.id]);if(!q.rowCount)return res.status(404).json({error:'Query not found.'});const message=text(req.body.message,4000,true);const client=await pool.connect();try{await client.query('BEGIN');await applyChange(client,req.session.user,{collection:'queries',id:req.params.id,action:'update',data:{appendMessage:message}});await client.query('COMMIT');return res.status(201).json({sent:true})}catch(e){await client.query('ROLLBACK').catch(()=>{});return next(e)}finally{client.release()}}catch(e){return next(e)}});
app.patch('/api/appointments/:id',requireAuth,allowRoles('ADMIN','RECEPTION','DOCTOR'),async(req,res,next)=>applyStandalone(req,res,next,{collection:'appointments',id:req.params.id,action:'update',data:req.body}));
app.patch('/api/prescriptions/:id/status',requireAuth,allowRoles('RECEPTION'),async(req,res,next)=>applyStandalone(req,res,next,{collection:'prescriptions',id:req.params.id,action:'update',data:req.body}));
app.patch('/api/notifications/:id/read',requireAuth,async(req,res,next)=>applyStandalone(req,res,next,{collection:'notifications',id:req.params.id,action:'update',data:req.body}));
app.patch('/api/bills/:id/payment-status',requireAuth,allowRoles('RECEPTION'),async(req,res,next)=>applyStandalone(req,res,next,{collection:'bills',id:req.params.id,action:'update',data:req.body}));
app.post('/api/bills',requireAuth,allowRoles('RECEPTION'),async(req,res,next)=>{const id=makeId('BL');const client=await pool.connect();try{const amounts=['registration','consultation','other'].map(key=>Number(req.body[key]||0));if(amounts.some(value=>!Number.isFinite(value)||value<0))throw httpError(400,'Enter valid non-negative bill amounts.');await client.query('BEGIN');const patient=await findPatient(client,req.session.user,req.body);await client.query('INSERT INTO "Bill" ("id","patientId","createdById","registrationFee","consultationFee","otherFee","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,NOW())',[id,patient.id,req.session.user.id,...amounts]);await client.query('COMMIT');return res.status(201).json({id})}catch(e){await client.query('ROLLBACK').catch(()=>{});return next(e)}finally{client.release()}});
app.get('/api/medicines',requireAuth,allowRoles('ADMIN','DOCTOR','RECEPTION'),async(req,res,next)=>{try{return res.json({medicines:(await query('SELECT "id","name","form","strength","stock","reorderAt" FROM "Medicine" WHERE "active"=true ORDER BY "name"')).rows})}catch(e){return next(e)}});
app.patch('/api/medicines/:id/stock',requireAuth,allowRoles('ADMIN','RECEPTION'),async(req,res,next)=>{try{const stock=Number(req.body.stock);if(!Number.isInteger(stock)||stock<0||stock>100000)throw httpError(400,'Enter a valid stock count.');await query('UPDATE "Medicine" SET "stock"=$1,"updatedAt"=NOW() WHERE "id"=$2',[stock,req.params.id]);await audit(pool,req.session.user.id,'STOCK_UPDATE','medicine',req.params.id);return res.json({updated:true,stock})}catch(e){return next(e)}});
app.post('/api/departments',requireAuth,allowRoles('ADMIN'),async(req,res,next)=>{const id=makeId('DP');try{await applyStandalone(req,res,next,{collection:'departments',id,action:'create',data:req.body})}catch(e){next(e)}});
app.patch('/api/departments/:id',requireAuth,allowRoles('ADMIN'),async(req,res,next)=>applyStandalone(req,res,next,{collection:'departments',id:req.params.id,action:'update',data:req.body}));
app.delete('/api/departments/:id',requireAuth,allowRoles('ADMIN'),async(req,res,next)=>{const client=await pool.connect();try{await client.query('BEGIN');await client.query('DELETE FROM "Department" WHERE "id"=$1',[req.params.id]);await audit(client,req.session.user.id,'DELETE','department',req.params.id);await client.query('COMMIT');return res.status(204).end()}catch(e){await client.query('ROLLBACK').catch(()=>{});return next(e)}finally{client.release()}});
app.get('/api/users',requireAuth,allowRoles('ADMIN'),async(_req,res,next)=>{try{return res.json({users:(await query('SELECT "id","email","name","role","active","createdAt" FROM "User" ORDER BY "name"')).rows})}catch(e){return next(e)}});
app.post('/api/users',requireAuth,allowRoles('ADMIN'),async(req,res,next)=>{try{const type=req.body.profile;if(!['doctor','receptionist'].includes(type))throw httpError(400,'Choose a supported staff role.');const id=makeId(type==='doctor'?'DR':'RC');const change={collection:type==='doctor'?'doctors':'receptionists',id,action:'create',data:req.body};await applyStandalone(req,res,next,change)}catch(e){return next(e)}});
app.patch('/api/profile',requireAuth,async(req,res,next)=>{const client=await pool.connect();try{await client.query('BEGIN');const user=req.session.user;if(user.role==='PATIENT'){await client.query('UPDATE "PatientProfile" SET "phone"=$1,"updatedAt"=NOW() WHERE "userId"=$2',[text(req.body.phone,60,true),user.id])}else if(user.role==='DOCTOR'){await client.query('UPDATE "DoctorProfile" SET "phone"=$1,"updatedAt"=NOW() WHERE "userId"=$2',[text(req.body.phone,60,true),user.id])}else if(user.role==='RECEPTION'){await client.query('UPDATE "ReceptionProfile" SET "phone"=$1,"updatedAt"=NOW() WHERE "userId"=$2',[text(req.body.phone,60,true),user.id])}await client.query('COMMIT');return res.json({updated:true})}catch(e){await client.query('ROLLBACK').catch(()=>{});return next(e)}finally{client.release()}});

// Static frontend and direct dashboard URLs are served by this same Express service.
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: isProduction ? '1h' : 0 }));
app.use((req,res,next)=>{
  if(req.path.startsWith('/api/'))return next();
  if(req.method!=='GET')return next();
  return res.sendFile(path.join(__dirname,'public','index.html'));
});

app.use((error,req,res,_next)=>{
  let status=Number(error.status)||500;
  let message=error.message||'Something went wrong.';
  if(error.code==='23505'){status=409;message='That email address or record already exists.';}
  else if(error.code==='23P01'||error.code==='23514'){status=409;message='That appointment time conflicts with another visit. Choose another time.';}
  else if(error.code==='23503'){status=400;message='This record is linked to existing clinic data and cannot be changed that way.';}
  if(status>=500){console.error('Request failed:',req.method,req.path,error.message);message='The server could not complete your request. Please try again.';}
  return res.status(status).json({error:message});
});

if (require.main === module) {
  const server=app.listen(port,()=>console.log('MediFlow Simple listening on port '+port));
  const stop=async()=>{server.close(async()=>{await closeDatabase();process.exit(0)})};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
module.exports={app,transaction,getStore};
