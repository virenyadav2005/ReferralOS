import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, migrateDatabase, closeDatabase } from '../src/database.js';
import { readConfig } from '../src/config.js';
import { createScreenshotExtractor, ScreenshotExtractionError } from '../src/screenshot-extraction.js';
import { createEmailProvider } from '../src/email.js';

class ApiClient {
  constructor(base) { this.base=base; this.cookies=new Map(); }
  async call(route, { method='GET', body, rawBody, origin='http://127.0.0.1:5173', skipCsrf=false }={}) {
    method=method.toUpperCase();
    let csrf='';
    if (!skipCsrf && !['GET','HEAD','OPTIONS'].includes(method)) csrf=(await this.call('/auth/csrf')).data.token;
    const headers=new Headers();
    headers.set('connection','close');
    if (this.cookies.size) headers.set('cookie',[...this.cookies].map(([key,value])=>`${key}=${value}`).join('; '));
    if (!['GET','HEAD','OPTIONS'].includes(method)) headers.set('origin',origin);
    if (csrf) headers.set('x-csrf-token',csrf);
    let payload;
    if (rawBody) payload=rawBody;
    else if (body!==undefined) { if(body instanceof FormData)payload=body;else{headers.set('content-type','application/json');payload=JSON.stringify(body);} }
    const response=await fetch(`${this.base}/api${route}`,{method,headers,body:payload});
    for (const cookie of response.headers.getSetCookie()) {
      const pair=cookie.split(';')[0];const index=pair.indexOf('=');
      if(index>=0)this.cookies.set(pair.slice(0,index),decodeURIComponent(pair.slice(index+1)));
    }
    const contentType=response.headers.get('content-type')??'';
    const data=response.status===204?null:contentType.includes('application/json')?await response.json():await response.arrayBuffer();
    return { status:response.status,data,response };
  }
}

test('local origin configuration is exact and supports an explicit allowlist', () => {
  assert.deepEqual(readConfig({}).allowedOrigins,['http://127.0.0.1:5173']);
  assert.equal(readConfig({}).demoMode,false,'demo mode is off unless explicitly enabled');
  assert.equal(readConfig({NODE_ENV:'production'}).demoMode,false,'production does not default into read-only mode');
  assert.equal(readConfig({NODE_ENV:'production'}).emailProvider,'unconfigured','production never falls back to local console email');
  assert.equal(readConfig({NODE_ENV:'production'}).host,'0.0.0.0','production binds to the platform interface by default');
  assert.equal(readConfig({DEMO_MODE:'true'}).demoMode,true,'read-only mode remains available as an explicit opt-in');
  assert.deepEqual(readConfig({APP_ORIGINS:'http://127.0.0.1:5173, http://localhost:5173'}).allowedOrigins,
    ['http://127.0.0.1:5173','http://localhost:5173']);
  assert.throws(()=>readConfig({APP_ORIGINS:'*'}),/Invalid frontend origin|exact http\(s\) origins/);
});

