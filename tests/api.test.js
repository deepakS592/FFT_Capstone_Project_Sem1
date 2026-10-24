process.env.NODE_ENV='test';
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL||'postgresql://mediflow_test:mediflow_test@127.0.0.1:5432/mediflow_test';
process.env.SESSION_SECRET='test-only-secret-value-with-more-than-32-characters';

const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const request=require('supertest');
const {app}=require('../server');

test('health endpoint confirms that Express is running',async()=>{
  const response=await request(app).get('/api/health');
  assert.equal(response.status,200);
  assert.equal(response.body.status,'ok');
});

test('the public frontend is served by Express',async()=>{
  const response=await request(app).get('/');
  assert.equal(response.status,200);
  assert.match(response.text,/MediFlow Family Clinic/);
  assert.match(response.text,/src="\/app\.js\?v=2026-10-17-v2" defer/);
  assert.match(response.headers['content-type'],/text\/html/);
});

test('a dashboard route refresh serves the application shell',async()=>{
  const response=await request(app).get('/patient/appointments');
  assert.equal(response.status,200);
  assert.match(response.text,/id="app"/);
});

test('protected API data requires a session',async()=>{
  const response=await request(app).get('/api/app/bootstrap');
  assert.equal(response.status,401);
  assert.match(response.body.error,/sign in/i);
});

test('registration rejects malformed email before database access',async()=>{
  const response=await request(app).post('/api/auth/register').send({name:'Test Patient',email:'not-an-email',password:'long-development-password',phone:'+1 555 000 0000',gender:'Prefer not to say'});
  assert.equal(response.status,400);
  assert.match(response.body.error,/valid email/i);
});

test('login validates email before attempting a database lookup',async()=>{
  const response=await request(app).post('/api/auth/login').send({email:'bad',password:'secret'});
  assert.equal(response.status,400);
  assert.match(response.body.error,/valid email/i);
});

test('security headers are enabled',async()=>{
  const response=await request(app).get('/api/health');
  assert.equal(response.headers['x-content-type-options'],'nosniff');
  assert.equal(response.headers['x-frame-options'],'SAMEORIGIN');
  assert.equal(response.headers['x-powered-by'],undefined);
});

test('the browser bundle contains no React, Next.js, or local database storage',async()=>{
  const response=await request(app).get('/app.js');
  assert.equal(response.status,200);
  assert.doesNotMatch(response.text,/localStorage\.(setItem|getItem)\(['"](?:mf_session|mf_store)/);
  assert.doesNotMatch(response.text,/React|Next\.js|next\/navigation/);
});

test('the public homepage is rendered before its controls are bound and supports empty directories',async()=>{
  const response=await request(app).get('/app.js');
  assert.equal(response.status,200);
  const renderStart=response.text.indexOf('function renderLanding(');
  const markupAssignment=response.text.indexOf('app.innerHTML=`',renderStart);
  const bindCall=response.text.indexOf('bindLanding();',renderStart);
  assert.ok(renderStart>=0,'landing renderer is present');
  assert.ok(markupAssignment>renderStart&&markupAssignment<bindCall,'homepage markup is assigned before event binding');
  for(const id of ['hero-image','hero-eyebrow','hero-title','hero-copy','hero-label','hero-count','doctor-search','doctor-department','doctor-grid']){
    assert.ok(response.text.includes('id="'+id+'"'),`landing markup includes #${id}`);
  }
  assert.match(response.text,/Array\.isArray\(doctors\)\?doctors:\[\]/);
  assert.match(response.text,/Array\.isArray\(dbDepartments\)\?dbDepartments:\[\]/);
  assert.match(response.text,/site-no-results/);

  let markupAssigned=false;
  let homepage='<div class="empty">Opening MediFlow…</div>';
  const requested=[];
  const appElement={
    addEventListener(){},
    set innerHTML(value){homepage=value;markupAssigned=true;},
    get innerHTML(){return homepage;},
  };
  const control={addEventListener(){}};
  const document={
    getElementById(id){
      if(id==='app')return appElement;
      if(['doctor-search','doctor-department','doctor-grid'].includes(id))assert.equal(markupAssigned,true,'landing controls are bound only after markup exists');
      return control;
    },
  };
  const window={addEventListener(){}};
  vm.runInNewContext(response.text,{
    document,window,location:{pathname:'/'},localStorage:{getItem(){return null;}},
    fetch:async(url)=>{requested.push(url);return {ok:true,json:async()=>url.endsWith('/doctors')?{doctors:[]}:{departments:[]}};},
    setInterval(){return 1;},clearInterval(){},
  });
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(markupAssigned,true,'homepage replaces the loading placeholder with empty database results');
  assert.deepEqual(requested.sort(),['/api/departments','/api/doctors']);
  assert.equal(homepage.includes('Opening MediFlow…'),false,'loading placeholder is removed');
  assert.match(homepage,/id="care-team"/);
  assert.match(homepage,/id="doctor-search"/);
  assert.match(homepage,/id="doctor-department"/);
  assert.match(homepage,/id="doctor-grid"/);
  assert.match(homepage,/care team directory is being updated/i);
});

test('the served startup bundle exposes the v2 build marker and handles rejected directory requests',async()=>{
  const response=await request(app).get('/app.js?v=2026-10-17-v2');
  assert.equal(response.status,200);
  let homepage='<div class="empty">Opening MediFlow…</div>';
  const appElement={addEventListener(){},set innerHTML(value){homepage=value;},get innerHTML(){return homepage;}};
  const document={getElementById(id){return id==='app'?appElement:{addEventListener(){}};}};
  const window={addEventListener(){}};
  const errors=[];
  vm.runInNewContext(response.text,{
    document,window,location:{pathname:'/'},localStorage:{getItem(){return null;}},
    fetch:async()=>{throw new Error('offline');},
    setInterval(){return 1;},clearInterval(){},console:{error:(...args)=>errors.push(args)},
  });
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(window.__MEDIFLOW_BUILD__,'2026-10-17-v2');
  assert.equal(homepage.includes('Opening MediFlow…'),false);
  assert.match(homepage,/id="care-team"/);
  assert.match(homepage,/care team directory is being updated/i);
  assert.equal(errors.length,0,'failed directory requests are safely handled as empty results');
});
