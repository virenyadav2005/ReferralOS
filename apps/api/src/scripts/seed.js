import { randomUUID } from 'node:crypto';
import { readConfig } from '../config.js';
import { closeDatabase, migrateDatabase, openDatabase } from '../database.js';

const config = readConfig();
const db = openDatabase(config.databasePath);
migrateDatabase(db);
const demoUser = '00000000-0000-4000-8000-000000000001';
const companies = [
  ['10000000-0000-4000-8000-000000000001','Northstar Sample Labs','northstar-sample-labs','https://northstar.example'],
  ['10000000-0000-4000-8000-000000000002','Cedarline Demo Systems','cedarline-demo-systems','https://cedarline.example'],
  ['10000000-0000-4000-8000-000000000003','Juniper Fictional Health','juniper-fictional-health','https://juniper.example'],
];
const jobs = [
  { id:'20000000-0000-4000-8000-000000000001',company:0,title:'Product Designer, Core Experience',location:'Brooklyn, NY',locationType:'hybrid',level:'mid',skills:['Product design','Figma','Prototyping'],template:'direct_referral_link',salary:'$125k–$155k',steps:[
    ['Open the employee referral link','Use the employee-provided referral link to view the fictional application portal.','candidate','open_url','https://careers.example/northstar/product-designer','',0,'external_unverified'],
    ['Keep your application ID','If the portal provides an application ID, save it for your own records. ReferralOS cannot verify an external application.','candidate','confirm_application','','',1,'manual_candidate'],
  ]},
  { id:'20000000-0000-4000-8000-000000000002',company:1,title:'Senior Backend Engineer',location:'United States',locationType:'remote',level:'senior',skills:['Node.js','TypeScript','PostgreSQL'],template:'apply_first',salary:'$160k–$195k',steps:[
    ['Apply on the careers portal','Submit your application through the fictional careers portal before asking the employee to refer you.','candidate','apply_external','https://careers.example/cedarline/backend-engineer','',0,'external_unverified'],
    ['Send the application ID','After applying, share your application ID with the employee so they can look for your application internally.','candidate','confirm_application','','',1,'manual_candidate'],
  ]},
  { id:'20000000-0000-4000-8000-000000000003',company:2,title:'Data Analyst, Member Insights',location:'Austin, TX',locationType:'onsite',level:'entry',skills:['SQL','Analytics','Looker'],template:'request_employee',salary:'$82k–$98k',steps:[
    ['Review the role details','Read the fictional role outline and prepare a current resume before contacting the employee.','candidate','custom','','',0,'not_required'],
    ['Request an employee referral','Use the ReferralOS request form to send the employee a short note. A request is not a submitted referral.','candidate','request_referral','','',0,'manual_employee'],
    ['Wait for a response','The employee will update this request in ReferralOS if they choose to proceed.','either','wait','','',0,'manual_employee'],
  ]},
  { id:'20000000-0000-4000-8000-000000000004',company:0,title:'People Operations Coordinator',location:'Boston, MA',locationType:'hybrid',level:'entry',skills:['Operations','HR','Communication'],template:'referral_form',salary:'$68k–$80k',steps:[
    ['Complete the sample referral form','Fill out the fictional company form. ReferralOS does not transmit this information to any employer.','candidate','complete_form','https://forms.example/northstar/people-ops','',0,'external_unverified'],
    ['Notify the employee','Tell the employee when you have completed the form if you want them to submit an internal referral.','candidate','request_referral','','',0,'manual_candidate'],
  ]},
  { id:'20000000-0000-4000-8000-000000000005',company:1,title:'Customer Success Manager',location:'Chicago, IL',locationType:'hybrid',level:'mid',skills:['Customer success','SaaS','Account management'],template:'email_instructions',salary:'$105k–$130k OTE',steps:[
    ['Email the employee-provided contact','Send your resume and a short introduction to the sample address. This address is a placeholder and does not deliver email.','candidate','send_email','','talent@cedarline.example',0,'external_unverified'],
    ['Allow time for a reply','Do not treat sending an email as confirmation that the company received or reviewed it.','candidate','wait','','',0,'not_required'],
  ]},
  { id:'20000000-0000-4000-8000-000000000006',company:2,title:'Staff Software Engineer, Platform',location:'Remote — US',locationType:'remote',level:'lead',skills:['Distributed systems','Go','Cloud infrastructure'],template:'custom',salary:'$190k–$230k',steps:[
    ['Submit the standard application','Start with the fictional careers portal and keep any confirmation number for yourself.','candidate','apply_external','https://careers.example/juniper/platform-staff','',1,'external_unverified'],
    ['Request an employee review','After submitting the portal application, request an employee referral and include the application ID.','candidate','request_referral','','',1,'manual_employee'],
    ['Employee review','The employee can confirm a referral in ReferralOS only after completing the action outside the platform.','employee','custom','','',0,'manual_employee'],
  ]},
];