test('launch migration preserves existing application records and is repeatable', (t) => {
  const directory=mkdtempSync(path.join(os.tmpdir(),'referralos-migration-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const db=openDatabase(path.join(directory,'legacy.sqlite'));
  try{
    db.exec(`CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
    for(const name of ['001_initial.sql','002_workflow_progress.sql']){
      db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
      db.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run(name);
    }
    db.prepare('INSERT INTO users(id,email,password_hash) VALUES (?,?,?)').run('user-legacy','legacy@example.test','existing-hash');
    db.prepare('INSERT INTO profiles(user_id,display_name) VALUES (?,?)').run('user-legacy','Legacy Employee');
    db.prepare("INSERT INTO user_roles(user_id,role) VALUES (?,'employee')").run('user-legacy');
    db.prepare('INSERT INTO companies(id,name,slug) VALUES (?,?,?)').run('company-legacy','Legacy Co','legacy-co');
    db.prepare("INSERT INTO employee_affiliations(id,user_id,company_id,status,work_email) VALUES (?,?,?,'verified',?)").run('affiliation-legacy','user-legacy','company-legacy','legacy@legacy.example');
    db.prepare(`INSERT INTO jobs(id,company_id,posted_by,title,description,location,location_type,experience_level,employment_type,workflow_template,status,expires_at)
      VALUES ('job-legacy','company-legacy','user-legacy','Legacy role','Legacy saved description for data-preservation validation.','Remote','remote','mid','full_time','request_employee','published',?)`).run(new Date(Date.now()+86400000).toISOString());
    db.prepare(`INSERT INTO referral_requests(id,job_id,candidate_id,employee_id,status) VALUES ('request-legacy','job-legacy','user-legacy','user-legacy','pending')`).run();
    db.prepare(`INSERT INTO referral_status_history(id,request_id,actor_id,to_status,note) VALUES ('history-legacy','request-legacy','user-legacy','pending','preserve this history')`).run();
    db.prepare(`INSERT INTO notifications(id,user_id,type,title,body) VALUES ('notification-legacy','user-legacy','legacy','Keep me','Existing notification')`).run();
    db.prepare(`INSERT INTO audit_events(id,actor_id,action,entity_type,entity_id) VALUES ('audit-legacy','user-legacy','legacy.action','job','job-legacy')`).run();
    db.prepare(`INSERT INTO bookmarks(user_id,job_id) VALUES ('user-legacy','job-legacy')`).run();
    migrateDatabase(db);migrateDatabase(db);
    assert.equal(db.prepare('SELECT display_name FROM profiles WHERE user_id=?').get('user-legacy').display_name,'Legacy Employee');
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get('job-legacy').status,'published');
    assert.equal(db.prepare('SELECT status FROM referral_requests WHERE id=?').get('request-legacy').status,'pending');
    assert.equal(db.prepare('SELECT note FROM referral_status_history WHERE id=?').get('history-legacy').note,'preserve this history');
    assert.equal(db.prepare('SELECT COUNT(*) count FROM notifications WHERE id=?').get('notification-legacy').count,1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM audit_events WHERE id=?').get('audit-legacy').count,1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM bookmarks WHERE user_id=?').get('user-legacy').count,1);
    assert.equal(db.prepare('SELECT work_email_verified_at FROM employee_affiliations WHERE id=?').get('affiliation-legacy').work_email_verified_at,null);
    db.prepare("UPDATE jobs SET status='closed' WHERE id='job-legacy'").run();
    db.prepare("UPDATE referral_requests SET status='expired' WHERE id='request-legacy'").run();
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{closeDatabase(db);}
});

test('demo seed is idempotent and remains clearly fictional', (t) => {
  const directory=mkdtempSync(path.join(os.tmpdir(),'referralos-seed-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');const filename=path.join(directory,'seed.sqlite');
  const run=()=>{const result=spawnSync(process.execPath,['apps/api/src/scripts/seed.js'],{cwd:root,env:{...process.env,DATABASE_PATH:filename,NODE_ENV:'test'},encoding:'utf8'});assert.equal(result.status,0,result.stderr);};
  run();run();const db=openDatabase(filename);
  try{assert.equal(db.prepare('SELECT COUNT(*) count FROM jobs WHERE is_demo=1').get().count,6);assert.equal(db.prepare("SELECT COUNT(*) count FROM users WHERE email='demo-poster@referralos.example' AND disabled_at IS NOT NULL").get().count,1);assert.equal(db.prepare("SELECT COUNT(*) count FROM jobs WHERE description LIKE 'DEMO DATA — fictional example listing.%'").get().count,6);}finally{closeDatabase(db);}
});

test('OCR.space adapter sends multipart requests and preserves raw text without inventing a description',async()=>{
  const base={nodeEnv:'test',screenshotOcrUrl:'https://api.ocr.space/parse/image',screenshotOcrApiKey:'test-only'};
  let request;
  const extractor=createScreenshotExtractor(base,{fetchImpl:async(url,options)=>{request={url,options};return{ok:true,status:200,json:async()=>({OCRExitCode:1,IsErroredOnProcessing:false,ParsedResults:[{ParsedText:'Senior Engineer\\nRemote · TypeScript'}]})};}});
  const result=await extractor.extract([{mimeType:'image/png',buffer:Buffer.from('image')}]);
  assert.equal(String(request.url),'https://api.ocr.space/parse/image');
  assert.equal(request.options.method,'POST');assert.equal(request.options.headers.apikey,'test-only');assert.equal(request.options.headers.authorization,undefined);
  assert.ok(request.options.body instanceof FormData);assert.equal(request.options.body.get('language'),'eng');assert.equal(request.options.body.get('isOverlayRequired'),'false');
  assert.equal(request.options.body.get('file').name,'screenshot.png');assert.equal(result.provider,'ocr.space');
  assert.equal(result.rawText,'Senior Engineer\\nRemote · TypeScript');assert.equal(result.fields.description.value,null);assert.equal(result.fields.title.value,null);
});

test('OCR.space adapter categorizes failures without echoing provider content or credentials',async()=>{
  const base={nodeEnv:'production',screenshotOcrUrl:'https://api.ocr.space/parse/image',screenshotOcrApiKey:'never-log-this-key'};
  const image=[{mimeType:'image/jpeg',buffer:Buffer.from('private-image-bytes')}];
  const failed=createScreenshotExtractor(base,{fetchImpl:async()=>({ok:false,status:503,text:async()=>'private-provider-response'})});
  await assert.rejects(()=>failed.extract(image),(error)=>error instanceof ScreenshotExtractionError&&error.category==='http_error'&&error.httpStatus===503&&!error.message.includes('private-provider-response')&&!error.message.includes('never-log-this-key'));
  const invalidJson=createScreenshotExtractor(base,{fetchImpl:async()=>({ok:true,status:200,json:async()=>{throw new Error('private payload');}})});
  await assert.rejects(()=>invalidJson.extract(image),(error)=>error.category==='invalid_json'&&error.httpStatus===200&&!error.message.includes('private payload'));
  const providerError=createScreenshotExtractor(base,{fetchImpl:async()=>({ok:true,status:200,json:async()=>({OCRExitCode:4,IsErroredOnProcessing:true,ErrorMessage:'private provider details'})})});
  await assert.rejects(()=>providerError.extract(image),(error)=>error.category==='provider_response_error'&&!error.message.includes('private provider details'));
});

test('verification email adapter keeps previews development-only and fails closed in production',async()=>{
  const development=createEmailProvider({nodeEnv:'development',emailProvider:'console'} ,{logger:{info(){}}});
  assert.equal((await development.sendWorkEmailVerification({userId:'local-user',to:'employee@company.example',link:'http://127.0.0.1:5173/verify-work-email?token=raw-development-token',expiresAt:new Date(Date.now()+60000).toISOString()})).status,'development_preview');
  assert.match(development.getLocalPreview('local-user').link,/raw-development-token/);
  const production=createEmailProvider({nodeEnv:'production',emailProvider:'console'});
  await assert.rejects(()=>production.sendWorkEmailVerification({userId:'prod-user',to:'employee@company.example',link:'https://app.example/verify-work-email?token=x',expiresAt:new Date().toISOString()}),/not configured/);
});

test('candidate inbox uses owned persisted requests and shared compact status styling without work-email prompts', () => {
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
  const pages = readFileSync(path.join(webRoot, 'Pages.tsx'), 'utf8');
  const app = readFileSync(path.join(webRoot, 'App.tsx'), 'utf8');
  const styles = readFileSync(path.join(webRoot, 'styles.css'), 'utf8');
  assert.doesNotMatch(pages, /WorkEmailVerificationPanel|Verify Work Email|Company work email|work-email verification records|<h2>Email verification<\/h2>/i);
  assert.doesNotMatch(app, /verify-work-email/);
  assert.match(pages, /CandidateInboxPage/);
  assert.match(pages, /application\.status/);
  assert.match(pages, /api<\{applications:CandidateApplication\[\]\}>\('\/candidate\/applications'\)/);
  assert.match(styles, /\.status-pill\{[^}]*align-items:center[^}]*align-self:center[^}]*line-height:1\.2[^}]*white-space:nowrap/);
  assert.match(styles, /\.application-inbox-row/);
});

test('auth, access control, search, details and SQLite bookmark persistence', async (t) => {
  const directory=mkdtempSync(path.join(os.tmpdir(),'referralos-test-'));
  const filename=path.join(directory,'referralos.sqlite');
  const config={nodeEnv:'test',demoMode:false,port:0,appOrigin:'http://127.0.0.1:5173',allowedOrigins:['http://127.0.0.1:5173'],databasePath:filename,resumeStoragePath:path.join(directory,'resumes'),jobImportStoragePath:path.join(directory,'imports'),sessionDays:7,
    emailVerificationMinutes:30,emailProvider:'console',publicAppUrl:'http://127.0.0.1:5173',personalEmailDomains:['gmail.com'],companyDomainMappings:{'example employer':['example.com']}};
  const sentVerification=new Map();
  const mailer={sendWorkEmailVerification:async(message)=>{sentVerification.set(message.userId,message);return {status:'development_preview'};}};
  let db=openDatabase(filename);migrateDatabase(db);
  let server;
  const start=()=>new Promise((resolve)=>{server=createApp({db,config,mailer,webDistPath:path.join(directory,'no-web')}).listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`));});
  const stop=()=>new Promise((resolve)=>server.close(resolve));
  try {
    let base=await start();
    const guest=new ApiClient(base);
    assert.deepEqual((await guest.call('/public-config')).data,{demoMode:false},'normal authenticated workflows remain enabled when demo mode is off');
    const rejectedOrigin=await guest.call('/auth/register',{method:'POST',origin:'https://attacker.example',body:{email:'origin-blocked@example.test',password:'very-secret-password',displayName:'Origin Blocked',roles:['candidate']}});
    assert.equal(rejectedOrigin.status,403,'unlisted browser origins remain rejected');
    assert.equal(rejectedOrigin.data.error,'Request origin was not accepted.');
    const missingCsrf=await new ApiClient(base).call('/auth/register',{method:'POST',skipCsrf:true,body:{email:'csrf-blocked@example.test',password:'very-secret-password',displayName:'CSRF Blocked',roles:['candidate']}});
    assert.equal(missingCsrf.status,403,'allowed origins still require the CSRF token');
    const adminRegistration=await guest.call('/auth/register',{method:'POST',body:{email:'bad-admin@example.test',password:'very-secret-password',displayName:'Bad Admin',roles:['admin']}});
    assert.equal(adminRegistration.status,400,`public registration cannot assign admin: ${JSON.stringify(adminRegistration.data)}`);
    const personalWorkEmail=await guest.call('/auth/register',{method:'POST',body:{email:'personal-employee@example.test',password:'very-secret-password',displayName:'Personal Employee',roles:['employee'],companyName:'Example Employer',workEmail:'person@gmail.com'}});
    assert.equal(personalWorkEmail.status,400,'personal email providers cannot qualify as work emails');

    const candidate=new ApiClient(base);
    const registration=await candidate.call('/auth/register',{method:'POST',body:{email:'candidate@example.test',password:'very-secure-password',displayName:'Casey Candidate',roles:['candidate']}});
    assert.equal(registration.status,201);
    assert.deepEqual(registration.data.user.roles,['candidate']);
    const candidateCookies=registration.response.headers.getSetCookie();
    assert.ok(candidateCookies.some((cookie)=>cookie.startsWith('referralos_session=')&&/HttpOnly/i.test(cookie)&&/SameSite=Lax/i.test(cookie)),
      'registration returns a persistent HttpOnly SameSite=Lax session cookie');
    assert.ok(candidate.cookies.has('referralos_csrf'), 'the CSRF endpoint sets a cookie retained for the registration request');
    const candidateId=registration.data.user.id;
    const employee=new ApiClient(base);
    const employeeRegistration=await employee.call('/auth/register',{method:'POST',body:{email:'employee@example.test',password:'very-secure-password',displayName:'Elliot Employee',roles:['employee'],companyName:'Example Employer',jobTitle:'Engineer',workEmail:'elliot@example.com'}});
    assert.equal(employeeRegistration.status,201,`employee registration should succeed: ${JSON.stringify(employeeRegistration.data)}`);
    assert.deepEqual(employeeRegistration.data.user.roles,['employee']);
    assert.equal(employeeRegistration.data.emailVerification.status,'development_preview');
    assert.equal((await employee.call('/auth/me')).status,200,'employee registration session persists across requests');
    assert.equal(db.prepare("SELECT status FROM employee_affiliations WHERE user_id=?").get(employeeRegistration.data.user.id).status,'pending');
    const employeeAffiliation=db.prepare('SELECT id,company_id FROM employee_affiliations WHERE user_id=?').get(employeeRegistration.data.user.id);
    const referrerWithoutWorkEmail=new ApiClient(base);
    const unverifiedReferrer=await referrerWithoutWorkEmail.call('/auth/register',{method:'POST',body:{email:'referrer-without-work-email@example.test',password:'very-secure-password',displayName:'Riley Referrer',roles:['employee'],companyName:'Example Employer',jobTitle:'Engineer'}});
    assert.equal(unverifiedReferrer.status,201,`referrer registration does not require a work email: ${JSON.stringify(unverifiedReferrer.data)}`);
    assert.equal(unverifiedReferrer.data.emailVerification,undefined);
    assert.equal(db.prepare('SELECT work_email FROM employee_affiliations WHERE user_id=?').get(unverifiedReferrer.data.user.id).work_email,null);
    const screenshot=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6e8AAAAASUVORK5CYII=','base64');
    const invalidImage=new FormData();invalidImage.set('authorizedToShare','true');invalidImage.append('screenshots',new Blob(['not an image'],{type:'image/png'}),'bad.png');
    assert.equal((await employee.call('/employee/job-imports',{method:'POST',body:invalidImage})).status,400,'spoofed image types are rejected');
    const importForm=new FormData();importForm.set('authorizedToShare','true');importForm.append('screenshots',new Blob([screenshot],{type:'image/png'}),'opening.png');importForm.append('screenshots',new Blob([screenshot],{type:'image/png'}),'duplicate.png');
    const imported=await employee.call('/employee/job-imports',{method:'POST',body:importForm});assert.equal(imported.status,201);assert.equal(imported.data.images.length,2);assert.equal(imported.data.duplicateWarnings.length,1);
    const importId=imported.data.id;assert.equal((await candidate.call(`/employee/job-imports/${importId}`)).status,403,'import drafts are private to the owning employee role');
    const noOcr=await employee.call(`/employee/job-imports/${importId}/extract`,{method:'POST',body:{consentToExternalProcessing:true}});assert.equal(noOcr.status,503);assert.match(noOcr.data.error,/not configured/);
    assert.equal((await candidate.call('/jobs?q=opening')).data.total,0,'unpublished screenshot drafts never enter public search');
    assert.equal((await employee.call(`/employee/job-imports/${importId}/images/${imported.data.images[0].id}`)).status,200,'owner can preview private source images');
    const importJob={companyId:employeeAffiliation.company_id,title:'Screenshot Draft Engineer',description:'This job description was reviewed and entered from an authorized screenshot by an employee.',location:'Remote',locationType:'remote',experienceLevel:'mid',employmentType:'full_time',skills:['TypeScript'],salaryRange:'',sourceUrl:'',workflowTemplate:'request_employee',expiresAt:new Date(Date.now()+86400000).toISOString(),steps:[{stepNumber:1,title:'Request referral',instructions:'Ask the employee to consider this referral.',responsible:'candidate',actionType:'request_referral',destinationUrl:'',destinationEmail:'',requiresApplicationId:false,completionMethod:'manual_employee'}]};
    assert.equal((await employee.call(`/employee/job-imports/${importId}/publish`,{method:'POST',body:{confirmReviewed:true}})).status,409,'cannot publish without a saved review');
    assert.equal((await employee.call(`/employee/job-imports/${importId}`,{method:'PATCH',body:{draft:importJob,reviewConfirmed:true}})).status,200);
    const publishedImport=await employee.call(`/employee/job-imports/${importId}/publish`,{method:'POST',body:{confirmReviewed:true}});assert.equal(publishedImport.status,201,'employees can publish without work-email verification');
    assert.equal((await candidate.call(`/jobs/${publishedImport.data.id}`)).data.job.sourceType,'screenshot_import','published import records its provenance');
    const jobPayload={companyId:employeeAffiliation.company_id,title:'Senior Product Engineer',description:'Fictional position used to exercise job search and referral workflow APIs.',location:'Remote',locationType:'remote',experienceLevel:'mid',employmentType:'full_time',skills:['TypeScript'],salaryRange:'',sourceUrl:'',workflowTemplate:'request_employee',expiresAt:new Date(Date.now()+86400000).toISOString(),steps:[
      {stepNumber:1,title:'Request a referral',instructions:'Send the employee a brief note about your interest in the role.',responsible:'candidate',actionType:'request_referral',destinationUrl:'',destinationEmail:'',requiresApplicationId:false,completionMethod:'manual_employee'},
      {stepNumber:2,title:'Open the sample application',instructions:'Review this fictional external application instruction.',responsible:'candidate',actionType:'apply_external',destinationUrl:'https://careers.example/demo',destinationEmail:'',requiresApplicationId:false,completionMethod:'external_unverified'}]};
    const missingRequiredJob=await employee.call('/jobs',{method:'POST',body:{...jobPayload,title:'X',description:'Too short'}});
    assert.equal(missingRequiredJob.status,400);
    assert.ok(missingRequiredJob.data.details.some((item)=>item.field==='title'));
    assert.ok(missingRequiredJob.data.details.some((item)=>item.field==='description'));
    const invalidWorkflowJob=await employee.call('/jobs',{method:'POST',body:{...jobPayload,title:'Missing workflow destination',steps:jobPayload.steps.map((step,index)=>index===1?{...step,destinationUrl:''}:step)}});
    assert.equal(invalidWorkflowJob.status,400);
    assert.ok(invalidWorkflowJob.data.details.some((item)=>item.field==='steps.1.destinationUrl'));
    const referrerJobPayload={...jobPayload,title:'Another Referrer Published Role'};
    const referrerJob=await referrerWithoutWorkEmail.call('/jobs',{method:'POST',body:referrerJobPayload});
    assert.equal(referrerJob.status,201,'referrer without work-email verification can publish a job');
    const ownJobDetail=await referrerWithoutWorkEmail.call(`/jobs/${referrerJob.data.id}`);
    assert.equal(ownJobDetail.data.isOwnJob,true,'job detail identifies ownership for the signed-in user');
    assert.equal((await referrerWithoutWorkEmail.call(`/jobs/${referrerJob.data.id}/referral-requests`,{method:'POST',body:{message:'I want to apply to my own listing.'}})).status,403,'the API prevents referrers from requesting on their own listing');
    const docxApplication=new FormData();docxApplication.set('message','Referrer to referrer application with a DOCX.');docxApplication.set('resumeConsent','true');docxApplication.set('resume',new Blob([Buffer.from([0x50,0x4b,0x03,0x04,0x00,0x00,0x00,0x00])],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),'application.docx');
    const referrerToReferrer=await employee.call(`/jobs/${referrerJob.data.id}/referral-requests`,{method:'POST',body:docxApplication});assert.equal(referrerToReferrer.status,201,'a referrer can request another referrer’s job with DOCX resume');
    const referrerInbox=await employee.call('/candidate/applications');
    assert.equal(referrerInbox.status,200,'referrer accounts can use the candidate inbox API');
    assert.ok(referrerInbox.data.applications.some((item)=>item.id===referrerToReferrer.data.id&&item.status==='pending'&&item.kind==='referral_request'));
    assert.equal((await candidate.call('/candidate/applications')).data.applications.some((item)=>item.id===referrerToReferrer.data.id),false,'the candidate inbox does not expose another user’s request');
    await referrerWithoutWorkEmail.call(`/referral-requests/${referrerToReferrer.data.id}/status`,{method:'PATCH',body:{status:'accepted',note:'I will review this application.'}});
    assert.equal((await employee.call('/candidate/applications')).data.applications.find((item)=>item.id===referrerToReferrer.data.id).status,'accepted','the inbox reflects the latest persisted request status');
    const docxDownload=await referrerWithoutWorkEmail.call(`/referral-requests/${referrerToReferrer.data.id}/resume`);assert.equal(docxDownload.status,200);assert.equal(docxDownload.response.headers.get('content-type'),'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const docApplication=new FormData();docApplication.set('message','Candidate application with a DOC.');docApplication.set('resumeConsent','true');docApplication.set('resume',new Blob([Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])],{type:'application/msword'}),'application.doc');
    assert.equal((await candidate.call(`/jobs/${referrerJob.data.id}/referral-requests`,{method:'POST',body:docApplication})).status,201,'legacy DOC resumes are accepted for candidate applications');
    const unverifiedJob=await employee.call('/jobs',{method:'POST',body:jobPayload});assert.equal(unverifiedJob.status,201,'employees can publish before optional work-email verification');
    const employeeToken=new URL(sentVerification.get(employeeRegistration.data.user.id).link).searchParams.get('token');
    const verified=await employee.call('/auth/work-email/verify',{method:'POST',body:{token:employeeToken}});
    assert.equal(verified.status,200);assert.equal(verified.data.verified,true);
    const discardForm=new FormData();discardForm.set('authorizedToShare','true');discardForm.append('screenshots',new Blob([screenshot],{type:'image/png'}),'discard.png');
    const disposable=await employee.call('/employee/job-imports',{method:'POST',body:discardForm});assert.equal(disposable.status,201);
    assert.equal((await employee.call(`/employee/job-imports/${disposable.data.id}`,{method:'DELETE'})).data.discarded,true);
    assert.equal((await employee.call(`/employee/job-imports/${disposable.data.id}`)).status,404,'discarded drafts cannot be reopened');
    assert.ok((await employee.call('/auth/me')).data.affiliations[0].work_email_verified_at);
    assert.equal((await employee.call('/auth/work-email/verify',{method:'POST',body:{token:employeeToken}})).status,400,'verification tokens are single-use');
    const createdJob=unverifiedJob;
    const duplicateJob=await employee.call('/jobs',{method:'POST',body:jobPayload});assert.equal(duplicateJob.status,409,'same-company active job duplicates are rejected');
    const jobId=createdJob.data.id;
    const invalidResumeForm=new FormData();invalidResumeForm.set('message','This file has a misleading extension.');invalidResumeForm.set('resumeConsent','true');invalidResumeForm.set('resume',new Blob(['not a real pdf'],{type:'application/pdf'}),'fake.pdf');
    assert.equal((await referrerWithoutWorkEmail.call(`/jobs/${jobId}/referral-requests`,{method:'POST',body:invalidResumeForm})).status,400,'invalid resume contents are rejected');
    const referrerResumeForm=new FormData();referrerResumeForm.set('message','I am interested in this role as a referrer.');referrerResumeForm.set('resumeConsent','true');referrerResumeForm.set('resume',new Blob(['%PDF-1.4\nPrivate application resume'],{type:'application/pdf'}),'riley-resume.pdf');
    const referrerRequest=await referrerWithoutWorkEmail.call(`/jobs/${jobId}/referral-requests`,{method:'POST',body:referrerResumeForm});
    assert.equal(referrerRequest.status,201,`referrer may apply to another employee's job with a private resume: ${JSON.stringify(referrerRequest.data)}`);
    const requestResumeId=referrerRequest.data.id;
    assert.equal((await referrerWithoutWorkEmail.call(`/jobs/${jobId}/referral-requests`,{method:'POST',body:{message:'Duplicate request.'}})).status,409,'duplicate referrer applications are rejected');
    assert.equal(db.prepare('SELECT candidate_id,original_name FROM referral_request_resumes WHERE request_id=?').get(requestResumeId).candidate_id,unverifiedReferrer.data.user.id);
    assert.equal((await employee.call(`/jobs/${jobId}`)).data.isOwnJob,true,'the job detail UI receives the signed-in owner flag');
    assert.equal((await employee.call(`/jobs/${jobId}/referral-requests`,{method:'POST',body:{message:'Self application attempt.'}})).status,403,'the API prevents a referrer from applying to their own job');
    assert.equal((await referrerWithoutWorkEmail.call(`/referral-requests/${requestResumeId}/resume`)).status,404,'applicants cannot use the employee resume-download endpoint');
    assert.equal((await employee.call(`/referral-requests/${requestResumeId}/status`,{method:'PATCH',body:{status:'accepted',note:'I will review this resume.'}})).status,200);
    const attachedResume=await employee.call(`/referral-requests/${requestResumeId}/resume`);
    assert.equal(attachedResume.status,200,'the assigned employee can access the consented request attachment after accepting');
    assert.equal(attachedResume.response.headers.get('content-type'),'application/pdf');
    const otherCompanyId='11111111-1111-4111-8111-111111111111';
    db.prepare('INSERT INTO companies(id,name,slug) VALUES (?,?,?)').run(otherCompanyId,'Unrelated Test Company','unrelated-test-company');
    db.prepare(`INSERT INTO jobs(id,company_id,posted_by,title,description,location,location_type,experience_level,employment_type,workflow_template,status,expires_at) VALUES(?,?,?,?,?,'Remote','remote','mid','full_time','custom','published',?)`).run('22222222-2222-4222-8222-222222222222',otherCompanyId,employeeRegistration.data.user.id,'Product Analyst','An unrelated test role used to confirm company-scoped search.','2099-01-01T00:00:00.000Z');
    const bothRoles=new ApiClient(base);
    const multiRoleRegistration=await bothRoles.call('/auth/register',{method:'POST',body:{email:'both@example.test',password:'very-secure-password',displayName:'Taylor Both',roles:['candidate','employee'],companyName:'Example Employer',workEmail:'taylor@example.com'}});
    assert.equal(multiRoleRegistration.status,201);
    assert.deepEqual([...multiRoleRegistration.data.user.roles].sort(),['candidate','employee']);
    const expiredToken=new URL(sentVerification.get(multiRoleRegistration.data.user.id).link).searchParams.get('token');
    db.prepare("UPDATE employee_email_verifications SET expires_at='2000-01-01T00:00:00.000Z' WHERE affiliation_id IN (SELECT id FROM employee_affiliations WHERE user_id=?)").run(multiRoleRegistration.data.user.id);
    assert.equal((await bothRoles.call('/auth/work-email/verify',{method:'POST',body:{token:expiredToken}})).status,400,'expired verification tokens are rejected');
    const denied=await guest.call('/jobs/30000000-0000-4000-8000-000000000001/bookmark',{method:'POST'});
    assert.equal(denied.status,401,'bookmark writes require authentication');
    const employeeArea=await candidate.call('/employee/dashboard');
    assert.equal(employeeArea.status,403,'candidate role cannot access employee dashboard');

    const search=await candidate.call('/jobs?q=Product&skill=TypeScript');
    assert.equal(search.status,200);assert.equal(search.data.total,1);assert.equal(search.data.jobs[0].isDemo,false);
    const companyId=employeeAffiliation.company_id;
    const companyPage=await candidate.call(`/companies/${companyId}?q=Product&limit=5&offset=0`);
    assert.equal(companyPage.status,200);assert.equal(companyPage.data.total,1);assert.ok(companyPage.data.jobs.every((job)=>job.companyId===companyId));
    const stableFilter=await candidate.call(`/jobs?companyId=${companyId}&q=Product`);
    assert.equal(stableFilter.data.total,1);assert.ok(stableFilter.data.jobs.every((job)=>job.companyId===companyId));
    assert.equal((await candidate.call('/jobs?companyId=unrelated-company')).data.total,0,'company ID filtering cannot return other companies');
    const unrelatedCompany=await candidate.call(`/companies/${otherCompanyId}?q=Product`);assert.equal(unrelatedCompany.data.total,1);assert.equal(unrelatedCompany.data.jobs[0].companyId,otherCompanyId);
    assert.equal((await candidate.call(`/companies/${companyId}?q=Analyst`)).data.total,0,'company search does not leak another company matching job');
    const detail=await candidate.call(`/jobs/${jobId}`);
    assert.equal(detail.status,200);assert.equal(detail.data.steps.length,2);assert.equal(detail.data.steps[1].destinationUrl,'https://careers.example/demo');
    const resumeForm=new FormData();resumeForm.set('resume',new Blob(['%PDF-1.4\nReferralOS test PDF body'],{type:'application/pdf'}),'candidate.pdf');
    assert.equal((await candidate.call('/profile/resume',{method:'POST',body:resumeForm})).status,201,'candidate can upload a private validated PDF');
    assert.equal((await candidate.call('/profile/resume-consent',{method:'PATCH',body:{consent:true}})).data.consent,true);
    const requested=await candidate.call(`/jobs/${jobId}/referral-requests`,{method:'POST',body:{message:'I am interested in this role.'}});
    assert.equal(requested.status,201);const requestId=requested.data.id;
    const inboxAfterRequest=await candidate.call('/candidate/applications');
    assert.ok(inboxAfterRequest.data.applications.some((item)=>item.id===requestId&&item.status==='pending'&&item.kind==='referral_request'),'candidate inbox shows the signed-in user’s current request status');
    assert.equal((await guest.call('/candidate/applications')).status,401,'candidate inbox requires authentication');
    const repeated=await candidate.call(`/jobs/${jobId}/referral-requests`,{method:'POST',body:{message:'Repeated click.'}});
    assert.equal(repeated.status,409,'duplicate active referral requests are rejected server-side');
    assert.equal((await employee.call('/notifications')).data.notifications[0].type,'referral_request','employee receives a persistent notification');
    const unreadBefore=(await employee.call('/notifications/unread-count')).data.unread;assert.ok(unreadBefore>=1);
    assert.equal((await employee.call('/notifications/read-all',{method:'POST'})).data.updated,unreadBefore);
    assert.equal((await employee.call('/notifications/unread-count')).data.unread,0);
    assert.equal((await employee.call(`/referral-requests/${requestId}/resume`)).status,403,'employees cannot access a resume before accepting a request');
    assert.equal((await candidate.call('/profile/resume')).status,200,'candidate can access their own private resume');
    const accepted=await employee.call(`/referral-requests/${requestId}/status`,{method:'PATCH',body:{status:'accepted',note:'I will review the application details.'}});
    assert.equal(accepted.status,200);
    const candidateMessage=await candidate.call(`/referral-requests/${requestId}/messages`,{method:'POST',body:{body:'Thanks for reviewing my application.'}});assert.equal(candidateMessage.status,201);assert.equal(candidateMessage.data.status,'employee_action_needed');
    assert.equal((await employee.call(`/referral-requests/${requestId}/messages`,{method:'POST',body:{body:'I will check the application details.'}})).status,201,'the associated employee can continue the conversation');
    assert.equal((await employee.call('/employee/dashboard')).data.referralRequests[0].unread_message_count,1,'employee inbox counts unread candidate messages');
    assert.equal((await employee.call(`/referral-requests/${requestId}/messages/read`,{method:'POST'})).data.updated,1);
    assert.equal((await employee.call('/employee/dashboard')).data.referralRequests[0].unread_message_count,0);
    assert.equal((await candidate.call('/candidate/dashboard')).data.referralRequests[0].unread_message_count,2,'candidate inbox counts unread employee messages and status notes');
    assert.equal((await candidate.call(`/referral-requests/${requestId}/messages/read`,{method:'POST'})).data.updated,2);
    assert.equal((await employee.call(`/referral-requests/${requestId}/resume`)).status,200,'accepted request and candidate consent permit the assigned employee download');
    let candidateDashboard=await candidate.call('/candidate/dashboard');
    assert.equal(candidateDashboard.data.referralRequests[0].status,'employee_action_needed','candidate messages move the accepted request into employee action and dashboard reflects it');
    assert.ok(candidateDashboard.data.notifications.some((notification)=>notification.type==='referral_status'));
    const infoNeeded=await employee.call(`/referral-requests/${requestId}/status`,{method:'PATCH',body:{status:'candidate_action_needed',note:'Please share your application ID.'}});
    assert.equal(infoNeeded.status,200);
    const response=await candidate.call(`/referral-requests/${requestId}/messages`,{method:'POST',body:{body:'My application ID is APP-123.'}});
    assert.equal(response.status,201);assert.equal(response.data.status,'employee_action_needed');
    const applied=await candidate.call(`/referral-requests/${requestId}/status`,{method:'PATCH',body:{status:'candidate_reported_applied',note:'I submitted through the employer portal.'}});
    assert.equal(applied.status,200);
    assert.equal((await candidate.call('/candidate/applications')).data.applications.find((item)=>item.id===requestId).status,'candidate_reported_applied','candidate inbox displays the latest persisted status');
    const confirmed=await employee.call(`/referral-requests/${requestId}/status`,{method:'PATCH',body:{status:'referral_confirmed',note:'I submitted this referral through our authorized employer process.',confirmEmployerSubmission:true}});
    assert.equal(confirmed.status,200);
    const requestDetail=await candidate.call(`/referral-requests/${requestId}`);
    assert.equal(requestDetail.data.request.nextAction,'Employee reported referral submission · not independently verified');
    assert.ok(requestDetail.data.history.some((event)=>event.from_status==='candidate_action_needed'&&event.to_status==='employee_action_needed'));
    assert.ok(requestDetail.data.messages.some((item)=>item.body==='My application ID is APP-123.'));
    assert.equal((await candidate.call('/profile/resume-consent',{method:'PATCH',body:{consent:false}})).data.consent,false);
    assert.equal((await employee.call(`/referral-requests/${requestId}/resume`)).status,403,'revoking consent immediately removes employee resume access');
    assert.equal((await guest.call(`/referral-requests/${requestId}`)).status,401,'anonymous users cannot read private request history');
    await employee.call(`/referral-requests/${requestId}/status`,{method:'PATCH',body:{status:'closed',note:'Closing this referral cycle.'}});
    const reopenForm=new FormData();reopenForm.set('message','I would like to reopen this request with my saved resume.');reopenForm.set('useSavedResume','true');reopenForm.set('resumeConsent','true');
    const reopened=await candidate.call(`/jobs/${jobId}/referral-requests`,{method:'POST',body:reopenForm});
    assert.equal(reopened.status,200);assert.equal(reopened.data.id,requestId);assert.equal(reopened.data.reopened,true);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM referral_request_resumes WHERE request_id=?').get(requestId).count,1,'saved resume is copied as a private request-specific snapshot after explicit consent');
    assert.equal((await candidate.call(`/jobs/${jobId}/referral-requests`,{method:'POST',body:{message:'Duplicate after reopen.'}})).status,409);
    candidateDashboard=await candidate.call('/candidate/dashboard');assert.equal(candidateDashboard.data.referralRequests[0].status,'pending');
    assert.equal((await employee.call(`/referral-requests/${requestId}/status`,{method:'PATCH',body:{status:'accepted',note:'Reviewing the reopened application.'}})).status,200);
    assert.equal((await employee.call(`/referral-requests/${requestId}/resume`)).status,200,'request-specific consent remains valid independently of the profile-wide sharing setting');
    assert.equal((await candidate.call('/profile/resume',{method:'DELETE'})).status,200,'candidate can delete their resume');
    assert.equal(db.prepare('SELECT resume_key FROM profiles WHERE user_id=?').get(candidateId).resume_key,null);
    assert.equal((await employee.call(`/referral-requests/${requestId}/resume`)).status,200,'deleting the saved profile copy does not delete the separately shared request snapshot');
    const saved=await candidate.call(`/jobs/${jobId}/bookmark`,{method:'POST'});
    assert.equal(saved.status,200);assert.equal(saved.data.saved,true);
    const dashboardBefore=await candidate.call('/candidate/dashboard');
    assert.equal(dashboardBefore.data.savedJobs.length,1);

    const login=await new ApiClient(base).call('/auth/login',{method:'POST',body:{email:'candidate@example.test',password:'incorrect-password'}});
    assert.equal(login.status,401,'invalid credentials must not authenticate');
    const validClient=new ApiClient(base);
    const validLogin=await validClient.call('/auth/login',{method:'POST',body:{email:'candidate@example.test',password:'very-secure-password'}});
    assert.equal(validLogin.status,200,'valid credentials authenticate');
    const identity=await validClient.call('/auth/me');
    assert.ok(identity.data.user.roles.includes('candidate'));
    const logout=await validClient.call('/auth/logout',{method:'POST'});
    assert.equal(logout.status,204);
    assert.equal((await validClient.call('/auth/me')).status,401,'logout invalidates the session');

    await stop();closeDatabase(db);
    db=openDatabase(filename);migrateDatabase(db);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM bookmarks WHERE user_id=? AND job_id=?').get(candidateId,jobId).count,1,'bookmark remains after closing and reopening the SQLite database');
    assert.equal(db.prepare('SELECT COUNT(*) count FROM sessions WHERE user_id=?').get(candidateId).count,1,'the logged-out session is removed while the registration session persists across database reopen');
  } finally {
    if(server?.listening) await stop();
    try { closeDatabase(db); } catch { /* already closed between restart phases */ }
    rmSync(directory,{recursive:true,force:true});
  }
});
