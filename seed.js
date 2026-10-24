require('dotenv').config();
const bcrypt=require('bcryptjs');
const {pool}=require('./db');

async function seed(){
  if(process.env.NODE_ENV!=='development')throw new Error('The synthetic seed can run only when NODE_ENV=development.');
  const password=process.env.SEED_DEMO_PASSWORD||'';
  if(password.length<12)throw new Error('Set SEED_DEMO_PASSWORD to a development-only password of at least 12 characters.');
  const client=await pool.connect();
  try{
    const users=await client.query('SELECT count(*)::int AS count FROM "User"');
    if(users.rows[0].count)throw new Error('The database already contains users. Seed stopped without changing data.');
    await client.query('BEGIN');
    const hash=await bcrypt.hash(password,12);
    const accounts=[
      ['USR-DEMO-ADMIN','admin@mediflow.com','Olivia Bennett','ADMIN'],
      ['USR-DEMO-DOCTOR','doctor@mediflow.com','Dr. Aiden Morgan','DOCTOR'],
      ['USR-DEMO-GRACE','grace.kim@mediflow.com','Dr. Grace Kim','DOCTOR'],
      ['USR-DEMO-ETHAN','ethan.brooks@mediflow.com','Dr. Ethan Brooks','DOCTOR'],
      ['USR-DEMO-ZOE','zoe.martinez@mediflow.com','Dr. Zoe Martinez','DOCTOR'],
      ['USR-DEMO-RECEPTION','reception@mediflow.com','Mia Carter','RECEPTION'],
      ['USR-DEMO-PATIENT','patient@mediflow.com','Emma Wilson','PATIENT'],
    ];
    for(const u of accounts)await client.query('INSERT INTO "User" ("id","email","passwordHash","name","role","updatedAt") VALUES ($1,$2,$3,$4,$5,NOW())',[u[0],u[1],hash,u[2],u[3]]);
    const departments=[['DP-01','Cardiology','Heart and cardiovascular care','USR-DEMO-DOCTOR'],['DP-02','General Medicine','Primary and preventive care','USR-DEMO-GRACE'],['DP-03','Orthopedics','Bone, joint and movement care','USR-DEMO-ETHAN'],['DP-04','Dermatology','Skin, hair and nail care','USR-DEMO-ZOE']];
    for(const d of departments)await client.query('INSERT INTO "Department" ("id","name","description","headDoctorId","updatedAt") VALUES ($1,$2,$3,$4,NOW())',[d[0],d[1],d[2],d[3]]);
    const doctors=[['DR-021','USR-DEMO-DOCTOR','DP-01','+1 (555) 210-4401','Cardiology','12 years',128],['DR-022','USR-DEMO-GRACE','DP-02','+1 (555) 210-4402','General Medicine','9 years',96],['DR-023','USR-DEMO-ETHAN','DP-03','+1 (555) 210-4403','Orthopedics','15 years',114],['DR-024','USR-DEMO-ZOE','DP-04','+1 (555) 210-4404','Dermatology','7 years',82]];
    for(const d of doctors)await client.query('INSERT INTO "DoctorProfile" ("id","userId","departmentId","phone","specialty","experience","patients","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())',d);
    await client.query('INSERT INTO "ReceptionProfile" ("id","userId","phone","shift","updatedAt") VALUES ($1,$2,$3,$4,NOW())',['RC-012','USR-DEMO-RECEPTION','+1 (555) 310-4401','Morning']);
    const patientRows=[
      ['PT-1048','USR-DEMO-PATIENT','Emma Wilson','emma.wilson@example.com','+1 (555) 010-2831','1992-04-18','Female','O+','24 Willow Lane, Brookfield','James Wilson · +1 (555) 010-2832','DP-01','Verified'],
      ['PT-1049',null,'Noah Johnson','noah.j@example.com','+1 (555) 010-4490','1985-09-02','Male','A+','8 Lakeview Dr, Brookfield','Sara Johnson · +1 (555) 010-4491','DP-02','Verified'],
      ['PT-1050',null,'Sophia Patel','sophia.p@example.com','+1 (555) 010-6224','2001-01-12','Female','B+','91 Park Ave, Brookfield','Ravi Patel · +1 (555) 010-6225','DP-04','Pending'],
      ['PT-1051',null,'Liam Chen','liam.chen@example.com','+1 (555) 010-7318','1978-11-29','Male','AB+','5 Orchard St, Brookfield','Mei Chen · +1 (555) 010-7319','DP-03','Verified'],
      ['PT-1052',null,'Ava Thompson','ava.t@example.com','+1 (555) 010-8627','1996-07-06','Female','O-','14 Cedar Ct, Brookfield','Mark Thompson · +1 (555) 010-8628','DP-01','Verified'],
    ];
    for(const p of patientRows)await client.query('INSERT INTO "PatientProfile" ("id","userId","fullName","email","phone","dateOfBirth","gender","bloodGroup","address","emergencyContact","status","departmentId","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())',p);
    const dates=[0,0,1,0,-2,6].map(n=>{const d=new Date();d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)});
    const times=['09:00','10:30','11:00','14:00','15:30','10:00'];
    const appointments=[['AP-2081','PT-1048','USR-DEMO-DOCTOR','DP-01',0,'Routine heart checkup','Confirmed'],['AP-2082','PT-1049','USR-DEMO-GRACE','DP-02',1,'Seasonal allergies','Confirmed'],['AP-2083','PT-1050','USR-DEMO-ZOE','DP-04',2,'Skin consultation','Pending'],['AP-2084','PT-1051','USR-DEMO-ETHAN','DP-03',3,'Knee pain follow-up','Confirmed'],['AP-2085','PT-1052','USR-DEMO-DOCTOR','DP-01',4,'Blood pressure review','Completed'],['AP-2086','PT-1048','USR-DEMO-GRACE','DP-02',5,'Annual wellness visit','Pending']];
    for(const a of appointments){const i=a[4],day=dates[i],time=times[i];await client.query('INSERT INTO "Appointment" ("id","patientId","doctorId","departmentId","scheduledAt","reason","status","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())',[a[0],a[1],a[2],a[3],day+'T'+time+':00.000Z',a[5],a[6]])}
    const visits=[['CN-041','PT-1048','USR-DEMO-DOCTOR','AP-2085','Occasional headaches, elevated home blood pressure','Vitals stable. Discussed lower sodium diet and daily monitoring.','Review in 4 weeks','Mild hypertension'],['CN-040','PT-1049','USR-DEMO-GRACE',null,'Sneezing, nasal congestion','No signs of infection. Start antihistamine.','As needed','Allergic rhinitis']];
    for(const v of visits){const c=await client.query('INSERT INTO "Consultation" ("id","patientId","doctorId","appointmentId","symptoms","notes","followUp","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING "id"',v.slice(0,7));await client.query('INSERT INTO "Diagnosis" ("id","consultationId","description") VALUES ($1,$2,$3)',[crypto.randomUUID(),c.rows[0].id,v[7]])}
    const medicines=[['Amlodipine',100,20],['Cetirizine',100,20]];
    for(const medicine of medicines)await client.query('INSERT INTO "Medicine" ("name","stock","reorderAt") VALUES ($1,$2,$3)',medicine);
    const rx=[['RX-0632','CN-041','PT-1048','USR-DEMO-DOCTOR','Mild hypertension','Available','Amlodipine','5 mg','Once daily','30 days','After food','Take at the same time each day.'],['RX-0631','CN-040','PT-1049','USR-DEMO-GRACE','Allergic rhinitis','Awaiting processing','Cetirizine','10 mg','Once daily','7 days','After food','May cause drowsiness.']];
    for(const r of rx){await client.query('INSERT INTO "Prescription" ("id","consultationId","patientId","doctorId","diagnosis","status","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,NOW())',r.slice(0,6));await client.query('INSERT INTO "PrescriptionItem" ("id","prescriptionId","medicineId","medicineName","dosage","frequency","duration","food","instructions") SELECT $1,$2,"id",$3,$4,$5,$6,$7,$8 FROM "Medicine" WHERE "name"=$3',[crypto.randomUUID(),r[0],...r.slice(6)])}
    const queryRows=[['Q-301','PT-1048','Prescription timing','Medication','Pending','USR-DEMO-PATIENT','Emma Wilson','PATIENT','Should I take my new prescription before or after breakfast?'],['Q-302','PT-1049','Follow-up appointment','Appointments','In Progress',null,'Noah Johnson','PATIENT','Can I move my follow-up to next week?'],['Q-303','PT-1052','Blood pressure results','Medical question','Forwarded to Doctor',null,'Ava Thompson','PATIENT','My home readings are still high. Should I adjust the dose?']];
    for(const q of queryRows){await client.query('INSERT INTO "PatientQuery" ("id","patientId","subject","category","status","updatedAt") VALUES ($1,$2,$3,$4,$5,NOW())',q.slice(0,5));await client.query('INSERT INTO "QueryMessage" ("id","queryId","senderId","senderName","senderRole","text") VALUES ($1,$2,$3,$4,$5,$6)',[crypto.randomUUID(),q[0],q[5],q[6],q[7],q[8]])}
    await client.query('INSERT INTO "Bill" ("id","patientId","registrationFee","consultationFee","otherFee","status","updatedAt") VALUES ($1,$2,0,85,0,\'Paid\',NOW()),($3,$4,0,75,12,\'Pending\',NOW())',['BL-091','PT-1048','BL-092','PT-1049']);
    await client.query('INSERT INTO "ClinicSettings" ("id","clinicName","address","phone","email","updatedAt") VALUES (1,$1,$2,$3,$4,NOW()) ON CONFLICT ("id") DO NOTHING',['MediFlow Family Clinic','180 Harbor Street, Brookfield','+1 (555) 800-2400','hello@mediflow.com']);
    await client.query('COMMIT');
    console.log('Created synthetic demo data. Sign in with a demo account and the password configured by SEED_DEMO_PASSWORD.');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}finally{client.release();await pool.end()}
}
seed().catch(error=>{console.error('Synthetic seed stopped:',error.message);process.exitCode=1});