try {
  db.exec('BEGIN IMMEDIATE');
  db.prepare(`INSERT OR IGNORE INTO users(id,email,password_hash,disabled_at) VALUES (?,?,'disabled-demo-account',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
    .run(demoUser, 'demo-poster@referralos.example');
  db.prepare(`INSERT OR IGNORE INTO profiles(user_id,display_name,headline) VALUES (?,'ReferralOS demo dataset','Sample listings only')`).run(demoUser);
  db.prepare(`INSERT OR IGNORE INTO user_roles(user_id,role) VALUES (?,'employee')`).run(demoUser);
  for (const [companyId,name,slug,website] of companies) {
    db.prepare(`INSERT OR IGNORE INTO companies(id,name,slug,website_url,description,is_demo) VALUES (?,?,?,?,?,1)`)
      .run(companyId,name,slug,website,'Fictional company record used only to demonstrate ReferralOS.');
    const affiliationId = `30000000-0000-4000-8000-${companyId.slice(-12)}`;
    db.prepare(`INSERT OR IGNORE INTO employee_affiliations(id,user_id,company_id,job_title,status) VALUES (?,?,?,'Demo listing author','verified')`)
      .run(affiliationId,demoUser,companyId);
  }
  for (let i=0;i<jobs.length;i++) {
    const job=jobs[i];
    db.prepare(`INSERT OR IGNORE INTO jobs(id,company_id,posted_by,title,description,location,location_type,experience_level,employment_type,
      skills_json,salary_range,source_url,workflow_template,status,is_demo,expires_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,? ,?,?,?,?,'published',1,?,strftime('%Y-%m-%dT%H:%M:%fZ','now',?))`).run(
      job.id,companies[job.company][0],demoUser,job.title,
      `DEMO DATA — fictional example listing. ${job.title} at ${companies[job.company][1]}. This opening is not a real vacancy and has no official employer relationship. The workflow below is illustrative and is not connected to any external hiring system.`,
      job.location,job.locationType,job.level,'full_time',JSON.stringify(job.skills),job.salary,
      `https://careers.example/${companies[job.company][2]}/${job.id.slice(-4)}`,job.template,
      new Date(Date.now()+90*86400000).toISOString(),`-${i} days`);
    for (let stepIndex=0;stepIndex<job.steps.length;stepIndex++) {
      const [title,instructions,responsible,actionType,destinationUrl,destinationEmail,requiresApplicationId,completionMethod]=job.steps[stepIndex];
      db.prepare(`INSERT OR IGNORE INTO job_workflow_steps(id,job_id,step_number,title,instructions,responsible,action_type,destination_url,
        destination_email,requires_application_id,completion_method) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(randomUUID(),job.id,stepIndex+1,title,instructions,responsible,actionType,destinationUrl||null,destinationEmail||null,requiresApplicationId,completionMethod);
    }
  }
  db.exec('COMMIT');
  console.log(`Loaded ${jobs.length} clearly labeled fictional sample listings.`);
} catch (error) { db.exec('ROLLBACK'); throw error; }
finally { closeDatabase(db); }
