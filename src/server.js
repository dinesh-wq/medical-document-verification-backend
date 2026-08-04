import express from 'express';
import cors from 'cors';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { pool, query } from './db.js';

const app = express();
const port = Number(process.env.PORT || 4000);
const jwtSecret = process.env.JWT_SECRET || 'development-only-change-me';
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || 'http://localhost:3000', credentials: true }));
app.use(express.json({ limit: '2mb' }));

const demoCases = [
  { id:'CAS-24081', title:'Infusion Pump — Design Verification', type:'Test report', status:'review_required', risk:'high', confidence:94, owner:'Maya Chen' },
  { id:'CAS-24080', title:'Sterile Catheter — Supplier Certificate', type:'Certificate', status:'validation_passed', risk:'medium', confidence:98, owner:'Noah Williams' },
];
function audit(req, action, entityType, entityId, outcome = 'success') {
  if (!pool) return;
  query('insert into audit_events (organisation_id, actor_id, action, entity_type, entity_id, outcome, metadata) values ($1,$2,$3,$4,$5,$6,$7)', [req.user?.organisationId, req.user?.id, action, entityType, entityId, outcome, {}]).catch(console.error);
}
function authenticate(req, res, next) {
  const cookieToken = req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith('medflow_token='))?.slice('medflow_token='.length);
  const token = cookieToken || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error:{ code:'UNAUTHENTICATED', message:'A bearer token is required.' } });
  try { req.user = jwt.verify(token, jwtSecret); next(); } catch { res.status(401).json({ error:{ code:'INVALID_TOKEN', message:'Session is invalid or expired.' } }); }
}
function requireRole(...roles) { return (req,res,next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error:{ code:'FORBIDDEN', message:'You do not have permission for this action.' } }); }
async function generateGemini(prompt) {
  if (!process.env.GEMINI_API_KEY) throw Object.assign(new Error('Gemini is not configured.'), { status:503, code:'GEMINI_NOT_CONFIGURED' });
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method:'POST', headers:{ 'Content-Type':'application/json', 'x-goog-api-key':process.env.GEMINI_API_KEY },
    body:JSON.stringify({ contents:[{ role:'user', parts:[{ text:prompt }] }], generationConfig:{ temperature:0.2, maxOutputTokens:1200 } }),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error?.message || 'Gemini request failed.'), { status:response.status, code:'GEMINI_REQUEST_FAILED' });
  return data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
}

app.get('/api/v1/health', (_, res) => res.json({ status:'ok', database: Boolean(pool), timestamp:new Date().toISOString() }));
app.post('/api/v1/auth/login', async (req,res) => {
  const parsed = z.object({ email:z.string().email(), password:z.string().min(8) }).safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error:{ code:'VALIDATION_ERROR', message:'Enter a valid email and password.' } });
  if (!pool) return res.status(503).json({ error:{ code:'DATABASE_UNAVAILABLE', message:'The database is not configured.' } });
  const result = await query('select id, organisation_id, email, display_name, role, password_hash from users where lower(email)=lower($1) and active=true limit 1', [parsed.data.email]);
  const account = result.rows[0];
  if (!account || !(await bcrypt.compare(parsed.data.password, account.password_hash))) return res.status(401).json({ error:{ code:'INVALID_CREDENTIALS', message:'Email or password is incorrect.' } });
  const user = { id:account.id, email:account.email, name:account.display_name, role:account.role, organisationId:account.organisation_id };
  const token = jwt.sign(user, jwtSecret, { expiresIn:'15m' });
  res.cookie('medflow_token', token, { httpOnly:true, sameSite:'lax', secure:process.env.NODE_ENV === 'production', maxAge:15 * 60 * 1000, path:'/' });
  await query('update users set last_login_at=now() where id=$1', [user.id]);
  audit({ user }, 'login', 'user', user.id); res.json({ user });
});
app.post('/api/v1/auth/logout', (req,res) => { res.clearCookie('medflow_token', { httpOnly:true, sameSite:'lax', secure:process.env.NODE_ENV === 'production', path:'/' }); res.status(204).end(); });
app.get('/api/v1/auth/me', authenticate, (req,res) => res.json({ user:req.user }));
app.post('/api/v1/ai/extract', authenticate, requireRole('reviewer','supervisor','compliance_admin'), async (req,res,next) => {
  const parsed = z.object({ documentText:z.string().min(1).max(100000), instructions:z.string().max(2000).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error:{ code:'VALIDATION_ERROR', message:'Document text is required.' } });
  try {
    const extraction = await generateGemini(`${parsed.data.instructions || 'Extract the key medical-document fields, validation concerns and a concise review recommendation.'}\n\nDocument:\n${parsed.data.documentText}`);
    audit(req, 'gemini_extract', 'document', null); res.json({ data:{ extraction, model:process.env.GEMINI_MODEL || 'gemini-3.6-flash' } });
  } catch (error) { next(error); }
});
app.get('/api/v1/cases', authenticate, async (req,res) => {
  const page = Math.max(1, Number(req.query.page || 1)); const limit = Math.min(100, Number(req.query.limit || 25));
  if (!pool) return res.json({ data:demoCases, meta:{ page, limit, total:demoCases.length } });
  const result = await query('select id, case_number as "caseNumber", title, document_type as type, status, risk, confidence, created_at as "createdAt" from cases where organisation_id=$1 and deleted_at is null order by created_at desc limit $2 offset $3', [req.user.organisationId, limit, (page-1)*limit]);
  res.json({ data:result.rows, meta:{ page, limit, total:result.rowCount } });
});
app.post('/api/v1/cases/:id/decisions', authenticate, requireRole('reviewer','supervisor','compliance_admin'), async (req,res) => {
  const parsed = z.object({ decision:z.enum(['approve','reject','request_correction','escalate','override']), reason:z.string().min(3), version:z.number().int().nonnegative() }).safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error:{ code:'VALIDATION_ERROR', message:'A decision, reason and record version are required.' } });
  const caseRow = await query('select id, version from cases where id=$1 and organisation_id=$2 and deleted_at is null', [req.params.id, req.user.organisationId]);
  if (!caseRow.rowCount) return res.status(404).json({ error:{ code:'NOT_FOUND', message:'Case not found.' } });
  if (caseRow.rows[0].version !== parsed.data.version) return res.status(409).json({ error:{ code:'VERSION_CONFLICT', message:'This case changed. Refresh and try again.' } });
  const created = await query('insert into decisions (case_id, actor_id, outcome, reason) values ($1,$2,$3,$4) returning id, created_at as "decidedAt"', [req.params.id, req.user.id, parsed.data.decision, parsed.data.reason]);
  await query('update cases set version=version+1, updated_at=now() where id=$1', [req.params.id]);
  audit(req, parsed.data.decision, 'case', req.params.id); res.status(201).json({ data:{ ...created.rows[0], caseId:req.params.id, ...parsed.data } });
});
app.use((err, req, res, next) => { console.error(err); res.status(err.status || 500).json({ error:{ code:err.code || 'INTERNAL_ERROR', message:err.message || 'An unexpected error occurred.', requestId:req.id } }); });
app.listen(port, () => console.log(`MedFlow API listening on :${port}`));
