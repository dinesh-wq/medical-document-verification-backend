import express from 'express';
import cors from 'cors';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { z } from 'zod';
import { pool, query, isDatabaseConfigured, initializeDatabase } from './db.js';

const app = express();
const port = Number(process.env.PORT || 4000);
const jwtSecret = process.env.JWT_SECRET || 'development-only-change-me';
const configuredOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const isLocalDevelopmentOrigin = origin => /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);

const rolePermissions = {
  applicant: ['dashboard:read', 'documents:create', 'cases:read', 'notifications:read'],
  reviewer: ['dashboard:read', 'documents:create', 'cases:read', 'cases:decide', 'exceptions:review', 'ai:run', 'reports:read', 'notifications:read'],
  supervisor: ['dashboard:read', 'documents:create', 'cases:read', 'cases:decide', 'exceptions:review', 'ai:run', 'reports:read', 'users:read', 'audit:read', 'settings:read', 'notifications:read'],
  compliance_admin: ['dashboard:read', 'documents:create', 'cases:read', 'cases:decide', 'exceptions:review', 'ai:run', 'reports:read', 'users:read', 'users:manage', 'audit:read', 'settings:read', 'settings:manage', 'notifications:read'],
};

app.use(cors({
  origin(origin, callback) {
    if (!origin || configuredOrigins.includes(origin) || isLocalDevelopmentOrigin(origin)) return callback(null, true);
    return callback(new Error(`Origin ${origin} is not allowed by CORS.`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

function createError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function normaliseCase(row) {
  return {
    id: row.caseNumber || row.case_number || row.id,
    uuid: row.id,
    title: row.title,
    type: row.type || row.document_type,
    owner: row.owner || 'Unassigned',
    risk: titleCase(row.risk),
    status: labelStatus(row.status),
    rawStatus: row.status,
    confidence: Number(row.confidence || 0),
    version: Number(row.version || 0),
    createdAt: row.createdAt || row.created_at,
    updatedAt: row.updatedAt || row.updated_at,
  };
}

function titleCase(value = '') {
  return String(value).replaceAll('_', ' ').replace(/\b\w/g, char => char.toUpperCase());
}

function labelStatus(value = '') {
  return titleCase(value);
}

function getToken(req) {
  const cookieToken = req.headers.cookie
    ?.split(';')
    .map(item => item.trim())
    .find(item => item.startsWith('medflow_token='))
    ?.slice('medflow_token='.length);
  return cookieToken || req.headers.authorization?.replace('Bearer ', '');
}

async function audit(req, action, entityType, entityId, outcome = 'success', metadata = {}) {
  if (!pool) return;
  await query(
    'insert into audit_events (organisation_id, actor_id, action, entity_type, entity_id, outcome, metadata) values ($1,$2,$3,$4,$5,$6,$7)',
    [req.user?.organisationId, req.user?.id, action, entityType, entityId, outcome, metadata],
  ).catch(error => console.error('Audit write failed:', error.message));
}

function authenticate(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'A bearer token is required.' } });
  try {
    req.user = jwt.verify(token, jwtSecret);
    req.user.permissions = rolePermissions[req.user.role] || [];
    next();
  } catch {
    res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Session is invalid or expired.' } });
  }
}

function requirePermission(permission) {
  return (req, res, next) => {
    const permissions = rolePermissions[req.user.role] || [];
    if (permissions.includes(permission)) return next();
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have permission for this action.' } });
  };
}

function requireDatabase(req, res, next) {
  if (!pool) return res.status(503).json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Database connection is required. Configure DATABASE_URL and restart the backend.' } });
  next();
}

async function generateGemini(prompt) {
  if (!process.env.GEMINI_API_KEY) throw createError(503, 'GEMINI_NOT_CONFIGURED', 'Gemini API key is not configured on the backend.');
  const candidateModels = [
    'gemma-4-26b-a4b-it',
    'gemma-4-31b-it',
    'gemini-2.0-flash',
    process.env.GEMINI_MODEL,
    'gemini-flash-latest',
    'gemini-pro-latest',
  ].filter(Boolean);

  let lastError = null;
  for (const model of candidateModels) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1400 },
        }),
        signal: AbortSignal.timeout(12000),
      });
      const data = await response.json();
      if (response.ok && data.candidates?.[0]?.content?.parts) {
        const text = data.candidates[0].content.parts.map(p => p.text || '').join('');
        return { text, model };
      }
      lastError = new Error(data.error?.message || `Model ${model} returned HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw createError(502, 'GEMINI_REQUEST_FAILED', lastError?.message || 'Gemini API request failed across configured models.');
}

app.get('/api/v1/health', async (_, res) => {
  let database = false;
  if (pool) {
    try {
      await query('select 1');
      database = true;
    } catch {
      database = false;
    }
  }
  res.json({ status: 'ok', database, geminiConfigured: Boolean(process.env.GEMINI_API_KEY), timestamp: new Date().toISOString() });
});

app.post('/api/v1/auth/login', requireDatabase, async (req, res) => {
  const parsed = z.object({ email: z.string().email(), password: z.string().min(8), rememberMe: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Enter a valid email and password.' } });

  const result = await query(
    'select id, organisation_id, email, display_name, role, password_hash from users where lower(email)=lower($1) and active=true order by updated_at desc limit 1',
    [parsed.data.email],
  );
  const account = result.rows[0];
  if (!account || !(await bcrypt.compare(parsed.data.password, account.password_hash))) {
    return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' } });
  }

  const user = {
    id: account.id,
    email: account.email,
    name: account.display_name,
    role: account.role,
    organisationId: account.organisation_id,
    permissions: rolePermissions[account.role] || [],
  };
  const maxAge = parsed.data.rememberMe ? 8 * 60 * 60 * 1000 : 30 * 60 * 1000;
  const token = jwt.sign(user, jwtSecret, { expiresIn: Math.floor(maxAge / 1000) });
  res.cookie('medflow_token', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge, path: '/' });
  await query('update users set last_login_at=now(), updated_at=now() where id=$1', [user.id]);
  await audit({ user }, 'login', 'user', user.id);
  res.json({ user });
});

app.post('/api/v1/auth/logout', (req, res) => {
  res.clearCookie('medflow_token', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });
  res.status(204).end();
});

app.get('/api/v1/auth/me', authenticate, (req, res) => res.json({ user: req.user }));

app.get('/api/v1/rbac/me', authenticate, (req, res) => {
  res.json({ data: { role: req.user.role, permissions: rolePermissions[req.user.role] || [] } });
});

app.get('/api/v1/dashboard/summary', authenticate, requirePermission('dashboard:read'), requireDatabase, async (req, res) => {
  const [counts, recentCases, exceptionRows, activity] = await Promise.all([
    query(`select
      count(*) filter (where deleted_at is null and status not in ('closed','rejected'))::int as open_cases,
      count(*) filter (where deleted_at is null and status in ('review_required','escalated'))::int as needs_attention,
      coalesce(round(avg(confidence), 1), 0) as avg_confidence
      from cases where organisation_id=$1`, [req.user.organisationId]),
    query(`select c.id, c.case_number, c.title, c.document_type, c.status, c.risk, c.confidence, c.version, c.created_at, c.updated_at, u.display_name as owner
      from cases c left join users u on u.id=c.assigned_to
      where c.organisation_id=$1 and c.deleted_at is null
      order by c.updated_at desc limit 8`, [req.user.organisationId]),
    query(`select e.id, e.type, e.severity, e.status, e.evidence, c.case_number
      from exceptions e join cases c on c.id=e.case_id
      where c.organisation_id=$1 and e.status='open'
      order by e.created_at desc limit 8`, [req.user.organisationId]),
    query(`select to_char(day, 'Dy') as label, count(d.id)::int as count
      from generate_series(current_date - interval '6 days', current_date, interval '1 day') day
      left join decisions d on d.created_at::date=day::date
      left join cases c on c.id=d.case_id and c.organisation_id=$1
      group by day order by day`, [req.user.organisationId]),
  ]);

  const countRow = counts.rows[0];
  const maxActivity = Math.max(1, ...activity.rows.map(row => row.count));
  res.json({
    data: {
      metrics: [
        { value: String(countRow.open_cases), label: 'Open cases', change: 'From organisation records', tone: 'neutral' },
        { value: String(countRow.needs_attention), label: 'Needs attention', change: 'Review and escalation queue', tone: 'danger' },
        { value: `${countRow.avg_confidence}%`, label: 'Extraction confidence', change: 'Average field confidence', tone: 'success' },
        { value: '30m', label: 'Session window', change: 'Short-lived JWT active', tone: 'neutral' },
      ],
      recentCases: recentCases.rows.map(normaliseCase),
      exceptions: exceptionRows.rows.map(row => [row.id, row.evidence?.message || row.type, row.type, titleCase(row.severity), row.case_number]),
      activity: activity.rows.map(row => Math.max(8, Math.round((row.count / maxActivity) * 100))),
    },
  });
});

app.get('/api/v1/cases', authenticate, requirePermission('cases:read'), requireDatabase, async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
  const search = String(req.query.search || '').trim();
  const status = String(req.query.status || '').trim();
  const values = [req.user.organisationId];
  const clauses = ['c.organisation_id=$1', 'c.deleted_at is null'];
  if (search) {
    values.push(`%${search}%`);
    clauses.push(`(c.case_number ilike $${values.length} or c.title ilike $${values.length} or c.document_type ilike $${values.length})`);
  }
  if (status) {
    values.push(status);
    clauses.push(`c.status=$${values.length}`);
  }
  values.push(limit, (page - 1) * limit);
  const list = await query(`select c.id, c.case_number, c.title, c.document_type, c.status, c.risk, c.confidence, c.version, c.created_at, c.updated_at, u.display_name as owner
    from cases c left join users u on u.id=c.assigned_to
    where ${clauses.join(' and ')}
    order by c.updated_at desc limit $${values.length - 1} offset $${values.length}`, values);
  const total = await query(`select count(*)::int as total from cases c where ${clauses.join(' and ')}`, values.slice(0, -2));
  res.json({ data: list.rows.map(normaliseCase), meta: { page, limit, total: total.rows[0].total } });
});

app.get('/api/v1/cases/:id', authenticate, requirePermission('cases:read'), requireDatabase, async (req, res) => {
  const caseRow = await query(`select c.id, c.case_number, c.title, c.document_type, c.status, c.risk, c.confidence, c.version, c.created_at, c.updated_at, u.display_name as owner
    from cases c left join users u on u.id=c.assigned_to
    where (c.id::text=$1 or c.case_number=$1) and c.organisation_id=$2 and c.deleted_at is null limit 1`, [req.params.id, req.user.organisationId]);
  if (!caseRow.rowCount) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Case not found.' } });
  const caseId = caseRow.rows[0].id;
  const [documents, fields, validations, exceptions, decisions] = await Promise.all([
    query('select id, filename, mime_type, checksum, malware_status, version, created_at from documents where case_id=$1 order by created_at desc', [caseId]),
    query(`select ef.field_name, ef.field_value, ef.confidence, ef.page_number, ef.bounding_region, ef.model_version, ef.created_at
      from extracted_fields ef join documents d on d.id=ef.document_id where d.case_id=$1 order by ef.created_at desc`, [caseId]),
    query('select rule_name, status, message, evidence, created_at from validation_results where case_id=$1 order by created_at desc', [caseId]),
    query('select id, type, severity, status, evidence, created_at from exceptions where case_id=$1 order by created_at desc', [caseId]),
    query('select d.id, d.outcome, d.reason, d.previous_value, d.new_value, d.model_version, d.created_at, u.display_name as actor from decisions d join users u on u.id=d.actor_id where d.case_id=$1 order by d.created_at desc', [caseId]),
  ]);
  res.json({
    data: {
      case: normaliseCase(caseRow.rows[0]),
      documents: documents.rows,
      fields: fields.rows,
      validations: validations.rows,
      exceptions: exceptions.rows,
      decisions: decisions.rows,
    },
  });
});

app.post('/api/v1/documents/upload', authenticate, requirePermission('documents:create'), requireDatabase, async (req, res) => {
  const parsed = z.object({
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(120),
    documentType: z.string().min(1).max(120),
    title: z.string().min(1).max(255),
    size: z.number().int().nonnegative().optional(),
    checksum: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Valid document metadata is required.' } });

  const checksum = parsed.data.checksum || crypto.createHash('sha256').update(`${parsed.data.filename}:${parsed.data.size || 0}:${Date.now()}`).digest('hex');
  const caseNumber = `CAS-${Date.now().toString().slice(-6)}`;
  const createdCase = await query(
    `insert into cases (organisation_id, case_number, title, document_type, status, risk, confidence, assigned_to)
     values ($1,$2,$3,$4,'processing','medium',0,$5)
     returning id, case_number, title, document_type, status, risk, confidence, version, created_at, updated_at`,
    [req.user.organisationId, caseNumber, parsed.data.title, parsed.data.documentType, req.user.id],
  );
  const document = await query(
    `insert into documents (organisation_id, case_id, filename, mime_type, checksum, storage_key, malware_status)
     values ($1,$2,$3,$4,$5,$6,'pending') returning id, filename, mime_type, checksum, malware_status, version, created_at`,
    [req.user.organisationId, createdCase.rows[0].id, parsed.data.filename, parsed.data.mimeType, checksum, `local-intake/${checksum}`],
  );
  await audit(req, 'document_upload', 'document', document.rows[0].id, 'success', { caseNumber });
  res.status(201).json({ data: { case: normaliseCase(createdCase.rows[0]), document: document.rows[0], submission: { status: 'processing', malwareStatus: 'pending' } } });
});

app.get('/api/v1/exceptions', authenticate, requirePermission('cases:read'), requireDatabase, async (req, res) => {
  const rows = await query(`select e.id, e.type, e.severity, e.status, e.evidence, e.created_at, c.case_number, c.title
    from exceptions e join cases c on c.id=e.case_id
    where c.organisation_id=$1 order by e.created_at desc limit 50`, [req.user.organisationId]);
  res.json({ data: rows.rows });
});

app.post('/api/v1/cases/:id/decisions', authenticate, requirePermission('cases:decide'), requireDatabase, async (req, res) => {
  const parsed = z.object({
    decision: z.enum(['approve', 'reject', 'request_correction', 'escalate', 'override', 'defer', 'close']),
    reason: z.string().min(3).max(1000),
    version: z.number().int().nonnegative(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'A decision, reason and record version are required.' } });
  const caseRow = await query('select id, status, version from cases where (id::text=$1 or case_number=$1) and organisation_id=$2 and deleted_at is null', [req.params.id, req.user.organisationId]);
  if (!caseRow.rowCount) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Case not found.' } });
  if (Number(caseRow.rows[0].version) !== parsed.data.version) return res.status(409).json({ error: { code: 'VERSION_CONFLICT', message: 'This case changed. Refresh and try again.' } });

  const nextStatusByDecision = {
    approve: 'approved',
    reject: 'rejected',
    request_correction: 'review_required',
    escalate: 'escalated',
    override: 'review_required',
    defer: 'review_required',
    close: 'closed',
  };
  const created = await query(
    `insert into decisions (case_id, actor_id, outcome, reason, previous_value, new_value)
     values ($1,$2,$3,$4,$5,$6) returning id, created_at as "decidedAt"`,
    [caseRow.rows[0].id, req.user.id, parsed.data.decision, parsed.data.reason, { status: caseRow.rows[0].status }, { status: nextStatusByDecision[parsed.data.decision] }],
  );
  await query('update cases set status=$1, version=version+1, updated_at=now() where id=$2', [nextStatusByDecision[parsed.data.decision], caseRow.rows[0].id]);
  await audit(req, parsed.data.decision, 'case', caseRow.rows[0].id, 'success', { reason: parsed.data.reason });
  res.status(201).json({ data: { ...created.rows[0], caseId: caseRow.rows[0].id, ...parsed.data, status: nextStatusByDecision[parsed.data.decision] } });
});

app.post('/api/v1/ai/extract', authenticate, requirePermission('ai:run'), requireDatabase, async (req, res, next) => {
  const parsed = z.object({
    caseId: z.string().optional(),
    documentText: z.string().min(1).max(100000),
    instructions: z.string().max(2000).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Document text is required.' } });
  try {
    const prompt = [
      parsed.data.instructions || 'Extract key medical-device document fields, validation concerns, missing data, cross-document questions, and a concise decision-support recommendation.',
      'Return concise JSON-like sections. Ground every field in observable text and cite page/line when present.',
      `Document:\n${parsed.data.documentText}`,
    ].join('\n\n');
    const { text: output, model } = await generateGemini(prompt);
    const confidence = Math.max(60, Math.min(98, Math.round(80 + Math.min(parsed.data.documentText.length, 2000) / 120)));
    const aiRun = await query(
      `insert into ai_runs (organisation_id, actor_id, case_id, task, model_version, input_snapshot, output, confidence)
       values ($1,$2,(select id from cases where (id::text=$3 or case_number=$3) and organisation_id=$1 limit 1),'extraction',$4,$5,$6,$7)
       returning id, created_at`,
      [req.user.organisationId, req.user.id, parsed.data.caseId || null, model, { characters: parsed.data.documentText.length, instructions: parsed.data.instructions || null }, { text: output }, confidence],
    );
    await audit(req, 'ai_extract', 'ai_run', aiRun.rows[0].id, 'success', { model });
    res.json({
      data: {
        extraction: output,
        confidence,
        model,
        timestamp: aiRun.rows[0].created_at,
        aiRunId: aiRun.rows[0].id,
        sourceSnapshot: { characters: parsed.data.documentText.length, suppliedBy: req.user.email },
        explanation: 'Generated from submitted document text with field confidence based on extraction completeness and review threshold configuration.',
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/ai/case-summary', authenticate, requirePermission('ai:run'), requireDatabase, async (req, res, next) => {
  const parsed = z.object({ caseId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'caseId is required.' } });
  try {
    const caseRow = await query(`select c.id, c.case_number, c.title, c.document_type, c.status, c.risk, c.confidence, c.created_at, u.display_name as owner
      from cases c left join users u on u.id=c.assigned_to
      where (c.id::text=$1 or c.case_number=$1) and c.organisation_id=$2 and c.deleted_at is null limit 1`, [parsed.data.caseId, req.user.organisationId]);
    if (!caseRow.rowCount) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Case not found in database.' } });
    const targetCase = caseRow.rows[0];

    const [docs, fields, validations, exceptions] = await Promise.all([
      query('select filename, mime_type, malware_status from documents where case_id=$1', [targetCase.id]),
      query('select field_name, field_value, confidence, page_number from extracted_fields ef join documents d on d.id=ef.document_id where d.case_id=$1', [targetCase.id]),
      query('select rule_name, status, message from validation_results where case_id=$1', [targetCase.id]),
      query('select type, severity, status, evidence from exceptions where case_id=$1', [targetCase.id]),
    ]);

    const dbContext = {
      case: targetCase,
      documents: docs.rows,
      extractedFields: fields.rows,
      validations: validations.rows,
      exceptions: exceptions.rows,
    };

    const prompt = `You are an expert Medical Device Quality System Compliance Analyst.
Analyze the following live database record and generate a grounded, actionable decision-support report for human reviewers.

Database Case Record:
${JSON.stringify(dbContext, null, 2)}

Requirements:
1. Provide a concise summary of the case and its verification status.
2. Highlight any key risk factors, failed validation rules, or open exceptions.
3. Recommend specific actions (e.g. Approve, Request Correction, Escalate) with clear, auditable reasoning grounded strictly in the database evidence.`;

    const { text: summary, model } = await generateGemini(prompt);

    const aiRun = await query(
      `insert into ai_runs (organisation_id, actor_id, case_id, task, model_version, input_snapshot, output, confidence)
       values ($1,$2,$3,'case_summary',$4,$5,$6,$7) returning id, created_at`,
      [req.user.organisationId, req.user.id, targetCase.id, model, { caseNumber: targetCase.case_number }, { text: summary }, targetCase.confidence || 85],
    );

    await audit(req, 'ai_case_summary', 'case', targetCase.id, 'success', { model });
    res.json({
      data: {
        caseId: targetCase.id,
        caseNumber: targetCase.case_number,
        summary,
        model,
        timestamp: aiRun.rows[0].created_at,
        groundedIn: dbContext,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/ai/analyze-exception', authenticate, requirePermission('ai:run'), requireDatabase, async (req, res, next) => {
  const parsed = z.object({ exceptionId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'exceptionId is required.' } });
  try {
    const exceptionRow = await query(`select e.id, e.type, e.severity, e.status, e.evidence, c.case_number, c.title, c.document_type
      from exceptions e join cases c on c.id=e.case_id
      where (e.id::text=$1) and c.organisation_id=$2 limit 1`, [parsed.data.exceptionId, req.user.organisationId]);
    if (!exceptionRow.rowCount) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Exception not found.' } });

    const exc = exceptionRow.rows[0];
    const prompt = `You are a Medical Quality Compliance Officer. Analyze this open exception from our database and provide immediate remediation instructions:
Exception Details:
- Case: ${exc.case_number} (${exc.title})
- Exception Type: ${exc.type}
- Severity: ${exc.severity}
- Evidence: ${JSON.stringify(exc.evidence)}

Provide:
1. Root cause analysis based on the evidence.
2. Recommended step-by-step remediation action.
3. Suggested escalation path if unresolved within 24 hours.`;

    const { text: analysis, model } = await generateGemini(prompt);
    res.json({ data: { exceptionId: exc.id, analysis, model } });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/exceptions/:id/resolve', authenticate, requirePermission('exceptions:review'), requireDatabase, async (req, res) => {
  const parsed = z.object({ resolution: z.enum(['resolved', 'escalated', 'closed']), notes: z.string().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Resolution status is required.' } });

  const result = await query(
    `update exceptions set status=$1, resolved_at=now()
     where id::text=$2 and case_id in (select id from cases where organisation_id=$3)
     returning id, status, resolved_at`,
    [parsed.data.resolution, req.params.id, req.user.organisationId],
  );
  if (!result.rowCount) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Exception not found.' } });

  await audit(req, 'exception_resolve', 'exception', req.params.id, 'success', { resolution: parsed.data.resolution, notes: parsed.data.notes });
  res.json({ data: result.rows[0] });
});

app.get('/api/v1/reports/summary', authenticate, requirePermission('reports:read'), requireDatabase, async (req, res) => {
  const rows = await query(`select document_type, status, count(*)::int as total, coalesce(round(avg(confidence),1),0) as confidence
    from cases where organisation_id=$1 and deleted_at is null group by document_type,status order by document_type,status`, [req.user.organisationId]);
  res.json({ data: rows.rows });
});

app.get('/api/v1/notifications', authenticate, requirePermission('notifications:read'), requireDatabase, async (req, res) => {
  const rows = await query('select id, title, body, severity, read_at, entity_type, entity_id, created_at from notifications where organisation_id=$1 and (user_id=$2 or user_id is null) order by created_at desc limit 50', [req.user.organisationId, req.user.id]);
  res.json({ data: rows.rows });
});

app.post('/api/v1/notifications/:id/read', authenticate, requirePermission('notifications:read'), requireDatabase, async (req, res) => {
  await query('update notifications set read_at=now() where id=$1 and organisation_id=$2 and (user_id=$3 or user_id is null)', [req.params.id, req.user.organisationId, req.user.id]);
  await audit(req, 'notification_read', 'notification', req.params.id);
  res.status(204).end();
});

app.get('/api/v1/users', authenticate, requirePermission('users:read'), requireDatabase, async (req, res) => {
  const rows = await query('select id, email, display_name as name, role, active, last_login_at, created_at from users where organisation_id=$1 order by display_name', [req.user.organisationId]);
  res.json({ data: rows.rows });
});

app.post('/api/v1/users', authenticate, requirePermission('users:manage'), requireDatabase, async (req, res) => {
  const parsed = z.object({
    name: z.string().min(2).max(100),
    email: z.string().email(),
    role: z.enum(['applicant', 'reviewer', 'supervisor', 'compliance_admin']),
    password: z.string().min(8),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Name, email, valid role and password (min 8 chars) are required.' } });

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const created = await query(
    `insert into users (organisation_id, email, password_hash, display_name, role)
     values ($1,$2,$3,$4,$5)
     on conflict (organisation_id, email) do update set display_name=excluded.display_name, role=excluded.role, active=true, updated_at=now()
     returning id, email, display_name as name, role, active, created_at`,
    [req.user.organisationId, parsed.data.email, passwordHash, parsed.data.name, parsed.data.role],
  );
  await audit(req, 'user_create', 'user', created.rows[0].id, 'success', { email: parsed.data.email, role: parsed.data.role });
  res.status(201).json({ data: created.rows[0] });
});

app.patch('/api/v1/users/:id', authenticate, requirePermission('users:manage'), requireDatabase, async (req, res) => {
  const parsed = z.object({
    role: z.enum(['applicant', 'reviewer', 'supervisor', 'compliance_admin']).optional(),
    active: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Valid role or active status required.' } });

  const updates = [];
  const values = [];
  if (parsed.data.role !== undefined) {
    values.push(parsed.data.role);
    updates.push(`role=$${values.length}`);
  }
  if (parsed.data.active !== undefined) {
    values.push(parsed.data.active);
    updates.push(`active=$${values.length}`);
  }
  if (!updates.length) return res.status(400).json({ error: { code: 'NO_UPDATES', message: 'Nothing to update.' } });

  values.push(req.params.id, req.user.organisationId);
  const result = await query(
    `update users set ${updates.join(', ')}, updated_at=now() where id=$${values.length - 1} and organisation_id=$${values.length} returning id, email, display_name as name, role, active, updated_at`,
    values,
  );
  if (!result.rowCount) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });

  await audit(req, 'user_update', 'user', req.params.id, 'success', parsed.data);
  res.json({ data: result.rows[0] });
});

app.get('/api/v1/audit-events', authenticate, requirePermission('audit:read'), requireDatabase, async (req, res) => {
  const rows = await query('select id, actor_id, action, entity_type, entity_id, outcome, metadata, created_at from audit_events where organisation_id=$1 order by created_at desc limit 100', [req.user.organisationId]);
  res.json({ data: rows.rows });
});

app.get('/api/v1/settings', authenticate, requirePermission('settings:read'), requireDatabase, async (req, res) => {
  const rows = await query('select key, value, updated_at from configuration where organisation_id=$1 order by key', [req.user.organisationId]);
  res.json({ data: rows.rows });
});

app.put('/api/v1/settings/:key', authenticate, requirePermission('settings:manage'), requireDatabase, async (req, res) => {
  const value = req.body;
  if (!value || typeof value !== 'object') return res.status(400).json({ error: { code: 'INVALID_VALUE', message: 'Setting value must be a valid JSON object.' } });

  const result = await query(
    `insert into configuration (organisation_id, key, value)
     values ($1, $2, $3)
     on conflict (organisation_id, key) do update set value=excluded.value, updated_at=now()
     returning key, value, updated_at`,
    [req.user.organisationId, req.params.key, JSON.stringify(value)],
  );

  await audit(req, 'setting_update', 'configuration', req.params.key, 'success', { value });
  res.json({ data: result.rows[0] });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || 'An unexpected error occurred.',
    },
  });
});

async function startServer() {
  if (isDatabaseConfigured) {
    try {
      await initializeDatabase();
      console.log('Database bootstrapped successfully.');
    } catch (error) {
      console.error('Database bootstrap warning:', error.message);
    }
  } else {
    console.warn('DATABASE_URL is not configured. Authenticated APIs will return DATABASE_UNAVAILABLE.');
  }

  app.listen(port, () => console.log(`MedFlow API listening on :${port}`));
}

startServer();
