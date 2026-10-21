import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { closeDatabase, migrateDatabase, openDatabase } from '../src/database.js';
import { readConfig } from '../src/config.js';

const allowedOrigin = 'http://127.0.0.1:5173';

async function startServer(t, { demoMode = false, failReady = false, extractor } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'referralos-pilot-test-'));
  const actualDb = openDatabase(path.join(directory, 'test.sqlite'));
  migrateDatabase(actualDb);
  const db = failReady ? {
    prepare(sql) {
      if (sql === 'SELECT 1 AS ready') return { get() { throw new Error('private test database diagnostic'); } };
      return actualDb.prepare(sql);
    },
  } : actualDb;
  const config = {
    ...readConfig({ NODE_ENV: 'test', APP_ORIGINS: allowedOrigin, DEMO_MODE: String(demoMode) }),
    databasePath: path.join(directory, 'test.sqlite'),
    resumeStoragePath: path.join(directory, 'resumes'),
    jobImportStoragePath: path.join(directory, 'imports'),
  };
  const app = createApp({ db, config, screenshotExtractor: extractor, webDistPath: path.join(directory, 'missing-web') });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase(actualDb);
    rmSync(directory, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${server.address().port}`, db: actualDb };
}

test('readiness returns only generic status for database success and failure', async (t) => {
  const working = await startServer(t);
  const ready = await fetch(`${working.base}/api/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: 'ready' });

  const failed = await startServer(t, { failReady: true });
  const unavailable = await fetch(`${failed.base}/api/ready`);
  assert.equal(unavailable.status, 503);
  const failureBody = await unavailable.text();
  assert.deepEqual(JSON.parse(failureBody), { status: 'unavailable' });
  assert.equal(failureBody.includes('private test database diagnostic'), false);
  assert.equal((await fetch(`${failed.base}/api/health`)).status, 200, 'liveness remains independent of database readiness');
});

test('read-only pilot preserves origin and CSRF checks while blocking registration, writes, OCR, and private files', async (t) => {
  let extractionCalls = 0;
  const { base, db } = await startServer(t, {
    demoMode: true,
    extractor: { configured: true, async extract() { extractionCalls += 1; return {}; } },
  });
  const publicConfig = await fetch(`${base}/api/public-config`);
  assert.deepEqual(await publicConfig.json(), { demoMode: true, webPushPublicKey: null });

  db.prepare('INSERT INTO users(id,email,password_hash) VALUES (?,?,?)').run('demo-poster', 'demo-poster@example.test', 'not-a-login-hash');
  db.prepare('INSERT INTO profiles(user_id,display_name) VALUES (?,?)').run('demo-poster', 'Demo Poster');
  db.prepare('INSERT INTO companies(id,name,slug,is_demo) VALUES (?,?,?,1)').run('demo-company', 'Fictional Company', 'fictional-company');
  db.prepare(`INSERT INTO jobs(id,company_id,posted_by,title,description,location,location_type,experience_level,employment_type,
    skills_json,workflow_template,status,is_demo,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)`)
    .run('demo-job', 'demo-company', 'demo-poster', 'Fictional Demo Role', 'Fictional sample only.', 'Remote', 'remote', 'mid', 'full_time', '[]', 'apply_first', 'published', new Date(Date.now() + 86400000).toISOString());
  db.prepare(`INSERT INTO job_workflow_steps(id,job_id,step_number,title,instructions,responsible,action_type,destination_url,destination_email,completion_method)
    VALUES (?,?,1,?,?,?,?,?,?,?)`)
    .run('demo-step', 'demo-job', 'Apply on fictional sample site', 'Use this fictional destination.', 'candidate', 'apply_external', 'https://careers.example.invalid/demo', 'referrer@example.invalid', 'external_unverified');
  const listingResponse = await fetch(`${base}/api/jobs/demo-job`);
  assert.equal(listingResponse.status, 200);
  const listing = await listingResponse.json();
  assert.equal(listing.job.isDemo, true);
  assert.equal(listing.steps[0].destinationUrl, null, 'demo mode does not expose live destination URLs');
  assert.equal(listing.steps[0].destinationEmail, null, 'demo mode does not expose contact addresses');

  const badOrigin = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { origin: 'https://attacker.invalid' } });
  assert.equal(badOrigin.status, 403);
  assert.match((await badOrigin.json()).error, /origin was not accepted/i);

  const csrfResponse = await fetch(`${base}/api/auth/csrf`);
  const token = (await csrfResponse.json()).token;
  const cookie = csrfResponse.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const headers = { origin: allowedOrigin, cookie, 'x-csrf-token': token, 'content-type': 'application/json' };

  const missingCsrf = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { origin: allowedOrigin, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(missingCsrf.status, 403, 'CSRF remains enforced before the demo gate');

  const register = await fetch(`${base}/api/auth/register`, { method: 'POST', headers, body: JSON.stringify({ email: 'pilot@example.test' }) });
  assert.equal(register.status, 403);
  assert.match((await register.json()).error, /read-only/i);

  const extraction = await fetch(`${base}/api/employee/job-imports/unavailable/extract`, { method: 'POST', headers, body: '{}' });
  assert.equal(extraction.status, 403);
  assert.equal(extractionCalls, 0, 'demo mode blocks the OCR adapter before it can run');

  const privateFile = await fetch(`${base}/api/employee/job-imports/draft/image`);
  assert.equal(privateFile.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1, 'blocked requests do not write account data');
});
