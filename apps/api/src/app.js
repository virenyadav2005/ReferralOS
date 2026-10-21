import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { audit, id, notify } from './ids.js';
import { createEmailProvider } from './email.js';
import { attachUser, clearSessionCookie, createCsrfToken, createSession, csrfGuard, hashPassword, requireAdmin, requireAuth, requireRole, verifyPassword } from './security.js';
import { completionSchema, contactReviewSchema, contactSchema, jobImportDraftSchema, jobImportExtractSchema, jobImportImageOrderSchema, jobImportPublishSchema, jobSchema, jobStatusSchema, loginSchema, parseBody, profileSchema, pushSubscriptionSchema, pushUnsubscribeSchema, referralSchema, registerSchema, reportReviewSchema, reportSchema, requestMessageSchema, resumeConsentSchema, statusSchema, verificationReviewSchema, workflowStepReviewSchema, workEmailSchema, workEmailTokenSchema } from './validation.js';
import { createScreenshotExtractor } from './screenshot-extraction.js';

const templateNames = {
  direct_referral_link: 'Direct referral link', apply_first: 'Apply on careers site first', request_employee: 'Request an employee referral',
  referral_form: 'Company referral form', email_instructions: 'Email-based instructions', custom: 'Custom workflow',
};
const stepSelect = `SELECT id,job_id,step_number,title,instructions,responsible,action_type,destination_url,destination_email,
  requires_application_id,completion_method FROM job_workflow_steps`;
const jobSummarySelect = `SELECT j.id,j.company_id,j.title,j.description,j.location,j.location_type,j.experience_level,j.employment_type,
  j.skills_json,j.salary_range,j.workflow_template,j.status,j.is_demo,j.expires_at,j.created_at,j.updated_at,j.source_type,
  j.posted_by poster_user_id,c.name company_name,c.slug company_slug,c.website_url company_website,c.is_demo company_is_demo,
  p.display_name poster_name`;
const publicJobWhere = `j.status='published' AND j.is_demo IN (0,1) AND j.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

function safeJob(row, saved = false) {
  return {
    id: row.id, companyId: row.company_id, title: row.title, description: row.description, location: row.location,
    locationType: row.location_type, experienceLevel: row.experience_level, employmentType: row.employment_type,
    skills: JSON.parse(row.skills_json), salaryRange: row.salary_range, referralMethod: row.workflow_template,
    referralMethodLabel: templateNames[row.workflow_template], status: row.status, isDemo: Boolean(row.is_demo),
    expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at, sourceType:row.source_type??'employee',
    company: { name: row.company_name, slug: row.company_slug, websiteUrl: row.company_website, isDemo: Boolean(row.company_is_demo) },
    postedBy: row.poster_name, isSaved: Boolean(saved),
  };
}

function parseStep(row) {
  return {
    id: row.id, stepNumber: row.step_number, title: row.title, instructions: row.instructions,
    responsible: row.responsible, actionType: row.action_type, destinationUrl: row.destination_url,
    destinationEmail: row.destination_email, requiresApplicationId: Boolean(row.requires_application_id), completionMethod: row.completion_method,
  };
}

function validScreenshot(buffer,mimeType){
  if(mimeType==='image/png'){
    if(buffer.length<24||!buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return false;
    const width=buffer.readUInt32BE(16),height=buffer.readUInt32BE(20);return width>0&&height>0&&width<=20000&&height<=20000&&width*height<=40000000;
  }
  if(mimeType!=='image/jpeg'||buffer.length<4||buffer[0]!==0xff||buffer[1]!==0xd8||buffer[2]!==0xff)return false;
  let offset=2;while(offset+4<buffer.length){if(buffer[offset]!==0xff){offset++;continue;}const marker=buffer[offset+1];if(marker===0xd9||marker===0xda)break;const length=buffer.readUInt16BE(offset+2);if(length<2||offset+2+length>buffer.length)return false;
    if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){const height=buffer.readUInt16BE(offset+5),width=buffer.readUInt16BE(offset+7);return width>0&&height>0&&width<=20000&&height<=20000&&width*height<=40000000;}offset+=2+length;
  }return false;
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requireApplicant(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  if (!req.user.roles.some((role) => role === 'candidate' || role === 'employee')) return res.status(403).json({ error: 'A candidate or referrer account is required.' });
  next();
}

function setSessionCookieForAuth(db, userId, config, res) {
  createSession(db, userId, config, res);
}

function verifyWorkEmailEligibility(email, companyName, config) {
  const domain = email.trim().toLowerCase().split('@').at(-1);
  if (config.personalEmailDomains?.includes(domain)) return { error: 'Use a company work email. Personal email providers cannot verify employee affiliation.' };
  const key = companyName.trim().toLowerCase();
  const mappedDomains = config.companyDomainMappings?.[key];
  if (mappedDomains && !mappedDomains.includes(domain)) return { error: 'This work email domain does not match the configured domain for this company.' };
  return { domain };
}

function employeeCanPublishForCompany(affiliation, config) {
  if (!affiliation?.work_email_verified_at || !affiliation.work_email_domain) return false;
  const domains = config.companyDomainMappings?.[String(affiliation.company_name ?? '').trim().toLowerCase()];
  return Boolean(domains?.includes(affiliation.work_email_domain.toLowerCase()));
}

async function sendWorkEmailVerification({ db, config, mailer, userId, affiliationId, email }) {
  const rawToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.emailVerificationMinutes * 60_000).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE employee_email_verifications SET consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE affiliation_id=? AND consumed_at IS NULL`).run(affiliationId);
    db.prepare(`INSERT INTO employee_email_verifications(id,affiliation_id,email,token_hash,expires_at)
      VALUES (?,?,?,?,?)`).run(id(), affiliationId, email, createHash('sha256').update(rawToken).digest('hex'), expiresAt);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const link = new URL('/verify-work-email', config.publicAppUrl);
  link.searchParams.set('token', rawToken);
  try {
    const delivery = await mailer.sendWorkEmailVerification({ userId, to: email, link: link.toString(), expiresAt });
    return { status: delivery.status };
  } catch (error) {
    // Never include provider diagnostics, credentials, or token material in API responses.
    return { status: 'not_sent', message: error?.message?.startsWith('Email delivery is not configured')
      ? 'Email delivery is not configured. Ask the platform operator to configure it, then retry.'
      : 'The email provider could not confirm delivery. Retry from your employee dashboard.' };
  }
}

export function createApp({ db, config, mailer = createEmailProvider(config), screenshotExtractor = createScreenshotExtractor(config), webDistPath = path.resolve(process.cwd(), 'apps/web/dist') }) {
  const app = express();
  const requireAdminAccess = requireAdmin(config.adminEmails ?? []);
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => { mkdirSync(config.resumeStoragePath, { recursive: true }); callback(null, config.resumeStoragePath); },
      filename: (_req, _file, callback) => callback(null, `${randomUUID()}.pdf`),
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) => {
      if (file.mimetype !== 'application/pdf' || !file.originalname.toLowerCase().endsWith('.pdf')) return callback(new Error('Only PDF resumes up to 5 MB are supported.'));
      callback(null, true);
    },
  });
  const requestResumeUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => { mkdirSync(config.resumeStoragePath, { recursive: true }); callback(null, config.resumeStoragePath); },
      filename: (_req, file, callback) => callback(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      const valid = (extension === '.pdf' && file.mimetype === 'application/pdf')
        || (extension === '.doc' && ['application/msword','application/octet-stream'].includes(file.mimetype))
        || (extension === '.docx' && ['application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/zip','application/octet-stream'].includes(file.mimetype));
      if (!valid) return callback(new Error('Upload a PDF, DOC, or DOCX resume up to 5 MB.'));
      callback(null, true);
    },
  });
  const screenshotUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:6*1024*1024,files:5},fileFilter:(_req,file,callback)=>{
    if(!['image/png','image/jpeg'].includes(file.mimetype))return callback(new Error('Upload PNG or JPEG screenshots up to 6 MB each.'));
    callback(null,true);
  }});
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  const contentSecurityDirectives = helmet.contentSecurityPolicy.getDefaultDirectives();
  if (config.nodeEnv !== 'production') delete contentSecurityDirectives['upgrade-insecure-requests'];
  app.use(helmet({ contentSecurityPolicy: { directives: contentSecurityDirectives }, crossOriginEmbedderPolicy: false }));
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
  app.use(express.json({ limit: '1mb', strict: true }));
  app.use('/api', csrfGuard(config));

  app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'ReferralOS API' }));
  app.get('/api/ready', (_req, res) => {
    try {
      const result = db.prepare('SELECT 1 AS ready').get();
      if (Number(result?.ready) !== 1) return res.status(503).json({ status: 'unavailable' });
      return res.json({ status: 'ready' });
    } catch {
      return res.status(503).json({ status: 'unavailable' });
    }
  });
  app.get('/api/public-config', (_req, res) => res.json({ demoMode: Boolean(config.demoMode), webPushPublicKey: config.webPushPublicKey || null }));
  app.use('/api', attachUser(db));
  app.use('/api', (req, res, next) => {
    if (!config.demoMode) return next();
    const method = req.method.toUpperCase();
    const requestPath = (req.originalUrl ?? req.path).split('?')[0];
    const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
    const sessionActions = method === 'POST' && ['/api/auth/login', '/api/auth/logout'].includes(requestPath);
    if (!safeMethods.includes(method) && !sessionActions) {
      return res.status(403).json({ error: 'This ReferralOS pilot is read-only. Account creation, submissions, uploads, and changes are disabled.' });
    }
    const privatePaths = /^\/api\/profile\/resume\/?$/.test(requestPath)
      || /^\/api\/referral-requests\/[^/]+\/resume\/?$/.test(requestPath)
      || /^\/api\/employee\/job-imports\/[^/]+\/images\/[^/]+\/?$/.test(requestPath)
      || requestPath === '/api/employee/work-email/verification-preview'
      || requestPath === '/api/candidate/dashboard' || requestPath === '/api/candidate/applications'
      || requestPath === '/api/employee/dashboard' || requestPath.startsWith('/api/employee/job-imports/')
      || requestPath.startsWith('/api/admin/') || requestPath.startsWith('/api/notifications')
      || requestPath.startsWith('/api/referral-requests/') || /^\/api\/jobs\/[^/]+\/manage\/?$/.test(requestPath);
    if (method === 'GET' && privatePaths) {
      return res.status(403).json({ error: 'Private account, communication, and file data are unavailable in the read-only pilot.' });
    }
    return next();
  });
  app.post('/api/contact', rateLimit({windowMs:60*60*1000,limit:5,standardHeaders:true,legacyHeaders:false}),parseBody(contactSchema),(req,res)=>{
    const messageId=id();const body=req.validatedBody;
    db.prepare('INSERT INTO contact_messages(id,name,email,topic,body) VALUES (?,?,?,?,?)').run(messageId,body.name,body.email,body.topic,body.body);
    audit(db,null,'contact.message_received','contact_message',messageId);
    res.status(201).json({id:messageId,message:'Your message was saved for platform review. This confirmation does not mean an email was sent.'});
  });
  app.get('/api/auth/csrf', (_req, res) => res.json({ token: createCsrfToken(res, config) }));
  app.get('/api/auth/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
    const affiliations = db.prepare(`SELECT a.id,a.status,a.job_title,a.work_email,a.work_email_domain,a.work_email_verified_at,a.created_at,c.id company_id,c.name company_name
      FROM employee_affiliations a JOIN companies c ON c.id=a.company_id WHERE a.user_id=? ORDER BY a.created_at DESC`).all(req.user.id)
      .map((affiliation)=>({...affiliation,canPublish:!config.enforceVerifiedEmployeeEmail||employeeCanPublishForCompany(affiliation,config)}));
    return res.json({ user: req.user, affiliations });
  });

  app.post('/api/auth/register', rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false }), parseBody(registerSchema), asyncRoute(async (req, res) => {
    const body = req.validatedBody;
    if(config.enforceVerifiedEmployeeEmail&&body.roles.includes('employee')&&!body.workEmail)return res.status(400).json({error:'A company work email is required for employee registration.'});
    let workEmailDomain = null;
    if (body.roles.includes('employee') && body.workEmail) {
      const eligibility = verifyWorkEmailEligibility(body.workEmail, body.companyName, config);
      if (eligibility.error) return res.status(400).json({ error: eligibility.error });
      workEmailDomain = eligibility.domain;
    }
    if (db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(body.email)) return res.status(409).json({ error: 'An account with that email already exists.' });
    const userId = id();
    const passwordHash = await hashPassword(body.password);
    let employeeAffiliationId = null;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO users(id,email,password_hash) VALUES (?,?,?)').run(userId, body.email.toLowerCase(), passwordHash);
      db.prepare('INSERT INTO profiles(user_id,display_name) VALUES (?,?)').run(userId, body.displayName);
      for (const role of body.roles) db.prepare('INSERT INTO user_roles(user_id,role) VALUES (?,?)').run(userId, role);
      if (body.roles.includes('employee')) {
        const companyName = body.companyName.trim();
        let company = db.prepare('SELECT id FROM companies WHERE name=? COLLATE NOCASE').get(companyName);
        if (!company) {
          const slug = `${companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64)}-${randomUUID().slice(0, 6)}`;
          const companyId = id();
          db.prepare('INSERT INTO companies(id,name,slug) VALUES (?,?,?)').run(companyId, companyName, slug);
          company = { id: companyId };
        }
        employeeAffiliationId = id();
        db.prepare(`INSERT INTO employee_affiliations(id,user_id,company_id,job_title,work_email,work_email_domain)
          VALUES (?,?,?,?,?,?)`).run(employeeAffiliationId, userId, company.id, body.jobTitle || null, body.workEmail ? body.workEmail.toLowerCase() : null, workEmailDomain);
      }
      audit(db, userId, 'user.registered', 'user', userId, { roles: body.roles });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      if (String(error.message).includes('UNIQUE constraint failed: users.email')) return res.status(409).json({ error: 'An account with that email already exists.' });
      throw error;
    }
    setSessionCookieForAuth(db, userId, config, res);
    const emailVerification = employeeAffiliationId && body.workEmail
      ? await sendWorkEmailVerification({ db, config, mailer, userId, affiliationId: employeeAffiliationId, email: body.workEmail.toLowerCase() })
      : undefined;
    const user = db.prepare(`SELECT u.id,u.email,p.display_name,p.headline,p.location,p.bio,p.skills_json
      FROM users u JOIN profiles p ON p.user_id=u.id WHERE u.id=?`).get(userId);
    return res.status(201).json({ user: { id: user.id, email: user.email, displayName: user.display_name, headline: null, location: null, bio: null, skills: [], roles: body.roles }, emailVerification });
  }));

  app.post('/api/auth/work-email/verify', parseBody(workEmailTokenSchema), (req, res) => {
    const tokenHash = createHash('sha256').update(req.validatedBody.token).digest('hex');
    const verification = db.prepare(`SELECT v.id,v.affiliation_id,a.user_id FROM employee_email_verifications v
      JOIN employee_affiliations a ON a.id=v.affiliation_id
      WHERE v.token_hash=? AND v.consumed_at IS NULL AND v.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`).get(tokenHash);
    if (!verification) return res.status(400).json({ error: 'This verification link is invalid, expired, or has already been used. Request a new link from your employee dashboard.' });
    db.exec('BEGIN IMMEDIATE');
    try {
      const consumed = db.prepare(`UPDATE employee_email_verifications SET consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND consumed_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(verification.id);
      if (!consumed.changes) { db.exec('ROLLBACK'); return res.status(400).json({ error: 'This verification link is invalid, expired, or has already been used. Request a new link from your employee dashboard.' }); }
      db.prepare(`UPDATE employee_affiliations SET work_email_verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(verification.affiliation_id);
      notify(db, verification.user_id, 'work_email_verified', 'Work email verified', 'Your work email is verified. This confirms access to the address only; it does not verify employment or company authorization.', '/employee');
      audit(db, verification.user_id, 'employee.work_email_verified', 'employee_affiliation', verification.affiliation_id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return res.json({ verified: true, message: 'Work email verified. This confirms email access only, not employment or company authorization.' });
  });

  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many sign-in attempts. Please wait and try again.' } });
  app.post('/api/auth/login', loginLimiter, parseBody(loginSchema), asyncRoute(async (req, res) => {
    const { email, password } = req.validatedBody;
    const user = db.prepare('SELECT id,password_hash FROM users WHERE email=? COLLATE NOCASE AND disabled_at IS NULL').get(email);
    if (!user || !(await verifyPassword(password, user.password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
    setSessionCookieForAuth(db, user.id, config, res);
    audit(db, user.id, 'user.signed_in', 'user', user.id);
    const profile = db.prepare(`SELECT u.id,u.email,p.display_name,p.headline,p.location,p.bio,p.skills_json
      FROM users u JOIN profiles p ON p.user_id=u.id WHERE u.id=?`).get(user.id);
    const roles = db.prepare('SELECT role FROM user_roles WHERE user_id=? ORDER BY role').all(user.id).map((item) => item.role);
    return res.json({ user: { id: profile.id, email: profile.email, displayName: profile.display_name, headline: profile.headline, location: profile.location, bio: profile.bio, skills: JSON.parse(profile.skills_json), roles } });
  }));

  app.post('/api/auth/logout', requireAuth, (req, res) => {
    const token = (req.headers.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith('referralos_session='))?.slice('referralos_session='.length);
    if (token) db.prepare('DELETE FROM sessions WHERE id_hash=?').run(createHashHex(decodeURIComponent(token)));
    clearSessionCookie(res, config);
    audit(db, req.user.id, 'user.signed_out', 'user', req.user.id);
    res.status(204).end();
  });

  app.patch('/api/profile', requireAuth, parseBody(profileSchema), (req, res) => {
    const body = req.validatedBody;
    db.prepare(`UPDATE profiles SET display_name=?,headline=?,location=?,bio=?,skills_json=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=?`)
      .run(body.displayName, body.headline || null, body.location || null, body.bio || null, JSON.stringify(body.skills ?? []), req.user.id);
    audit(db, req.user.id, 'profile.updated', 'user', req.user.id);
    res.json({ user: { ...req.user, displayName: body.displayName, headline: body.headline ?? null, location: body.location ?? null, bio: body.bio ?? null, skills: body.skills ?? [] } });
  });

  app.post('/api/profile/resume', requireRole('candidate'), upload.single('resume'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose a PDF resume to upload.' });
    const signature = readFileSync(req.file.path).subarray(0, 5).toString();
    if (signature !== '%PDF-') { unlinkSync(req.file.path); return res.status(400).json({ error: 'The selected file is not a valid PDF.' }); }
    const profile = db.prepare('SELECT resume_key FROM profiles WHERE user_id=?').get(req.user.id);
    const key = path.basename(req.file.filename, '.pdf');
    db.prepare(`UPDATE profiles SET resume_key=?,resume_name=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=?`)
      .run(key, path.basename(req.file.originalname).slice(0,120), req.user.id);
    if (profile?.resume_key && profile.resume_key !== key && /^[a-f0-9-]{36}$/i.test(profile.resume_key)) {
      const oldPath = path.join(config.resumeStoragePath, `${profile.resume_key}.pdf`);
      if (existsSync(oldPath)) unlinkSync(oldPath);
    }
    audit(db, req.user.id, 'resume.uploaded', 'user', req.user.id);
    res.status(201).json({ name: path.basename(req.file.originalname).slice(0,120), consent: Boolean(db.prepare('SELECT resume_consent FROM profiles WHERE user_id=?').get(req.user.id).resume_consent) });
  });

  app.patch('/api/profile/resume-consent', requireRole('candidate'), parseBody(resumeConsentSchema), (req, res) => {
    const profile = db.prepare('SELECT resume_key FROM profiles WHERE user_id=?').get(req.user.id);
    if (req.validatedBody.consent && !profile?.resume_key) return res.status(400).json({ error: 'Upload a resume before choosing to share it.' });
    db.prepare(`UPDATE profiles SET resume_consent=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=?`)
      .run(Number(req.validatedBody.consent), req.user.id);
    audit(db, req.user.id, req.validatedBody.consent ? 'resume.sharing_enabled' : 'resume.sharing_disabled', 'user', req.user.id);
    res.json({ consent: req.validatedBody.consent });
  });

  app.delete('/api/profile/resume', requireRole('candidate'), (req, res) => {
    const profile = db.prepare('SELECT resume_key,resume_name,resume_consent FROM profiles WHERE user_id=?').get(req.user.id);
    if (!profile?.resume_key) return res.status(404).json({ error: 'No resume is on file.' });
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`UPDATE profiles SET resume_key=NULL,resume_name=NULL,resume_consent=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=?`).run(req.user.id);
      audit(db, req.user.id, 'resume.deleted', 'user', req.user.id, { previousConsent: Boolean(profile.resume_consent) });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (/^[a-f0-9-]{36}$/i.test(profile.resume_key)) {
      const file = path.join(config.resumeStoragePath, `${profile.resume_key}.pdf`);
      if (existsSync(file)) unlinkSync(file);
    }
    res.json({ deleted: true });
  });

  app.get('/api/profile/resume', requireRole('candidate'), (req, res) => {
    const profile = db.prepare('SELECT resume_key,resume_name FROM profiles WHERE user_id=?').get(req.user.id);
    if (!profile?.resume_key || !/^[a-f0-9-]{36}$/i.test(profile.resume_key)) return res.status(404).json({ error: 'No resume is on file.' });
    const file = path.join(config.resumeStoragePath, `${profile.resume_key}.pdf`);
    if (!existsSync(file)) return res.status(404).json({ error: 'Resume file is unavailable.' });
    res.type('application/pdf').set('X-Content-Type-Options','nosniff').download(file, profile.resume_name || 'resume.pdf');
  });

  app.get('/api/referral-requests/:requestId/resume', requireRole('employee'), (req, res) => {
    const request = db.prepare(`SELECT r.status,p.resume_key,p.resume_name,p.resume_consent,
      (SELECT rr.storage_key FROM referral_request_resumes rr WHERE rr.request_id=r.id AND rr.candidate_id=r.candidate_id ORDER BY rr.created_at DESC LIMIT 1) request_storage_key,
      (SELECT rr.original_name FROM referral_request_resumes rr WHERE rr.request_id=r.id AND rr.candidate_id=r.candidate_id ORDER BY rr.created_at DESC LIMIT 1) request_resume_name,
      (SELECT rr.mime_type FROM referral_request_resumes rr WHERE rr.request_id=r.id AND rr.candidate_id=r.candidate_id ORDER BY rr.created_at DESC LIMIT 1) request_resume_type,
      (SELECT rr.revoked_at FROM referral_request_resumes rr WHERE rr.request_id=r.id AND rr.candidate_id=r.candidate_id ORDER BY rr.created_at DESC LIMIT 1) request_resume_revoked FROM referral_requests r
      JOIN jobs j ON j.id=r.job_id JOIN profiles p ON p.user_id=r.candidate_id
      WHERE r.id=? AND r.employee_id=? AND j.posted_by=?`).get(req.params.requestId, req.user.id, req.user.id);
    if (!request) return res.status(404).json({ error: 'Referral request not found.' });
    const requestAttachment = Boolean(request.request_storage_key && !request.request_resume_revoked && request.request_resume_name);
    const requestIsOpen = !['declined','withdrawn','closed','expired'].includes(request.status);
    const profileResumeAllowed = Boolean(request.resume_consent && ['accepted','candidate_action_needed','employee_action_needed','candidate_reported_applied','referral_confirmed'].includes(request.status));
    if (!(requestAttachment && requestIsOpen) && !(profileResumeAllowed && !request.request_storage_key)) {
      return res.status(403).json({ error: 'The candidate has not shared a resume for this referral request.' });
    }
    if (request.request_storage_key) {
      const privateFile = path.join(config.resumeStoragePath, path.basename(request.request_storage_key));
      if (!existsSync(privateFile)) return res.status(404).json({ error: 'Resume file is unavailable.' });
      audit(db, req.user.id, 'resume.accessed', 'referral_request', req.params.requestId);
      return res.type(request.request_resume_type).set('X-Content-Type-Options','nosniff').download(privateFile, request.request_resume_name);
    }
    if (!request.resume_key || !/^[a-f0-9-]{36}$/i.test(request.resume_key)) return res.status(404).json({ error: 'Resume file is unavailable.' });
    const file = path.join(config.resumeStoragePath, `${request.resume_key}.pdf`);
    if (!existsSync(file)) return res.status(404).json({ error: 'Resume file is unavailable.' });
    audit(db, req.user.id, 'resume.accessed', 'referral_request', req.params.requestId);
    res.type('application/pdf').set('X-Content-Type-Options','nosniff').download(file, request.resume_name || 'resume.pdf');
  });

  app.delete('/api/referral-requests/:requestId/resume', requireApplicant, (req,res)=>{
    const request=db.prepare(`SELECT r.id,r.employee_id,j.title,
      EXISTS(SELECT 1 FROM referral_request_resumes rr WHERE rr.request_id=r.id AND rr.candidate_id=r.candidate_id AND rr.revoked_at IS NULL) resume_shared
      FROM referral_requests r JOIN jobs j ON j.id=r.job_id WHERE r.id=? AND r.candidate_id=?`).get(req.params.requestId,req.user.id);
    if(!request)return res.status(404).json({error:'Referral request not found.'});
    if(!request.resume_shared)return res.status(409).json({error:'There is no active request-specific resume share to revoke.'});
    db.exec('BEGIN IMMEDIATE');
    try{
      const revoked=db.prepare(`UPDATE referral_request_resumes SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE request_id=? AND candidate_id=? AND revoked_at IS NULL`).run(request.id,req.user.id);
      if(!revoked.changes){db.exec('ROLLBACK');return res.status(409).json({error:'This resume share has already been revoked.'});}
      notify(db,request.employee_id,'resume_consent_revoked','Resume access revoked',`The candidate revoked access to the resume shared for “${request.title}”.`,`/referral-requests/${request.id}`);
      audit(db,req.user.id,'resume.referral_share_revoked','referral_request',request.id);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    return res.json({revoked:true});
  });

  app.get('/api/jobs', (req, res) => {
    const conditions = [publicJobWhere];
    const args = [];
    const q = String(req.query.q ?? '').trim().slice(0, 120);
    if (q) {
      conditions.push(`(j.title LIKE ? ESCAPE '\\' OR j.description LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM json_each(j.skills_json) sk WHERE sk.value LIKE ? ESCAPE '\\'))`);
      const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      args.push(pattern, pattern, pattern, pattern);
    }
    const filters = [
      ['company', 'c.slug=?'], ['companyId', 'j.company_id=?'], ['location', 'j.location LIKE ?'], ['experience', 'j.experience_level=?'],
      ['workArrangement', 'j.location_type=?'], ['referralMethod', 'j.workflow_template=?'],
    ];
    for (const [key, clause] of filters) {
      const value = String(req.query[key] ?? '').trim();
      if (value) { conditions.push(clause); args.push(key === 'location' ? `%${value.slice(0, 120)}%` : value); }
    }
    const skill = String(req.query.skill ?? '').trim().slice(0, 40);
    if (skill) { conditions.push(`EXISTS (SELECT 1 FROM json_each(j.skills_json) sk WHERE lower(sk.value)=lower(?))`); args.push(skill); }
    const limit = Math.min(48, Math.max(1, Number.parseInt(String(req.query.limit ?? '24'), 10) || 24));
    const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? '0'), 10) || 0);
    const where = conditions.join(' AND ');
    const rows = db.prepare(`${jobSummarySelect} FROM jobs j JOIN companies c ON c.id=j.company_id JOIN profiles p ON p.user_id=j.posted_by
      WHERE ${where} ORDER BY j.created_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const count = db.prepare(`SELECT COUNT(*) count FROM jobs j JOIN companies c ON c.id=j.company_id WHERE ${where}`).get(...args).count;
    let savedIds = new Set();
    if (req.user?.roles.includes('candidate') && rows.length) {
      savedIds = new Set(db.prepare(`SELECT job_id FROM bookmarks WHERE user_id=? AND job_id IN (${rows.map(() => '?').join(',')})`).all(req.user.id, ...rows.map((row) => row.id)).map((row) => row.job_id));
    }
    res.json({ jobs: rows.map((row) => safeJob(row, savedIds.has(row.id))), total: count, limit, offset });
  });

  app.get('/api/jobs/:jobId', (req, res) => {
    const row = db.prepare(`${jobSummarySelect} FROM jobs j JOIN companies c ON c.id=j.company_id JOIN profiles p ON p.user_id=j.posted_by
      WHERE j.id=? AND ${publicJobWhere}`).get(req.params.jobId);
    if (!row) return res.status(404).json({ error: 'This listing is no longer available.' });
    const steps = db.prepare(`${stepSelect} WHERE job_id=? ORDER BY step_number`).all(row.id).map(parseStep);
    if (config.demoMode) {
      for (const step of steps) { step.destinationUrl = null; step.destinationEmail = null; }
    }
    const saved = Boolean(req.user?.roles.includes('candidate') && db.prepare('SELECT 1 FROM bookmarks WHERE user_id=? AND job_id=?').get(req.user.id, row.id));
    const userProgress = req.user ? db.prepare('SELECT step_id,completion_state,review_status,employee_response,request_id FROM workflow_step_completions WHERE job_id=? AND user_id=?').all(row.id, req.user.id) : [];
    const completions = userProgress.map((item) => item.step_id);
    const canRequest = row.workflow_template === 'request_employee' || steps.some((step) => step.actionType === 'request_referral');
    const referralRequest = req.user?.roles.some((role) => role === 'candidate' || role === 'employee') ? db.prepare(`SELECT id,status,created_at,updated_at FROM referral_requests WHERE job_id=? AND candidate_id=?`).get(row.id, req.user.id) ?? null : null;
    const posterAffiliation = db.prepare(`SELECT work_email_verified_at FROM employee_affiliations WHERE user_id=? AND company_id=? ORDER BY created_at LIMIT 1`).get(row.poster_user_id, row.company_id);
    return res.json({ job: safeJob(row, saved), steps, completedStepIds: completions, stepProgress:userProgress.map((item)=>({stepId:item.step_id,status:item.completion_state==='employee_confirmed'?'employee_confirmed':item.review_status,response:item.employee_response,requestId:item.request_id})), canRequest, referralRequest, isOwnJob: req.user?.id === row.poster_user_id,
      employeeWorkEmailVerified: Boolean(posterAffiliation?.work_email_verified_at),
      workflowNotice: 'Instructions and contact details are provided by the employee who posted this listing. ReferralOS does not verify or submit applications to employer systems.' });
  });

  app.post('/api/jobs/:jobId/steps/:stepId/completion', requireAuth, parseBody(completionSchema), (req, res) => {
    const step = db.prepare(`SELECT s.id,s.job_id,s.title,s.responsible,s.completion_method,s.action_type,j.posted_by,j.is_demo
      FROM job_workflow_steps s JOIN jobs j ON j.id=s.job_id WHERE s.id=? AND s.job_id=? AND j.status='published'
      AND j.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`).get(req.params.stepId, req.params.jobId);
    if (!step) return res.status(404).json({ error: 'Workflow step not found.' });
    if (step.action_type === 'request_referral' || step.completion_method === 'not_required') return res.status(400).json({ error: 'Use the action shown for this workflow step.' });
    if (step.posted_by === req.user.id && ['apply_external','request_referral','complete_form','send_email'].includes(step.action_type)) return res.status(403).json({ error: 'You cannot apply for your own job.' });
    const candidateMayRecord = req.user.roles.includes('candidate') && ['candidate','either'].includes(step.responsible);
    const employeeMayRecord = req.user.roles.includes('employee') && req.user.id === step.posted_by && ['employee','either'].includes(step.responsible);
    if (!candidateMayRecord && !employeeMayRecord) return res.status(403).json({ error: 'You cannot record progress for this step.' });
    const state = candidateMayRecord ? 'candidate_reported' : 'employee_confirmed';
    if (candidateMayRecord) {
      const request = db.prepare(`SELECT r.id,r.employee_id,j.title job_title FROM referral_requests r JOIN jobs j ON j.id=r.job_id
        WHERE r.job_id=? AND r.candidate_id=? AND r.employee_id=? AND r.status NOT IN ('closed','declined','withdrawn','expired')`).get(step.job_id, req.user.id, step.posted_by);
      if (!request) return res.status(409).json({ error: 'Submit a referral request for this job before reporting workflow progress.' });
      const existing = db.prepare('SELECT id,request_id,review_status FROM workflow_step_completions WHERE step_id=? AND user_id=?').get(step.id, req.user.id);
      if (existing?.request_id && (existing.request_id !== request.id || existing.review_status !== 'changes_requested')) return res.status(409).json({ error: 'This workflow step is already awaiting review or has been approved.' });
      const completionId = existing?.id ?? id();
      let wasResubmission = false;
      db.exec('BEGIN IMMEDIATE');
      try {
        const currentRequest = db.prepare(`SELECT r.id,r.status FROM referral_requests r JOIN jobs j ON j.id=r.job_id
          WHERE r.id=? AND r.job_id=? AND r.candidate_id=? AND j.status='published' AND j.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`).get(request.id, step.job_id, req.user.id);
        if (!currentRequest || ['closed','declined','withdrawn','expired'].includes(currentRequest.status)) { db.exec('ROLLBACK'); return res.status(409).json({ error: 'This referral request is no longer open for workflow updates.' }); }
        const latest = db.prepare('SELECT id,request_id,review_status FROM workflow_step_completions WHERE step_id=? AND user_id=?').get(step.id, req.user.id);
        if (latest?.request_id && (latest.request_id !== request.id || latest.review_status !== 'changes_requested')) { db.exec('ROLLBACK'); return res.status(409).json({ error: 'This workflow step is already awaiting review or has been approved.' }); }
        wasResubmission = Boolean(latest?.request_id);
        const submittedAt = new Date().toISOString();
        if (latest?.request_id) db.prepare(`UPDATE workflow_step_completions SET completion_state='candidate_reported',application_id=?,note=?,review_status='resubmitted',employee_response=NULL,reviewed_by=NULL,reviewed_at=NULL,updated_at=?,submitted_at=? WHERE id=? AND request_id=? AND review_status='changes_requested'`)
          .run(req.validatedBody.applicationId || null, req.validatedBody.note || null, submittedAt, submittedAt, latest.id, request.id);
        else if (latest) db.prepare(`UPDATE workflow_step_completions SET request_id=?,completion_state='candidate_reported',application_id=?,note=?,review_status='pending_review',employee_response=NULL,reviewed_by=NULL,reviewed_at=NULL,updated_at=?,submitted_at=? WHERE id=? AND request_id IS NULL`)
          .run(request.id, req.validatedBody.applicationId || null, req.validatedBody.note || null, submittedAt, submittedAt, latest.id);
        else db.prepare(`INSERT INTO workflow_step_completions(id,job_id,step_id,user_id,completion_state,application_id,note,request_id,review_status,created_at,updated_at,submitted_at)
          VALUES (?,?,?,?,?,?,?,?,'pending_review',?,?,?)`).run(completionId, step.job_id, step.id, req.user.id, state,
          req.validatedBody.applicationId || null, req.validatedBody.note || null, request.id, submittedAt, submittedAt, submittedAt);
        const action = wasResubmission ? 'resubmitted' : 'submitted';
        db.prepare(`INSERT INTO workflow_step_review_history(id,completion_id,request_id,step_id,actor_id,action,status,submitted_information,created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(id(), completionId, request.id, step.id, req.user.id, action, wasResubmission ? 'resubmitted' : 'pending_review', req.validatedBody.note || null, submittedAt);
        notify(db, request.employee_id, 'workflow_progress', 'Workflow step needs review', `${req.user.displayName} submitted “${step.title}” for ${request.job_title} at ${submittedAt}.${req.validatedBody.note ? ` Details: ${req.validatedBody.note}` : ''}`, `/referral-requests/${request.id}?workflowStep=${step.id}`);
        audit(db, req.user.id, wasResubmission ? 'workflow.step_resubmitted' : 'workflow.step_submitted', 'workflow_step_completion', completionId, { requestId: request.id, stepId: step.id });
        db.exec('COMMIT');
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
      return res.status(201).json({ stepId: step.id, requestId: request.id, state: wasResubmission ? 'resubmitted' : 'pending_review', message: 'Progress sent to the employee for review. ReferralOS cannot verify external actions.' });
    }
    const confirmedAt = new Date().toISOString();
    db.prepare(`INSERT INTO workflow_step_completions(id,job_id,step_id,user_id,completion_state,application_id,note,review_status,created_at,updated_at,submitted_at)
      VALUES (?,?,?,?,?,?,?,'approved',?,?,?) ON CONFLICT(step_id,user_id) DO UPDATE SET completion_state=excluded.completion_state,
      application_id=excluded.application_id,note=excluded.note,review_status='approved',updated_at=excluded.updated_at,submitted_at=excluded.submitted_at`).run(id(), step.job_id, step.id, req.user.id, state,
      req.validatedBody.applicationId || null, req.validatedBody.note || null, confirmedAt, confirmedAt, confirmedAt);
    audit(db, req.user.id, 'workflow.step_confirmed', 'workflow_step', step.id, { state });
    res.json({ stepId: step.id, state, message: 'Progress recorded as an employee action. ReferralOS cannot verify external actions.' });
  });

  app.get('/api/companies', (_req, res) => {
    const companies = db.prepare(`SELECT c.id,c.name,c.slug,c.website_url,c.description,c.is_demo,
      COUNT(j.id) open_jobs FROM companies c LEFT JOIN jobs j ON j.company_id=c.id AND j.status='published'
      AND j.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') GROUP BY c.id ORDER BY c.name`).all();
    res.json({ companies: companies.map((c) => ({ id:c.id,name:c.name,slug:c.slug,websiteUrl:c.website_url,description:c.description,isDemo:Boolean(c.is_demo),openJobs:c.open_jobs })) });
  });

  app.get('/api/companies/:companyId', (req, res) => {
    const company = db.prepare(`SELECT c.id,c.name,c.slug,c.website_url,c.description,c.is_demo FROM companies c WHERE c.id=?`).get(req.params.companyId);
    if (!company) return res.status(404).json({ error: 'Company not found.' });
    const q = String(req.query.q ?? '').trim().slice(0,120);
    const status = ['closed','all'].includes(String(req.query.status)) ? String(req.query.status) : 'active';
    const conditions = ['j.company_id=?','j.is_demo IN (0,1)'];
    const args = [company.id];
    if (status === 'active') conditions.push(`j.status='published' AND j.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
    else if (status === 'closed') conditions.push(`(j.status IN ('closed','expired') OR (j.status='published' AND j.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))) `);
    else conditions.push(`j.status IN ('published','closed','expired')`);
    if (q) {
      const pattern = `%${q.replace(/[\\%_]/g,'\\$&')}%`;
      conditions.push(`(j.title LIKE ? ESCAPE '\\' OR j.description LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM json_each(j.skills_json) sk WHERE sk.value LIKE ? ESCAPE '\\'))`);
      args.push(pattern,pattern,pattern);
    }
    const limit = Math.min(48,Math.max(1,Number.parseInt(String(req.query.limit ?? '12'),10)||12));
    const offset = Math.max(0,Number.parseInt(String(req.query.offset ?? '0'),10)||0);
    const where = conditions.join(' AND ');
    const sort = req.query.sort === 'oldest' ? 'ASC' : 'DESC';
    const rows = db.prepare(`${jobSummarySelect} FROM jobs j JOIN companies c ON c.id=j.company_id JOIN profiles p ON p.user_id=j.posted_by WHERE ${where} ORDER BY j.created_at ${sort},j.id LIMIT ? OFFSET ?`).all(...args,limit,offset);
    const count = db.prepare(`SELECT COUNT(*) count FROM jobs j WHERE ${where}`).get(...args).count;
    const activeJobCount = db.prepare(`SELECT COUNT(*) count FROM jobs j WHERE j.company_id=? AND j.status='published' AND j.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`).get(company.id).count;
    res.json({ company:{id:company.id,name:company.name,slug:company.slug,websiteUrl:company.website_url,description:company.description,isDemo:Boolean(company.is_demo),openJobs:activeJobCount},jobs:rows.map((row)=>safeJob(row)),total:count,limit,offset,status });
  });

  const employeeImportLimiter=rateLimit({windowMs:60*60*1000,limit:20,standardHeaders:true,legacyHeaders:false,message:{error:'Too many screenshot import operations. Try again later.'}});
  const importStorage=config.jobImportStoragePath??path.resolve(process.cwd(),'data/private-job-imports');
  const loadOwnedDraft=(draftId,userId)=>db.prepare('SELECT * FROM job_import_drafts WHERE id=? AND owner_id=?').get(draftId,userId);
  const draftImages=(draftId)=>db.prepare('SELECT id,original_name,mime_type,sha256,sort_order,keep_until FROM job_import_images WHERE draft_id=? ORDER BY sort_order').all(draftId);
  app.post('/api/employee/job-imports',requireRole('employee'),employeeImportLimiter,screenshotUpload.array('screenshots',5),(req,res)=>{
    const files=req.files??[];if(files.length<1)return res.status(400).json({error:'Choose at least one screenshot.'});
    if(req.body?.authorizedToShare!=='true')return res.status(400).json({error:'Confirm that you are authorized to upload and share these screenshots.'});
    for(const file of files)if(!validScreenshot(file.buffer,file.mimetype))return res.status(400).json({error:'A screenshot is invalid, does not match its declared PNG or JPEG format, or exceeds safe image dimensions.'});
    const draftId=id();const records=[];const seen=new Set();
    for(const [index,file] of files.entries()){const hash=createHash('sha256').update(file.buffer).digest('hex');const duplicate=seen.has(hash)||Boolean(db.prepare('SELECT 1 FROM job_import_images WHERE sha256=? LIMIT 1').get(hash));seen.add(hash);records.push({file,index,hash,duplicate,key:`${randomUUID()}.${file.mimetype==='image/png'?'png':'jpg'}`});}
    mkdirSync(importStorage,{recursive:true});
    try{for(const record of records)writeFileSync(path.join(importStorage,record.key),record.file.buffer,{flag:'wx',mode:0o600});
      db.exec('BEGIN IMMEDIATE');db.prepare("INSERT INTO job_import_drafts(id,owner_id,status,draft_json,external_processing_consent) VALUES(?,?,'uploaded','{}',0)").run(draftId,req.user.id);
      for(const record of records)db.prepare('INSERT INTO job_import_images(id,draft_id,storage_key,original_name,mime_type,sha256,sort_order) VALUES(?,?,?,?,?,?,?)').run(id(),draftId,record.key,path.basename(record.file.originalname).slice(0,180),record.file.mimetype,record.hash,record.index);
      audit(db,req.user.id,'job_import.created','job_import_draft',draftId,{imageCount:records.length});db.exec('COMMIT');
    }catch(error){try{db.exec('ROLLBACK');}catch{} for(const record of records){try{unlinkSync(path.join(importStorage,record.key));}catch{}} throw error;}
    res.status(201).json({id:draftId,status:'uploaded',images:draftImages(draftId),duplicateWarnings:records.filter((record)=>record.duplicate).map((record)=>record.file.originalname)});
  });
  app.get('/api/employee/job-imports',requireRole('employee'),(req,res)=>{
    const drafts=db.prepare("SELECT id,status,draft_json,extracted_json,review_confirmed_at,published_job_id,created_at,updated_at FROM job_import_drafts WHERE owner_id=? AND status<>'discarded' ORDER BY updated_at DESC LIMIT 50").all(req.user.id).map((draft)=>({...draft,draft:JSON.parse(draft.draft_json),extracted:JSON.parse(draft.extracted_json),images:draftImages(draft.id)}));
    res.json({drafts});
  });
  app.get('/api/employee/job-imports/:draftId',requireRole('employee'),(req,res)=>{
    const draft=loadOwnedDraft(req.params.draftId,req.user.id);if(!draft||draft.status==='discarded')return res.status(404).json({error:'Import draft not found.'});
    res.json({draft:{id:draft.id,status:draft.status,draft:JSON.parse(draft.draft_json),extracted:JSON.parse(draft.extracted_json),reviewConfirmed:Boolean(draft.review_confirmed_at),publishedJobId:draft.published_job_id,images:draftImages(draft.id)}});
  });
  app.get('/api/employee/job-imports/:draftId/images/:imageId',requireRole('employee'),(req,res)=>{
    const image=db.prepare(`SELECT i.storage_key,i.mime_type,i.original_name FROM job_import_images i JOIN job_import_drafts d ON d.id=i.draft_id WHERE i.id=? AND d.id=? AND d.owner_id=? AND d.status<>'discarded'`).get(req.params.imageId,req.params.draftId,req.user.id);
    if(!image)return res.status(404).json({error:'Screenshot not found.'});const file=path.join(importStorage,image.storage_key);if(!existsSync(file))return res.status(404).json({error:'Screenshot is no longer available.'});
    res.type(image.mime_type).set('X-Content-Type-Options','nosniff').set('Content-Security-Policy',"default-src 'none'; sandbox").set('Cache-Control','private, no-store').sendFile(file);
  });
  app.patch('/api/employee/job-imports/:draftId/images/order',requireRole('employee'),parseBody(jobImportImageOrderSchema),(req,res)=>{
    const draft=loadOwnedDraft(req.params.draftId,req.user.id);if(!draft||['discarded','published'].includes(draft.status))return res.status(404).json({error:'Editable import draft not found.'});
    const existing=draftImages(draft.id);const ids=existing.map(image=>image.id);if(req.validatedBody.imageIds.length!==ids.length||new Set(req.validatedBody.imageIds).size!==ids.length||req.validatedBody.imageIds.some(imageId=>!ids.includes(imageId)))return res.status(400).json({error:'Order must include each screenshot belonging to this draft exactly once.'});
    req.validatedBody.imageIds.forEach((imageId,index)=>db.prepare('UPDATE job_import_images SET sort_order=? WHERE id=? AND draft_id=?').run(index,imageId,draft.id));res.json({images:draftImages(draft.id)});
  });
  app.delete('/api/employee/job-imports/:draftId/images/:imageId',requireRole('employee'),(req,res)=>{
    const draft=loadOwnedDraft(req.params.draftId,req.user.id);if(!draft||['discarded','published'].includes(draft.status))return res.status(404).json({error:'Editable import draft not found.'});
    const image=db.prepare('SELECT id,storage_key FROM job_import_images WHERE id=? AND draft_id=?').get(req.params.imageId,draft.id);if(!image)return res.status(404).json({error:'Screenshot not found.'});
    if(draftImages(draft.id).length<2)return res.status(409).json({error:'A draft must retain at least one screenshot. Discard the draft to remove all its sources.'});
    try{unlinkSync(path.join(importStorage,image.storage_key));}catch{}db.prepare('DELETE FROM job_import_images WHERE id=?').run(image.id);draftImages(draft.id).forEach((item,index)=>db.prepare('UPDATE job_import_images SET sort_order=? WHERE id=?').run(index,item.id));audit(db,req.user.id,'job_import.image_removed','job_import_draft',draft.id);res.json({images:draftImages(draft.id)});
  });
  app.post('/api/employee/job-imports/:draftId/extract',requireRole('employee'),employeeImportLimiter,parseBody(jobImportExtractSchema),asyncRoute(async(req,res)=>{
    const draft=loadOwnedDraft(req.params.draftId,req.user.id);if(!draft||['discarded','published'].includes(draft.status))return res.status(404).json({error:'Editable import draft not found.'});
    const images=db.prepare('SELECT id,storage_key,mime_type,sha256 FROM job_import_images WHERE draft_id=? ORDER BY sort_order').all(draft.id);if(!images.length)return res.status(400).json({error:'Add screenshots before extracting.'});
    if(!screenshotExtractor.configured)return res.status(503).json({error:'Screenshot extraction is not configured. Set SCREENSHOT_OCR_URL and SCREENSHOT_OCR_API_KEY to a trusted OCR endpoint, or continue by entering the visible details manually.'});
    try{const extracted=await screenshotExtractor.extract(images.map(image=>({mimeType:image.mime_type,buffer:readFileSync(path.join(importStorage,image.storage_key))})));const current=JSON.parse(draft.draft_json);const mapped={...current};const fieldMap={workArrangement:'locationType',applicationUrl:'sourceUrl',deadline:'expiresAt'};for(const [key,item] of Object.entries(extracted.fields)){const target=fieldMap[key]??key;const value=item?.value;if((mapped[target]==null||mapped[target]===''||(Array.isArray(mapped[target])&&!mapped[target].length))&&value!=null&&value!=='')mapped[target]=value;}
      db.prepare("UPDATE job_import_drafts SET status='extracted',extracted_json=?,draft_json=?,review_confirmed_at=NULL,external_processing_consent=1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(JSON.stringify(extracted),JSON.stringify(mapped),draft.id);audit(db,req.user.id,'job_import.extracted','job_import_draft',draft.id,{provider:extracted.provider});res.json({extracted,draft:mapped,images:draftImages(draft.id)});
    }catch(error){
      const category = ['configuration_missing','configuration_invalid','invalid_request','network_error','http_error','invalid_json','provider_response_error'].includes(error?.category) ? error.category : 'unknown';
      const httpStatus = Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? error.httpStatus : null;
      if (category === 'configuration_missing' || error.message === 'SCREENSHOT_OCR_NOT_CONFIGURED') return res.status(503).json({error:'Screenshot extraction is not configured. Set SCREENSHOT_OCR_URL and SCREENSHOT_OCR_API_KEY to enable OCR.space, or continue by entering the visible details manually.'});
      if (category === 'configuration_invalid' || error.message === 'SCREENSHOT_OCR_INVALID_CONFIGURATION') return res.status(503).json({error:'Screenshot OCR endpoint configuration is invalid.'});
      console.warn('ReferralOS screenshot OCR failure', { category, httpStatus });
      return res.status(502).json({error:'The configured screenshot extraction provider failed or returned an invalid response. Your draft and uploaded images are unchanged.'});
    }
  }));
  app.patch('/api/employee/job-imports/:draftId',requireRole('employee'),parseBody(jobImportDraftSchema),(req,res)=>{
    const draft=loadOwnedDraft(req.params.draftId,req.user.id);if(!draft||['discarded','published'].includes(draft.status))return res.status(404).json({error:'Editable import draft not found.'});
    const imageIds=new Set(draftImages(draft.id).map(image=>image.id));if(req.validatedBody.imageOrder&&(!req.validatedBody.imageOrder.every(imageId=>imageIds.has(imageId))||new Set(req.validatedBody.imageOrder).size!==imageIds.size))return res.status(400).json({error:'Screenshot order must include each uploaded image exactly once.'});
    const imageOrder=req.validatedBody.imageOrder??[...imageIds];const body=req.validatedBody.draft;
    db.exec('BEGIN IMMEDIATE');try{db.prepare('UPDATE job_import_drafts SET draft_json=?,status=?,review_confirmed_at=?,external_processing_consent=?,updated_at=strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id=?').run(JSON.stringify(body),req.validatedBody.reviewConfirmed?'reviewing':'reviewing',req.validatedBody.reviewConfirmed?new Date().toISOString():null,Number(req.validatedBody.externalProcessingConsent??false),draft.id);
      imageOrder.forEach((imageId,index)=>db.prepare('UPDATE job_import_images SET sort_order=? WHERE id=? AND draft_id=?').run(index,imageId,draft.id));audit(db,req.user.id,'job_import.review_saved','job_import_draft',draft.id,{reviewConfirmed:Boolean(req.validatedBody.reviewConfirmed)});db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    res.json({saved:true,reviewConfirmed:Boolean(req.validatedBody.reviewConfirmed)});
  });
  app.delete('/api/employee/job-imports/:draftId',requireRole('employee'),(req,res)=>{
    const draft=loadOwnedDraft(req.params.draftId,req.user.id);if(!draft)return res.status(404).json({error:'Import draft not found.'});if(draft.status==='published')return res.status(409).json({error:'A published job cannot be discarded as an import draft.'});
    for(const image of db.prepare('SELECT storage_key FROM job_import_images WHERE draft_id=?').all(draft.id)){try{unlinkSync(path.join(importStorage,image.storage_key));}catch{}}
    db.prepare("UPDATE job_import_drafts SET status='discarded',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(draft.id);db.prepare('DELETE FROM job_import_images WHERE draft_id=?').run(draft.id);audit(db,req.user.id,'job_import.discarded','job_import_draft',draft.id);res.json({discarded:true});
  });
  app.post('/api/employee/job-imports/:draftId/publish',requireRole('employee'),parseBody(jobImportPublishSchema),(req,res)=>{
    const draft=loadOwnedDraft(req.params.draftId,req.user.id);if(!draft||draft.status!=='reviewing'||!draft.review_confirmed_at)return res.status(409).json({error:'Save the completed review and explicitly confirm the screenshot-derived details before publishing.'});
    const reviewedData=JSON.parse(draft.draft_json);if(reviewedData.qualifications)reviewedData.description=`${reviewedData.description??''}\n\nQualifications\n${reviewedData.qualifications}`;
    const parsed=jobSchema.safeParse(reviewedData);if(!parsed.success)return res.status(400).json({error:'Complete the required job details and referral workflow before publishing.',details:parsed.error.issues.map(issue=>({field:issue.path.join('.'),message:issue.message}))});
    const body=parsed.data;const affiliation=db.prepare(`SELECT a.id,a.work_email_verified_at,a.work_email_domain,c.name company_name FROM employee_affiliations a JOIN companies c ON c.id=a.company_id WHERE a.user_id=? AND a.company_id=? AND a.status NOT IN ('rejected','revoked')`).get(req.user.id,body.companyId);if(!affiliation)return res.status(403).json({error:'An active company affiliation is required to publish.'});
    if(config.enforceVerifiedEmployeeEmail&&!employeeCanPublishForCompany(affiliation,config))return res.status(403).json({error:'Verify a company work email whose domain is configured for this company before publishing.'});
    const jobId=id();db.exec('BEGIN IMMEDIATE');try{const duplicate=db.prepare(`SELECT id FROM jobs WHERE company_id=? AND lower(title)=lower(?) AND status IN ('draft','published','paused') AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') LIMIT 1`).get(body.companyId,body.title);if(duplicate){db.exec('ROLLBACK');return res.status(409).json({error:'A current listing with this company and title already exists.'});}
      db.prepare(`INSERT INTO jobs(id,company_id,posted_by,title,description,location,location_type,experience_level,employment_type,skills_json,salary_range,source_url,workflow_template,status,expires_at,source_type,source_import_id,source_confirmed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'published',?,'screenshot_import',?,?)`).run(jobId,body.companyId,req.user.id,body.title,body.description,body.location,body.locationType,body.experienceLevel,body.employmentType,JSON.stringify(body.skills),body.salaryRange||null,body.sourceUrl||null,body.workflowTemplate,body.expiresAt,draft.id,draft.review_confirmed_at);
      for(const step of body.steps)db.prepare(`INSERT INTO job_workflow_steps(id,job_id,step_number,title,instructions,responsible,action_type,destination_url,destination_email,requires_application_id,completion_method) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id(),jobId,step.stepNumber,step.title,step.instructions,step.responsible,step.actionType,step.destinationUrl||null,step.destinationEmail||null,Number(step.requiresApplicationId),step.completionMethod);
      db.prepare("UPDATE job_import_drafts SET status='published',published_job_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(jobId,draft.id);audit(db,req.user.id,'job_import.published','job',jobId,{draftId:draft.id,sourceType:'screenshot_import',userReviewedCorrections:JSON.parse(draft.draft_json)});db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    res.status(201).json({id:jobId,status:'published',sourceType:'screenshot_import'});
  });

  app.post('/api/jobs/:jobId/bookmark', requireRole('candidate'), (req, res) => {
    const job = db.prepare(`SELECT j.id FROM jobs j WHERE j.id=? AND ${publicJobWhere}`).get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'This listing is no longer available.' });
    db.prepare('INSERT OR IGNORE INTO bookmarks(user_id,job_id) VALUES (?,?)').run(req.user.id, job.id);
    res.json({ saved: true });
  });

  app.delete('/api/jobs/:jobId/bookmark', requireRole('candidate'), (req, res) => {
    db.prepare('DELETE FROM bookmarks WHERE user_id=? AND job_id=?').run(req.user.id, req.params.jobId);
    res.json({ saved: false });
  });

  app.get('/api/candidate/dashboard', requireApplicant, (req, res) => {
    const jobs = db.prepare(`${jobSummarySelect} FROM bookmarks b JOIN jobs j ON j.id=b.job_id JOIN companies c ON c.id=j.company_id JOIN profiles p ON p.user_id=j.posted_by
      WHERE b.user_id=? AND j.status='published' AND j.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY b.created_at DESC`).all(req.user.id).map((row) => safeJob(row, true));
    const requests = db.prepare(`SELECT r.id,r.status,r.created_at,r.updated_at,r.message,r.application_id,j.title job_title,j.id job_id,c.name company_name,
      (SELECT COUNT(*) FROM referral_request_messages m LEFT JOIN referral_message_reads mr ON mr.message_id=m.id AND mr.user_id=? WHERE m.request_id=r.id AND m.author_id<>? AND mr.read_at IS NULL) unread_message_count
      FROM referral_requests r JOIN jobs j ON j.id=r.job_id JOIN companies c ON c.id=j.company_id WHERE r.candidate_id=? ORDER BY r.updated_at DESC`).all(req.user.id,req.user.id,req.user.id);
    const notifications = db.prepare('SELECT id,type,title,body,href,read_at,created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(req.user.id);
    res.json({ savedJobs: jobs, referralRequests: requests, notifications });
  });

  app.get('/api/candidate/applications', requireApplicant, (req, res) => {
    const applications = db.prepare(`WITH reported_steps AS (
      SELECT wc.id,wc.job_id,wc.completion_state status,wc.created_at,wc.application_id,wc.note message,
        ROW_NUMBER() OVER (PARTITION BY wc.job_id ORDER BY wc.created_at DESC,wc.id DESC) row_number
      FROM workflow_step_completions wc JOIN job_workflow_steps s ON s.id=wc.step_id
      WHERE wc.user_id=? AND wc.completion_state='candidate_reported' AND s.action_type IN ('apply_external','complete_form','send_email')
        AND NOT EXISTS (SELECT 1 FROM referral_requests r WHERE r.candidate_id=wc.user_id AND r.job_id=wc.job_id)
    )
    SELECT r.id,r.job_id,r.status,r.created_at,r.updated_at,r.message,r.application_id,j.title job_title,c.name company_name,
      p.display_name poster_name,'referral_request' kind
      FROM referral_requests r JOIN jobs j ON j.id=r.job_id JOIN companies c ON c.id=j.company_id
      LEFT JOIN profiles p ON p.user_id=j.posted_by WHERE r.candidate_id=?
    UNION ALL
    SELECT s.id,s.job_id,s.status,s.created_at,NULL updated_at,s.message,s.application_id,j.title job_title,c.name company_name,
      p.display_name poster_name,'workflow_progress' kind
      FROM reported_steps s JOIN jobs j ON j.id=s.job_id JOIN companies c ON c.id=j.company_id
      LEFT JOIN profiles p ON p.user_id=j.posted_by WHERE s.row_number=1
    ORDER BY 4 DESC`).all(req.user.id,req.user.id);
    res.json({ applications });
  });

  app.post('/api/jobs', requireRole('employee'), parseBody(jobSchema), (req, res) => {
    const body = req.validatedBody;
    const affiliation = db.prepare(`SELECT a.id,a.work_email_verified_at,a.work_email_domain,c.name company_name FROM employee_affiliations a JOIN companies c ON c.id=a.company_id WHERE a.user_id=? AND a.company_id=?
      AND a.status NOT IN ('rejected','revoked')`).get(req.user.id, body.companyId);
    if (!affiliation) return res.status(403).json({ error: 'An active company affiliation is required to publish.' });
    if (config.enforceVerifiedEmployeeEmail && !employeeCanPublishForCompany(affiliation, config)) return res.status(403).json({ error: 'Verify a company work email whose domain is configured for this company before publishing.' });
    const jobId = id();
    db.exec('BEGIN IMMEDIATE');
    try {
      const duplicate = db.prepare(`SELECT id FROM jobs WHERE company_id=? AND lower(title)=lower(?) AND status IN ('draft','published','paused')
        AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') LIMIT 1`).get(body.companyId, body.title);
      if (duplicate) { db.exec('ROLLBACK'); return res.status(409).json({ error: 'A current listing with this company and title already exists.' }); }
      db.prepare(`INSERT INTO jobs(id,company_id,posted_by,title,description,location,location_type,experience_level,employment_type,
        skills_json,salary_range,source_url,workflow_template,status,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'published',?)`).run(jobId, body.companyId, req.user.id, body.title, body.description, body.location,
        body.locationType, body.experienceLevel, body.employmentType, JSON.stringify(body.skills), body.salaryRange || null,
        body.sourceUrl || null, body.workflowTemplate, body.expiresAt);
      for (const step of body.steps) db.prepare(`INSERT INTO job_workflow_steps(id,job_id,step_number,title,instructions,responsible,action_type,
        destination_url,destination_email,requires_application_id,completion_method) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id(), jobId, step.stepNumber, step.title, step.instructions, step.responsible, step.actionType, step.destinationUrl || null,
          step.destinationEmail || null, Number(step.requiresApplicationId), step.completionMethod);
      audit(db, req.user.id, 'job.published', 'job', jobId, { workflowTemplate: body.workflowTemplate });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.status(201).json({ id: jobId });
  });

  app.patch('/api/jobs/:jobId', requireRole('employee'), parseBody(jobSchema), (req, res) => {
    const body=req.validatedBody;
    const current=db.prepare(`SELECT id,is_demo FROM jobs WHERE id=? AND posted_by=?`).get(req.params.jobId,req.user.id);
    if(!current)return res.status(404).json({error:'Listing not found.'});
    if(current.is_demo)return res.status(403).json({error:'Demo listings cannot be edited.'});
    if(Date.parse(body.expiresAt)<=Date.now())return res.status(400).json({error:'The application deadline must be in the future.'});
    const affiliation=db.prepare(`SELECT a.id,a.work_email_verified_at,a.work_email_domain,c.name company_name FROM employee_affiliations a JOIN companies c ON c.id=a.company_id WHERE a.user_id=? AND a.company_id=? AND a.status NOT IN ('rejected','revoked')`).get(req.user.id,body.companyId);
    if(!affiliation)return res.status(403).json({error:'An active company affiliation is required to edit this listing.'});
    if(config.enforceVerifiedEmployeeEmail && !employeeCanPublishForCompany(affiliation,config))return res.status(403).json({error:'Verify a company work email whose domain is configured for this company before editing listings.'});
    db.exec('BEGIN IMMEDIATE');
    try{
      const duplicate=db.prepare(`SELECT id FROM jobs WHERE id<>? AND company_id=? AND lower(title)=lower(?) AND status IN ('draft','published','paused') AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') LIMIT 1`).get(current.id,body.companyId,body.title);
      if(duplicate){db.exec('ROLLBACK');return res.status(409).json({error:'A current listing with this company and title already exists.'});}
      db.prepare(`UPDATE jobs SET company_id=?,title=?,description=?,location=?,location_type=?,experience_level=?,employment_type=?,skills_json=?,salary_range=?,source_url=?,workflow_template=?,expires_at=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(body.companyId,body.title,body.description,body.location,body.locationType,body.experienceLevel,body.employmentType,JSON.stringify(body.skills),body.salaryRange||null,body.sourceUrl||null,body.workflowTemplate,body.expiresAt,current.id);
      db.prepare('DELETE FROM job_workflow_steps WHERE job_id=?').run(current.id);
      for(const step of body.steps)db.prepare(`INSERT INTO job_workflow_steps(id,job_id,step_number,title,instructions,responsible,action_type,destination_url,destination_email,requires_application_id,completion_method) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id(),current.id,step.stepNumber,step.title,step.instructions,step.responsible,step.actionType,step.destinationUrl||null,step.destinationEmail||null,Number(step.requiresApplicationId),step.completionMethod);
      audit(db,req.user.id,'job.updated','job',current.id,{workflowTemplate:body.workflowTemplate});
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    res.json({id:current.id,updated:true});
  });

  app.patch('/api/jobs/:jobId/status', requireRole('employee'), parseBody(jobStatusSchema), (req,res)=>{
    const job=db.prepare('SELECT id,status,title FROM jobs WHERE id=? AND posted_by=? AND is_demo=0').get(req.params.jobId,req.user.id);
    if(!job)return res.status(404).json({error:'Listing not found.'});
    const next=req.validatedBody.status;
    if(job.status==='closed'||job.status==='removed'||job.status==='expired')return res.status(409).json({error:'This listing is already closed or expired.'});
    if(next==='published' && db.prepare(`SELECT expires_at FROM jobs WHERE id=?`).get(job.id).expires_at<=new Date().toISOString())return res.status(400).json({error:'The application deadline has passed. Edit the listing with a future deadline first.'});
    db.exec('BEGIN IMMEDIATE');
    try{
      db.prepare(`UPDATE jobs SET status=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(next,job.id);
      if(next==='closed'){
        const requests=db.prepare(`SELECT id,candidate_id,status FROM referral_requests WHERE job_id=? AND status NOT IN ('declined','withdrawn','closed','expired')`).all(job.id);
        for(const request of requests){
          db.prepare(`UPDATE referral_requests SET status='closed',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(request.id);
          db.prepare(`INSERT INTO referral_status_history(id,request_id,actor_id,from_status,to_status,note) VALUES (?,?,?,?,?,?)`).run(id(),request.id,req.user.id,request.status,'closed',req.validatedBody.note);
          notify(db,request.candidate_id,'referral_status','Listing closed',`The listing “${job.title}” was closed by its publisher. Reason: ${req.validatedBody.note}`,`/referral-requests/${request.id}`);
        }
      }
      audit(db,req.user.id,`job.${next}`,'job',job.id,{from:job.status,to:next,reason:req.validatedBody.note||null});
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    res.json({id:job.id,status:next});
  });

  app.post('/api/jobs/:jobId/referral-requests', requireApplicant, requestResumeUpload.single('resume'), (req,res,next)=>{
    if (req.body?.resumeConsent === 'true') req.body.resumeConsent = true;
    if (req.body?.useSavedResume === 'true') req.body.useSavedResume = true;
    next();
  }, (req,res,next)=>{
    const result=referralSchema.safeParse(req.body);
    if(!result.success){if(req.file?.path&&existsSync(req.file.path))unlinkSync(req.file.path);return res.status(400).json({error:'Please review the highlighted information.',details:result.error.issues.map((issue)=>({field:issue.path.join('.'),message:issue.message}))});}
    req.validatedBody=result.data;next();
  }, (req, res) => {
    const job = db.prepare(`SELECT j.id,j.title,j.posted_by,j.workflow_template FROM jobs j WHERE j.id=? AND ${publicJobWhere}`).get(req.params.jobId);
    const removeUpload = () => { if (req.file?.path && existsSync(req.file.path)) unlinkSync(req.file.path); };
    if (!job) { removeUpload(); return res.status(404).json({ error: 'This listing is no longer available.' }); }
    const supportsRequest = job.workflow_template === 'request_employee' || db.prepare(`SELECT 1 FROM job_workflow_steps WHERE job_id=? AND action_type='request_referral'`).get(job.id);
    if (!supportsRequest) { removeUpload(); return res.status(400).json({ error: 'This workflow does not accept referral requests. Follow the steps shown on the listing.' }); }
    if (job.posted_by === req.user.id) { removeUpload(); return res.status(403).json({ error: 'You cannot apply for your own job.' }); }
    if (req.file && !req.validatedBody.resumeConsent) { removeUpload(); return res.status(400).json({ error: 'Confirm that you consent to share the uploaded resume with this job’s employee.' }); }
    if (req.validatedBody.useSavedResume && !req.validatedBody.resumeConsent) { removeUpload(); return res.status(400).json({ error: 'Confirm that you consent to share your saved resume with this job’s employee.' }); }
    const signature = req.file ? readFileSync(req.file.path).subarray(0, 8) : null;
    const ext = req.file ? path.extname(req.file.originalname).toLowerCase() : '';
    const signatureValid = !req.file || (ext === '.pdf' ? signature.subarray(0,5).toString() === '%PDF-'
      : ext === '.doc' ? signature.length >= 8 && signature.subarray(0,8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]))
      : ext === '.docx' ? signature.subarray(0,2).toString() === 'PK' : false);
    if (!signatureValid) { removeUpload(); return res.status(400).json({ error: 'The selected file is not a valid PDF, DOC, or DOCX resume.' }); }
    let requestId;
    let reopened = false;
    let generatedResumePath = null;
    try {
      db.exec('BEGIN IMMEDIATE');
      const existing = db.prepare('SELECT id,status FROM referral_requests WHERE job_id=? AND candidate_id=?').get(job.id, req.user.id);
      if (existing && !['declined','withdrawn','closed','expired'].includes(existing.status)) {
        db.exec('ROLLBACK'); removeUpload();
        return res.status(409).json({ error: 'An open or completed referral request already exists for this listing.', requestId: existing.id, status: existing.status });
      }
      requestId = existing?.id ?? id();
      let resumeFile = req.file;
      if (!resumeFile && req.validatedBody.useSavedResume) {
        const profile = db.prepare('SELECT resume_key,resume_name FROM profiles WHERE user_id=?').get(req.user.id);
        const source = profile?.resume_key ? path.join(config.resumeStoragePath, `${profile.resume_key}.pdf`) : null;
        if (!source || !existsSync(source)) { db.exec('ROLLBACK'); removeUpload(); return res.status(400).json({ error: 'No saved resume is available to attach.' }); }
        const storageKey = `${randomUUID()}.pdf`;
        copyFileSync(source, path.join(config.resumeStoragePath, storageKey));
        generatedResumePath = path.join(config.resumeStoragePath, storageKey);
        resumeFile = { filename: storageKey, originalname: profile.resume_name || 'resume.pdf', mimetype: 'application/pdf' };
      }
      if (existing) {
        reopened = true;
        db.prepare(`UPDATE referral_requests SET status='pending',message=?,application_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
          .run(req.validatedBody.message || null, req.validatedBody.applicationId || null, requestId);
        db.prepare(`INSERT INTO referral_status_history(id,request_id,actor_id,from_status,to_status,note) VALUES (?,?,?,?,?,?)`)
          .run(id(), requestId, req.user.id, existing.status, 'pending', 'Candidate reopened this request after its previous cycle ended.');
      } else {
        db.prepare(`INSERT INTO referral_requests(id,job_id,candidate_id,employee_id,message,application_id)
          VALUES (?,?,?,?,?,?)`).run(requestId, job.id, req.user.id, job.posted_by, req.validatedBody.message || null, req.validatedBody.applicationId || null);
        db.prepare(`INSERT INTO referral_status_history(id,request_id,actor_id,from_status,to_status,note)
          VALUES (?,?,?,NULL,'pending','Candidate requested a referral.')`).run(id(), requestId, req.user.id);
      }
      if (resumeFile) {
        db.prepare(`INSERT INTO referral_request_resumes(id,request_id,candidate_id,storage_key,original_name,mime_type,consented_at) VALUES (?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
          .run(id(), requestId, req.user.id, path.basename(resumeFile.filename), path.basename(resumeFile.originalname).slice(0,120), resumeFile.mimetype);
        audit(db, req.user.id, 'resume.shared_with_referral_request', 'referral_request', requestId);
      }
      notify(db, job.posted_by, 'referral_request', reopened ? 'Referral request reopened' : 'New referral request', `${req.user.displayName} ${reopened ? 'reopened' : 'requested'} a referral for “${job.title}”.`, `/referral-requests/${requestId}`);
      audit(db, req.user.id, reopened ? 'referral.reopened' : 'referral.requested', 'referral_request', requestId, { jobId: job.id });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      removeUpload();
      if (generatedResumePath && existsSync(generatedResumePath)) unlinkSync(generatedResumePath);
      if (String(error.message).includes('UNIQUE constraint failed: referral_requests.job_id, referral_requests.candidate_id')) return res.status(409).json({ error: 'You already have a referral request for this job.' });
      throw error;
    }
    res.status(reopened ? 200 : 201).json({ id: requestId, status: 'pending', reopened, message: 'Request recorded. The employee has not yet confirmed a referral.' });
  });

  app.get('/api/referral-requests/:requestId', requireAuth, (req, res) => {
    const request = db.prepare(`SELECT r.*,j.title job_title,j.id job_id,c.name company_name,
      EXISTS(SELECT 1 FROM referral_request_resumes rr WHERE rr.request_id=r.id AND rr.candidate_id=r.candidate_id AND rr.revoked_at IS NULL) request_resume_shared,
      cp.display_name candidate_name,ep.display_name employee_name,
      (SELECT a.work_email_verified_at FROM employee_affiliations a WHERE a.user_id=r.employee_id AND a.company_id=j.company_id ORDER BY a.created_at LIMIT 1) employee_work_email_verified_at
      FROM referral_requests r JOIN jobs j ON j.id=r.job_id JOIN companies c ON c.id=j.company_id
      JOIN profiles cp ON cp.user_id=r.candidate_id JOIN profiles ep ON ep.user_id=r.employee_id WHERE r.id=?`).get(req.params.requestId);
    if (!request) return res.status(404).json({ error: 'Referral request not found.' });
    const isCandidate = req.user.roles.some((role) => role === 'candidate' || role === 'employee') && request.candidate_id === req.user.id;
    const isEmployee = req.user.roles.includes('employee') && request.employee_id === req.user.id;
    if (!isCandidate && !isEmployee) return res.status(404).json({ error: 'Referral request not found.' });
    const history = db.prepare(`SELECT h.id,h.actor_id,h.from_status,h.to_status,h.note,h.created_at,p.display_name actor_name
      FROM referral_status_history h LEFT JOIN profiles p ON p.user_id=h.actor_id WHERE h.request_id=? ORDER BY h.created_at,h.id`).all(request.id);
    const workflowProgress = db.prepare(`SELECT s.id step_id,s.step_number,s.title step_title,s.instructions,s.responsible,s.action_type,
      wc.id completion_id,wc.user_id candidate_id,wc.completion_state,wc.review_status,wc.application_id,wc.note submitted_information,
      wc.employee_response,wc.submitted_at,wc.updated_at,p.display_name candidate_name,
      (SELECT json_group_array(json_object('id',wh.id,'action',wh.action,'status',wh.status,'submittedInformation',wh.submitted_information,
        'employeeResponse',wh.employee_response,'actorName',hp.display_name,'createdAt',wh.created_at))
       FROM workflow_step_review_history wh LEFT JOIN profiles hp ON hp.user_id=wh.actor_id
       WHERE wh.request_id=? AND wh.step_id=s.id ORDER BY wh.created_at,wh.rowid) review_history
      FROM job_workflow_steps s LEFT JOIN workflow_step_completions wc ON wc.step_id=s.id AND wc.request_id=?
      LEFT JOIN profiles p ON p.user_id=wc.user_id WHERE s.job_id=? ORDER BY s.step_number`).all(request.id,request.id,request.job_id)
      .map((step)=>({...step,review_history:JSON.parse(step.review_history||'[]')}));
    const messages = db.prepare(`SELECT m.id,m.author_id,m.body,m.audience,m.created_at,p.display_name author_name,
      (SELECT mr.read_at FROM referral_message_reads mr WHERE mr.message_id=m.id AND mr.user_id=?) read_at FROM referral_request_messages m
      LEFT JOIN profiles p ON p.user_id=m.author_id WHERE m.request_id=? AND (m.audience='participants' OR ?=1) ORDER BY m.created_at,m.id`).all(req.user.id,request.id, Number(isEmployee));
    const nextAction = ({ pending:'Awaiting employee response', accepted:'Employee action required', declined:'No further action · resubmission allowed', candidate_action_needed:'Your response is required', employee_action_needed:'Employee action required', referral_confirmed:'Employee reported referral submission · not independently verified', candidate_reported_applied:'Candidate reported application · not independently verified', withdrawn:'Closed by candidate · resubmission allowed', closed:'Closed · resubmission allowed', expired:'Expired · resubmission allowed' })[request.status] ?? request.status;
    res.json({ request: { ...request, employee_work_email_verified:Boolean(request.employee_work_email_verified_at), nextAction, viewer:isCandidate?'candidate':'employee' }, history, messages, workflowProgress });
  });

  app.patch('/api/referral-requests/:requestId/workflow-steps/:stepId/review', requireRole('employee'), parseBody(workflowStepReviewSchema), (req, res) => {
    const request = db.prepare(`SELECT r.id,r.job_id,r.candidate_id,r.employee_id,r.status,j.title job_title,p.display_name candidate_name
      FROM referral_requests r JOIN jobs j ON j.id=r.job_id JOIN profiles p ON p.user_id=r.candidate_id WHERE r.id=?`).get(req.params.requestId);
    if (!request || request.employee_id !== req.user.id) return res.status(404).json({ error: 'Referral request not found.' });
    if (['closed','declined','withdrawn','expired'].includes(request.status)) return res.status(409).json({ error: 'This referral request is closed and cannot receive workflow decisions.' });
    const step = db.prepare(`SELECT s.id,s.title FROM job_workflow_steps s WHERE s.id=? AND s.job_id=?`).get(req.params.stepId, request.job_id);
    if (!step) return res.status(404).json({ error: 'Workflow step not found for this referral request.' });
    const completion = db.prepare(`SELECT id,review_status FROM workflow_step_completions WHERE request_id=? AND step_id=? AND user_id=?`).get(request.id, step.id, request.candidate_id);
    if (!completion) return res.status(404).json({ error: 'No candidate update exists for this workflow step.' });
    const allowed = ['pending_review','resubmitted'];
    if (!allowed.includes(completion.review_status)) return res.status(409).json({ error: 'This workflow update has already been reviewed or is awaiting candidate changes.' });
    const nextStatus = req.validatedBody.action === 'approve' ? 'approved' : 'changes_requested';
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const currentRequest = db.prepare('SELECT status FROM referral_requests WHERE id=? AND employee_id=?').get(request.id, req.user.id);
      if (!currentRequest || ['closed','declined','withdrawn','expired'].includes(currentRequest.status)) { db.exec('ROLLBACK'); return res.status(409).json({ error: 'This referral request is closed and cannot receive workflow decisions.' }); }
      const updated = db.prepare(`UPDATE workflow_step_completions SET review_status=?,employee_response=?,reviewed_by=?,reviewed_at=?,updated_at=?
        WHERE id=? AND request_id=? AND review_status IN ('pending_review','resubmitted')`).run(nextStatus, req.validatedBody.response, req.user.id, now, now, completion.id, request.id);
      if (!updated.changes) { db.exec('ROLLBACK'); return res.status(409).json({ error: 'This workflow update has already been reviewed.' }); }
      db.prepare(`INSERT INTO workflow_step_review_history(id,completion_id,request_id,step_id,actor_id,action,status,employee_response,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(id(), completion.id, request.id, step.id, req.user.id, nextStatus, nextStatus, req.validatedBody.response, now);
      const title = nextStatus === 'approved' ? 'Workflow step approved' : 'Changes requested on a workflow step';
      notify(db, request.candidate_id, 'workflow_review', title, `${request.job_title} · ${step.title}: ${req.validatedBody.response}`, `/referral-requests/${request.id}?workflowStep=${step.id}`);
      audit(db, req.user.id, `workflow.step_${nextStatus}`, 'workflow_step_completion', completion.id, { requestId: request.id, stepId: step.id });
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    return res.json({ requestId: request.id, stepId: step.id, status: nextStatus });
  });

  const referralMessageLimiter = rateLimit({windowMs:60*60*1000,limit:40,standardHeaders:true,legacyHeaders:false,message:{error:'Too many messages for now. Please try again later.'}});
  app.post('/api/referral-requests/:requestId/messages', requireAuth, referralMessageLimiter, parseBody(requestMessageSchema), (req, res) => {
    const request = db.prepare('SELECT * FROM referral_requests WHERE id=?').get(req.params.requestId);
    if (!request) return res.status(404).json({ error: 'Referral request not found.' });
    const isCandidate = req.user.roles.some((role) => role === 'candidate' || role === 'employee') && request.candidate_id === req.user.id;
    const isEmployee = req.user.roles.includes('employee') && request.employee_id === req.user.id;
    if (!isCandidate && !isEmployee) return res.status(404).json({ error: 'Referral request not found.' });
    if (isCandidate && !['candidate_action_needed','accepted','employee_action_needed'].includes(request.status)) return res.status(409).json({ error: 'You can message the employee after the request is accepted or when information has been requested.' });
    if (['closed','declined','withdrawn','expired'].includes(request.status)) return res.status(409).json({ error: 'This request is closed and cannot receive more messages.' });
    const duplicate = db.prepare(`SELECT id FROM referral_request_messages WHERE request_id=? AND author_id=? AND body=? AND created_at>? LIMIT 1`).get(request.id,req.user.id,req.validatedBody.body,new Date(Date.now()-5000).toISOString());
    if (duplicate) return res.status(409).json({error:'This message was just sent. Wait before sending it again.'});
    const recipient = isCandidate ? request.employee_id : request.candidate_id;
    const nextStatus = isCandidate ? 'employee_action_needed' : request.status;
    db.exec('BEGIN IMMEDIATE');
    try {
      const messageId=id();
      db.prepare('INSERT INTO referral_request_messages(id,request_id,author_id,body) VALUES (?,?,?,?)').run(messageId, request.id, req.user.id, req.validatedBody.body);
      db.prepare('INSERT INTO referral_message_reads(message_id,user_id) VALUES(?,?)').run(messageId,recipient);
      if (isCandidate && request.status !== nextStatus) {
        db.prepare(`UPDATE referral_requests SET status='employee_action_needed',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(request.id);
        db.prepare(`INSERT INTO referral_status_history(id,request_id,actor_id,from_status,to_status,note) VALUES (?,?,?,?,?,?)`)
          .run(id(), request.id, req.user.id, request.status, 'employee_action_needed', 'Candidate responded to the request for additional information.');
      } else {
        db.prepare(`UPDATE referral_requests SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(request.id);
      }
      notify(db, recipient, 'referral_message', 'New referral request update', `${req.user.displayName} added an update to your referral request.`, `/referral-requests/${request.id}`);
      audit(db, req.user.id, 'referral.message_added', 'referral_request', request.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.status(201).json({ added:true, status:nextStatus });
  });
  app.post('/api/referral-requests/:requestId/messages/read',requireAuth,(req,res)=>{
    const request=db.prepare('SELECT candidate_id,employee_id FROM referral_requests WHERE id=?').get(req.params.requestId);if(!request)return res.status(404).json({error:'Referral request not found.'});
    if(![request.candidate_id,request.employee_id].includes(req.user.id))return res.status(404).json({error:'Referral request not found.'});
    const result=db.prepare(`INSERT INTO referral_message_reads(message_id,user_id,read_at)
      SELECT id,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM referral_request_messages WHERE request_id=? AND author_id<>?
      ON CONFLICT(message_id,user_id) DO UPDATE SET read_at=excluded.read_at WHERE referral_message_reads.read_at IS NULL`).run(req.user.id,req.params.requestId,req.user.id);
    res.json({read:true,updated:result.changes});
  });

  const workEmailLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many verification email requests. Please try again later.' } });
  app.patch('/api/employee/affiliations/:affiliationId/work-email', requireRole('employee'), workEmailLimiter, parseBody(workEmailSchema), asyncRoute(async (req, res) => {
    const affiliation = db.prepare(`SELECT a.id,a.company_id,c.name company_name FROM employee_affiliations a
      JOIN companies c ON c.id=a.company_id WHERE a.id=? AND a.user_id=?`).get(req.params.affiliationId, req.user.id);
    if (!affiliation) return res.status(404).json({ error: 'Employee affiliation not found.' });
    const eligibility = verifyWorkEmailEligibility(req.validatedBody.workEmail, affiliation.company_name, config);
    if (eligibility.error) return res.status(400).json({ error: eligibility.error });
    const email = req.validatedBody.workEmail.toLowerCase();
    db.prepare(`UPDATE employee_affiliations SET work_email=?,work_email_domain=?,work_email_verified_at=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(email, eligibility.domain, affiliation.id);
    audit(db, req.user.id, 'employee.work_email_changed', 'employee_affiliation', affiliation.id);
    const delivery = await sendWorkEmailVerification({ db, config, mailer, userId: req.user.id, affiliationId: affiliation.id, email });
    res.json({ workEmail: email, verified: false, delivery });
  }));

  app.post('/api/employee/affiliations/:affiliationId/work-email/verification', requireRole('employee'), workEmailLimiter, asyncRoute(async (req, res) => {
    const affiliation = db.prepare(`SELECT a.id,a.work_email,a.work_email_verified_at,c.name company_name FROM employee_affiliations a
      JOIN companies c ON c.id=a.company_id WHERE a.id=? AND a.user_id=?`).get(req.params.affiliationId, req.user.id);
    if (!affiliation) return res.status(404).json({ error: 'Employee affiliation not found.' });
    if (affiliation.work_email_verified_at) return res.json({ verified: true, delivery: { status: 'already_verified' } });
    if (!affiliation.work_email) return res.status(400).json({ error: 'Add an eligible company work email before requesting verification.' });
    const eligibility = verifyWorkEmailEligibility(affiliation.work_email, affiliation.company_name, config);
    if (eligibility.error) return res.status(400).json({ error: eligibility.error });
    const delivery = await sendWorkEmailVerification({ db, config, mailer, userId: req.user.id, affiliationId: affiliation.id, email: affiliation.work_email });
    res.json({ verified: false, delivery });
  }));

  app.get('/api/employee/work-email/verification-preview', requireRole('employee'), (req, res) => {
    if (config.nodeEnv !== 'development' || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.ip)) return res.status(404).json({ error: 'Not found.' });
    const preview = mailer.getLocalPreview?.(req.user.id);
    if (!preview) return res.status(404).json({ error: 'No current local verification preview. Request a new email.' });
    res.json({ to: preview.to, link: preview.link, expiresAt: preview.expiresAt, localOnly: true });
  });

  app.get('/api/employee/dashboard', requireRole('employee'), (req, res) => {
    const affiliations = db.prepare(`SELECT a.id,a.status,a.job_title,a.work_email,a.work_email_domain,a.work_email_verified_at,c.id company_id,c.name company_name FROM employee_affiliations a
      JOIN companies c ON c.id=a.company_id WHERE a.user_id=? ORDER BY a.created_at DESC`).all(req.user.id);
    const jobs = db.prepare(`SELECT j.id,j.title,j.status,j.workflow_template,j.created_at,j.expires_at,c.name company_name,
      (SELECT COUNT(*) FROM referral_requests r WHERE r.job_id=j.id AND r.status='pending') pending_requests
      FROM jobs j JOIN companies c ON c.id=j.company_id WHERE j.posted_by=? ORDER BY j.created_at DESC`).all(req.user.id);
    const requests = db.prepare(`SELECT r.id,r.status,r.created_at,r.message,r.application_id,j.title job_title,c.name company_name,
      p.display_name candidate_name,
      EXISTS(SELECT 1 FROM referral_request_resumes rr WHERE rr.request_id=r.id AND rr.candidate_id=r.candidate_id AND rr.revoked_at IS NULL) AS request_resume_shared,
      p.resume_consent AS resume_shared,
      (SELECT COUNT(*) FROM referral_request_messages m LEFT JOIN referral_message_reads mr ON mr.message_id=m.id AND mr.user_id=? WHERE m.request_id=r.id AND m.author_id<>? AND mr.read_at IS NULL) unread_message_count
      FROM referral_requests r JOIN jobs j ON j.id=r.job_id JOIN companies c ON c.id=j.company_id
      JOIN profiles p ON p.user_id=r.candidate_id WHERE r.employee_id=? ORDER BY r.updated_at DESC`).all(req.user.id,req.user.id,req.user.id);
    res.json({ affiliations:affiliations.map((affiliation)=>({...affiliation,canPublish:!config.enforceVerifiedEmployeeEmail||employeeCanPublishForCompany(affiliation,config)})), jobs, referralRequests: requests });
  });

  app.get('/api/jobs/:jobId/applicants', requireRole('employee'), (req,res)=>{
    const owned=db.prepare('SELECT id,title,company_id FROM jobs WHERE id=? AND posted_by=?').get(req.params.jobId,req.user.id);
    if(!owned)return res.status(404).json({error:'Listing not found.'});
    const applicants=db.prepare(`SELECT r.id,r.job_id,r.status,r.created_at,r.updated_at,r.message,r.application_id,p.display_name candidate_name,
      EXISTS(SELECT 1 FROM referral_request_resumes rr WHERE rr.request_id=r.id AND rr.candidate_id=r.candidate_id AND rr.revoked_at IS NULL) AS request_resume_shared,
      p.resume_consent AS resume_shared,
      (SELECT COUNT(*) FROM referral_request_messages m LEFT JOIN referral_message_reads mr ON mr.message_id=m.id AND mr.user_id=? WHERE m.request_id=r.id AND m.author_id<>? AND mr.read_at IS NULL) unread_message_count
      FROM referral_requests r JOIN profiles p ON p.user_id=r.candidate_id WHERE r.job_id=? ORDER BY r.created_at DESC`).all(req.user.id,req.user.id,owned.id);
    res.json({job:{id:owned.id,title:owned.title},applicants});
  });

  app.get('/api/jobs/:jobId/manage', requireRole('employee'), (req,res)=>{
    const job=db.prepare(`SELECT j.*,c.name company_name FROM jobs j JOIN companies c ON c.id=j.company_id WHERE j.id=? AND j.posted_by=? AND j.is_demo=0`).get(req.params.jobId,req.user.id);
    if(!job)return res.status(404).json({error:'Listing not found.'});
    const steps=db.prepare(`${stepSelect} WHERE job_id=? ORDER BY step_number`).all(job.id).map(parseStep);
    res.json({job:{id:job.id,companyId:job.company_id,title:job.title,description:job.description,location:job.location,locationType:job.location_type,
      experienceLevel:job.experience_level,employmentType:job.employment_type,skills:JSON.parse(job.skills_json),salaryRange:job.salary_range,sourceUrl:job.source_url,
      workflowTemplate:job.workflow_template,expiresAt:job.expires_at,status:job.status,companyName:job.company_name},steps});
  });

  app.patch('/api/referral-requests/:requestId/status', requireAuth, parseBody(statusSchema), (req, res) => {
    const request = db.prepare('SELECT * FROM referral_requests WHERE id=?').get(req.params.requestId);
    if (!request) return res.status(404).json({ error: 'Referral request not found.' });
    const next = req.validatedBody.status;
    const isEmployee = req.user.roles.includes('employee') && request.employee_id === req.user.id;
    const isCandidate = req.user.roles.some((role) => role === 'candidate' || role === 'employee') && request.candidate_id === req.user.id;
    const employeeOnly = ['accepted','declined','employee_action_needed','referral_confirmed','closed'];
    const candidateOnly = ['candidate_reported_applied','withdrawn'];
    if ((!isEmployee && !isCandidate) || (employeeOnly.includes(next) && !isEmployee) || (candidateOnly.includes(next) && !isCandidate)) return res.status(403).json({ error: 'You cannot make that status change.' });
    const allowed = {
      pending: ['accepted','declined','withdrawn','closed'], accepted: ['candidate_action_needed','employee_action_needed','referral_confirmed','candidate_reported_applied','withdrawn','closed'],
      candidate_action_needed: ['withdrawn'], employee_action_needed: ['candidate_reported_applied','referral_confirmed','candidate_action_needed','closed'],
      candidate_reported_applied: ['employee_action_needed','referral_confirmed','closed'], declined: [], referral_confirmed: ['closed'], withdrawn: [], closed: [], expired: [],
    };
    if (!allowed[request.status]?.includes(next)) return res.status(409).json({ error: `This request cannot move from ${request.status} to ${next}.` });
    if (next === 'referral_confirmed' && !isEmployee) return res.status(403).json({ error: 'Only the employee who owns this request can report a referral submission.' });
    if (next === 'candidate_action_needed' && !req.validatedBody.note?.trim()) return res.status(400).json({ error: 'Add the information the candidate needs to provide.' });
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`UPDATE referral_requests SET status=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(next, request.id);
      db.prepare(`INSERT INTO referral_status_history(id,request_id,actor_id,from_status,to_status,note) VALUES (?,?,?,?,?,?)`)
        .run(id(), request.id, req.user.id, request.status, next, req.validatedBody.note || null);
      if (req.validatedBody.note) db.prepare(`INSERT INTO referral_request_messages(id,request_id,author_id,body) VALUES (?,?,?,?)`)
        .run(id(), request.id, req.user.id, req.validatedBody.note);
      const recipient = req.user.id === request.employee_id ? request.candidate_id : request.employee_id;
      const labels = { pending:'awaiting employee response',accepted:'accepted by employee',declined:'declined by employee',candidate_action_needed:'candidate action required',employee_action_needed:'employee action required',referral_confirmed:'employee reported referral submission (not independently verified)',candidate_reported_applied:'candidate reported application (not independently verified)',withdrawn:'closed by candidate',closed:'closed',expired:'expired' };
      notify(db, recipient, 'referral_status', 'Referral activity updated', `Status: ${labels[next] ?? next.replaceAll('_',' ')}.${next==='closed'?` Reason: ${req.validatedBody.note}`:''}`, `/referral-requests/${request.id}`);
      audit(db, req.user.id, 'referral.status_changed', 'referral_request', request.id, { from: request.status, to: next });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.json({ id: request.id, status: next });
  });

  app.post('/api/jobs/:jobId/reports', requireAuth, parseBody(reportSchema), (req, res) => {
    const exists = db.prepare(`SELECT id FROM jobs WHERE id=? AND status='published'`).get(req.params.jobId);
    if (!exists) return res.status(404).json({ error: 'Listing not found.' });
    const reportId = id();
    db.prepare('INSERT INTO job_reports(id,job_id,reporter_id,reason,details) VALUES (?,?,?,?,?)')
      .run(reportId, exists.id, req.user.id, req.validatedBody.reason, req.validatedBody.details || null);
    audit(db, req.user.id, 'job.reported', 'job_report', reportId, { jobId: exists.id });
    res.status(201).json({ id: reportId, message: 'Report received for review.' });
  });

  app.get('/api/notifications/push-key', requireAuth,(req,res)=>res.json({publicKey:config.webPushPublicKey||null,enabled:Boolean(config.webPushPublicKey&&config.webPushPrivateKey&&config.webPushSubject)}));
  const pushSubscriptionLimiter=rateLimit({windowMs:60*60*1000,limit:20,standardHeaders:true,legacyHeaders:false,message:{error:'Too many browser notification setting changes. Try again later.'}});
  app.post('/api/notifications/push-subscriptions',requireAuth,pushSubscriptionLimiter,parseBody(pushSubscriptionSchema),(req,res)=>{
    if(!config.webPushPublicKey||!config.webPushPrivateKey||!config.webPushSubject)return res.status(503).json({error:'Browser push notifications are not configured yet. In-app notifications remain available.'});
    const saved=db.prepare(`INSERT INTO web_push_subscriptions(id,user_id,endpoint,p256dh,auth) VALUES(?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE web_push_subscriptions.user_id=excluded.user_id`)
      .run(id(),req.user.id,req.validatedBody.endpoint,req.validatedBody.keys.p256dh,req.validatedBody.keys.auth);
    if(!saved.changes)return res.status(409).json({error:'This browser notification subscription is already assigned to another account.'});
    res.status(201).json({subscribed:true});
  });
  app.delete('/api/notifications/push-subscriptions',requireAuth,pushSubscriptionLimiter,parseBody(pushUnsubscribeSchema),(req,res)=>{
    const result=db.prepare('DELETE FROM web_push_subscriptions WHERE endpoint=? AND user_id=?').run(req.validatedBody.endpoint,req.user.id);
    res.json({unsubscribed:true,removed:Boolean(result.changes)});
  });
  app.get('/api/notifications', requireAuth, (req, res) => {
    res.json({ notifications: db.prepare('SELECT id,type,title,body,href,read_at,created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(req.user.id) });
  });
  app.get('/api/notifications/unread-count', requireAuth, (req,res)=>{
    res.json({ unread:db.prepare('SELECT COUNT(*) count FROM notifications WHERE user_id=? AND read_at IS NULL').get(req.user.id).count });
  });
  app.post('/api/notifications/:notificationId/read', requireAuth, (req, res) => {
    const result = db.prepare(`UPDATE notifications SET read_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND user_id=?`).run(req.params.notificationId, req.user.id);
    if (!result.changes) return res.status(404).json({ error: 'Notification not found.' });
    res.json({ read: true });
  });
  app.post('/api/notifications/read-all', requireAuth, (req,res)=>{
    const result=db.prepare(`UPDATE notifications SET read_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=? AND read_at IS NULL`).run(req.user.id);
    res.json({read:true,updated:result.changes});
  });

  app.get('/api/admin/dashboard', requireAdminAccess, (_req, res) => {
    const stats = {
      users: db.prepare('SELECT COUNT(*) count FROM users WHERE disabled_at IS NULL').get().count,
      usersLoggedIn: db.prepare(`SELECT COUNT(DISTINCT actor_id) count FROM audit_events WHERE action='user.signed_in' AND actor_id IS NOT NULL`).get().count,
      loginEvents: db.prepare(`SELECT COUNT(*) count FROM audit_events WHERE action='user.signed_in'`).get().count,
      onlineNow: db.prepare(`SELECT COUNT(DISTINCT s.user_id) count FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE u.disabled_at IS NULL AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND s.last_seen_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes')`).get().count,
      jobsCreated: db.prepare('SELECT COUNT(*) count FROM jobs').get().count,
      openJobs: db.prepare(`SELECT COUNT(*) count FROM jobs WHERE status='published' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`).get().count,
      pendingVerifications: db.prepare(`SELECT COUNT(*) count FROM verification_requests WHERE status='pending'`).get().count,
      openReports: db.prepare(`SELECT COUNT(*) count FROM job_reports WHERE status IN ('open','reviewing')`).get().count,
    };
    const verifications = db.prepare(`SELECT v.id,v.evidence_note,v.created_at,p.display_name,u.email,a.job_title,a.status affiliation_status,c.name company_name
      FROM verification_requests v JOIN employee_affiliations a ON a.id=v.affiliation_id JOIN users u ON u.id=v.submitted_by
      JOIN profiles p ON p.user_id=u.id JOIN companies c ON c.id=a.company_id WHERE v.status='pending' ORDER BY v.created_at`).all();
    const reports = db.prepare(`SELECT r.id,r.reason,r.details,r.status,r.created_at,j.title job_title,j.id job_id,c.name company_name
      FROM job_reports r JOIN jobs j ON j.id=r.job_id JOIN companies c ON c.id=j.company_id WHERE r.status IN ('open','reviewing') ORDER BY r.created_at`).all();
    const recentLogins = db.prepare(`SELECT e.id,e.created_at,p.display_name,u.email FROM audit_events e
      JOIN users u ON u.id=e.actor_id JOIN profiles p ON p.user_id=u.id WHERE e.action='user.signed_in'
      ORDER BY e.created_at DESC,e.id DESC LIMIT 20`).all();
    const recentJobs = db.prepare(`SELECT j.id,j.title,j.status,j.created_at,c.name company_name,p.display_name poster_name,u.email poster_email,
      (SELECT COUNT(*) FROM bookmarks b WHERE b.job_id=j.id) candidate_saves
      FROM jobs j JOIN companies c ON c.id=j.company_id JOIN profiles p ON p.user_id=j.posted_by JOIN users u ON u.id=j.posted_by
      ORDER BY j.created_at DESC LIMIT 30`).all();
    const activity = db.prepare('SELECT id,action,entity_type,entity_id,metadata_json,created_at FROM audit_events ORDER BY created_at DESC LIMIT 30').all().map((event) => ({ ...event, metadata: JSON.parse(event.metadata_json) }));
    res.json({ stats, verifications, reports, recentLogins, recentJobs, activity });
  });

  app.get('/api/admin/users', requireAdminAccess, (_req, res) => {
    const users = db.prepare(`SELECT u.id,u.email,u.created_at,u.disabled_at,p.display_name,
      (SELECT group_concat(role, ',') FROM user_roles WHERE user_id=u.id) roles,
      (SELECT group_concat(c.name, ',') FROM employee_affiliations a JOIN companies c ON c.id=a.company_id WHERE a.user_id=u.id) companies,
      (SELECT COUNT(*) FROM jobs j WHERE j.posted_by=u.id) jobs_created,
      (SELECT MAX(e.created_at) FROM audit_events e WHERE e.actor_id=u.id AND e.action='user.signed_in') last_login_at,
      (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id=u.id AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')) last_seen_at,
      EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=u.id AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND s.last_seen_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes')) online_now
      FROM users u JOIN profiles p ON p.user_id=u.id ORDER BY u.created_at DESC LIMIT 100`).all();
    res.json({ users });
  });

  app.get('/api/admin/contact-messages',requireAdminAccess,(_req,res)=>{
    res.json({messages:db.prepare(`SELECT id,name,email,topic,body,status,created_at,reviewed_at FROM contact_messages ORDER BY status='open' DESC,created_at DESC LIMIT 200`).all()});
  });
  app.patch('/api/admin/contact-messages/:messageId',requireAdminAccess,parseBody(contactReviewSchema),(req,res)=>{
    const result=db.prepare(`UPDATE contact_messages SET status=?,reviewed_by=?,reviewed_at=CASE WHEN ?='resolved' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END WHERE id=?`)
      .run(req.validatedBody.status,req.user.id,req.validatedBody.status,req.params.messageId);
    if(!result.changes)return res.status(404).json({error:'Contact message not found.'});
    audit(db,req.user.id,'contact.message_reviewed','contact_message',req.params.messageId,{status:req.validatedBody.status});
    res.json({id:req.params.messageId,status:req.validatedBody.status});
  });

  app.patch('/api/admin/users/:userId/status', requireAdminAccess, (req, res) => {
    if (typeof req.body?.disabled !== 'boolean') return res.status(400).json({ error: 'disabled must be true or false.' });
    if (req.params.userId === req.user.id && req.body.disabled) return res.status(400).json({ error: 'You cannot disable your own administrator account.' });
    const user = db.prepare('SELECT id,email FROM users WHERE id=?').get(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    db.prepare(`UPDATE users SET disabled_at=${req.body.disabled ? "strftime('%Y-%m-%dT%H:%M:%fZ','now')" : 'NULL'},updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(user.id);
    if (req.body.disabled) db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    audit(db, req.user.id, req.body.disabled ? 'user.disabled' : 'user.enabled', 'user', user.id);
    res.json({ id: user.id, disabled: req.body.disabled });
  });

  app.patch('/api/admin/verifications/:verificationId', requireAdminAccess, parseBody(verificationReviewSchema), (req, res) => {
    const verification = db.prepare(`SELECT v.id,v.affiliation_id,v.submitted_by FROM verification_requests v WHERE v.id=? AND v.status='pending'`).get(req.params.verificationId);
    if (!verification) return res.status(404).json({ error: 'Pending verification request not found.' });
    const status = req.validatedBody.status;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`UPDATE verification_requests SET status=?,reviewed_by=?,review_note=?,reviewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(status, req.user.id, req.validatedBody.reviewNote || null, verification.id);
      db.prepare(`UPDATE employee_affiliations SET status=?,verified_by=?,verified_at=CASE WHEN ?='approved' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(status === 'approved' ? 'verified' : 'rejected', status === 'approved' ? req.user.id : null, status, verification.affiliation_id);
      notify(db, verification.submitted_by, 'verification', `Affiliation ${status}`, req.validatedBody.reviewNote || `Your employee affiliation review was ${status}.`, '/employee');
      audit(db, req.user.id, `verification.${status}`, 'verification_request', verification.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.json({ id: verification.id, status });
  });

  app.patch('/api/admin/reports/:reportId', requireAdminAccess, parseBody(reportReviewSchema), (req, res) => {
    const report = db.prepare('SELECT id,job_id FROM job_reports WHERE id=?').get(req.params.reportId);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    const { status, removeJob } = req.validatedBody;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`UPDATE job_reports SET status=?,reviewed_by=?,reviewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(status, req.user.id, report.id);
      if (removeJob) db.prepare(`UPDATE jobs SET status='removed',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(report.job_id);
      audit(db, req.user.id, 'job_report.reviewed', 'job_report', report.id, { status, removeJob });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.json({ id: report.id, status, jobRemoved: removeJob });
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
  if (existsSync(webDistPath)) {
    app.use(express.static(webDistPath, { index: false, maxAge: config.nodeEnv === 'production' ? '1h' : 0 }));
    app.get('/{*path}', (_req, res) => res.sendFile(path.join(webDistPath, 'index.html')));
  }
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return;
    if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must be valid JSON.' });
    if (error instanceof multer.MulterError) return res.status(400).json({ error: error.field==='screenshots' ? error.code==='LIMIT_FILE_SIZE'?'Each screenshot must be 6 MB or smaller.':'Upload no more than five screenshots.' : error.code === 'LIMIT_FILE_SIZE' ? 'Resume must be 5 MB or smaller.' : 'The file upload could not be accepted.' });
    if (error?.message === 'Only PDF resumes up to 5 MB are supported.' || error?.message === 'Upload a PDF, DOC, or DOCX resume up to 5 MB.' || error?.message === 'Upload PNG or JPEG screenshots up to 6 MB each.') return res.status(400).json({ error: error.message });
    const errorType = ['Error','TypeError','RangeError','SyntaxError','ReferenceError','MulterError','DatabaseError','SqliteError']
      .includes(error?.name) ? error.name : 'Error';
    console.error(`ReferralOS API error (${errorType}).`);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  return app;
}

function createHashHex(value) {
  return createHash('sha256').update(value).digest('hex');
}
