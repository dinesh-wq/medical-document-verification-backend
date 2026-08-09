import fs from 'fs/promises';
import pg from 'pg';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Try multiple locations so .env works from any working directory
dotenv.config({ path: path.join(backendDir, '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config();


function buildConnectionConfig() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    return {
      connectionString: databaseUrl,
      ssl: databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
      max: 10,
    };
  }

  const host = process.env.DB_HOST || process.env.PGHOST;
  const port = process.env.DB_PORT || process.env.PGPORT || '5432';
  const database = process.env.DB_NAME || process.env.PGDATABASE || 'postgres';
  const user = process.env.DB_USER || process.env.PGUSER || 'postgres';
  const password = process.env.DB_PASSWORD || process.env.PGPASSWORD;

  if (!host || !user || !password) return null;

  return {
    host,
    port: Number(port),
    database,
    user,
    password,
    ssl: host === 'localhost' || host === '127.0.0.1' ? false : { rejectUnauthorized: false },
    max: 10,
  };
}

const connectionConfig = buildConnectionConfig();
export const pool = connectionConfig ? new Pool(connectionConfig) : null;
export const isDatabaseConfigured = Boolean(connectionConfig);

export async function query(text, params) {
  if (!pool) throw new Error('DATABASE connection is not configured');
  return pool.query(text, params);
}

async function upsertUser(organisationId, email, name, role, passwordHash) {
  const result = await query(
    `insert into users (organisation_id,email,password_hash,display_name,role)
     values ($1,$2,$3,$4,$5)
     on conflict (organisation_id,email)
     do update set password_hash=excluded.password_hash, display_name=excluded.display_name, role=excluded.role, active=true, updated_at=now()
     returning id`,
    [organisationId, email, passwordHash, name, role],
  );
  return result.rows[0].id;
}

export async function initializeDatabase() {
  if (!pool) return false;

  await query('select 1');
  const schemaSql = await fs.readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await query(schemaSql);

  const existingOrganisation = await query("select id from organisations where name='Arbor Medical' order by created_at asc limit 1");
  const organisation = existingOrganisation.rowCount
    ? existingOrganisation
    : await query("insert into organisations (name) values ('Arbor Medical') returning id");
  const orgId = organisation.rows[0].id;
  const passwordHash = await bcrypt.hash('reviewer123', 12);

  await upsertUser(orgId, 'applicant@arbormedical.com', 'Avery Stone', 'applicant', passwordHash);
  const reviewerId = await upsertUser(orgId, 'sofia@arbormedical.com', 'Sofia Clark', 'reviewer', passwordHash);
  await upsertUser(orgId, 'supervisor@arbormedical.com', 'Marcus Lee', 'supervisor', passwordHash);
  await upsertUser(orgId, 'admin@arbormedical.com', 'Nadia Rahman', 'compliance_admin', passwordHash);

  await query(
    `insert into cases (organisation_id,case_number,title,document_type,status,risk,confidence,assigned_to,created_at,updated_at) values
      ($1,'CAS-24081','Infusion Pump - Design Verification','Test report','review_required','high',94,$2,now()-interval '2 hours',now()-interval '20 minutes'),
      ($1,'CAS-24080','Sterile Catheter - Supplier Certificate','Certificate','approved','medium',98,$2,now()-interval '5 hours',now()-interval '1 hour'),
      ($1,'CAS-24079','Patient Monitor - Field Service Report','Service report','review_required','high',78,$2,now()-interval '1 day',now()-interval '3 hours'),
      ($1,'CAS-24078','Surgical Drill - Complaint Investigation','Complaint','escalated','critical',88,$2,now()-interval '2 days',now()-interval '4 hours'),
      ($1,'CAS-24077','Ventilator Controller - Device Master Record','Device master record','processing','medium',72,$2,now()-interval '3 days',now()-interval '8 hours'),
      ($1,'CAS-24076','Glucose Sensor - Regulatory Submission','Regulatory submission','review_required','high',84,$2,now()-interval '4 days',now()-interval '12 hours')
     on conflict (organisation_id,case_number) do update set
      title=excluded.title,
      document_type=excluded.document_type,
      risk=excluded.risk,
      confidence=excluded.confidence,
      assigned_to=excluded.assigned_to,
      updated_at=greatest(cases.updated_at, excluded.updated_at)`,
    [orgId, reviewerId],
  );

  const cases = await query('select id, case_number from cases where organisation_id=$1', [orgId]);
  const caseMap = Object.fromEntries(cases.rows.map(row => [row.case_number, row.id]));

  for (const row of cases.rows) {
    const existingDocs = await query('select count(*)::int as count from documents where case_id=$1', [row.id]);
    if (existingDocs.rows[0].count) continue;
    const checksum = Buffer.from(`${row.case_number}-document`).toString('hex').slice(0, 64);
    const doc = await query(
      `insert into documents (organisation_id,case_id,filename,mime_type,checksum,storage_key,malware_status)
       values ($1,$2,$3,'application/pdf',$4,$5,'clean') returning id`,
      [orgId, row.id, `${row.case_number}.pdf`, checksum, `object-store/${checksum}.pdf`],
    );
    await query(
      `insert into extracted_fields (document_id,field_name,field_value,confidence,page_number,bounding_region,model_version,source_snapshot) values
       ($1,'Device identifier',$2,96,1,$3,'gemini-configured',$4),
       ($1,'Document control number',$5,92,1,$3,'gemini-configured',$4),
       ($1,'Review recommendation',$6,84,2,$3,'gemini-configured',$4)`,
      [
        doc.rows[0].id,
        JSON.stringify(`${row.case_number}-UDI`),
        JSON.stringify({ x: 0.12, y: 0.22, width: 0.3, height: 0.05 }),
        JSON.stringify({ page: 1, checksum }),
        JSON.stringify(`${row.case_number}-CTRL`),
        JSON.stringify('Human review required for low-confidence fields'),
      ],
    );
  }

  const exceptionCount = await query('select count(*)::int as count from exceptions e join cases c on c.id=e.case_id where c.organisation_id=$1', [orgId]);
  if (!exceptionCount.rows[0].count) await query(
    `insert into exceptions (case_id,type,severity,status,evidence) values
     ($1,'Conflict','critical','open',$2),
     ($3,'Missing data','high','open',$4),
     ($5,'Low confidence','medium','open',$6),
     ($5,'Duplicate','medium','open',$7)`,
    [
      caseMap['CAS-24078'], JSON.stringify({ message: 'Certificate expiry conflicts with approved supplier record', page: 3 }),
      caseMap['CAS-24081'], JSON.stringify({ message: 'Sterility test result missing from design verification packet', page: 7 }),
      caseMap['CAS-24079'], JSON.stringify({ message: 'Serial number confidence is below the 85% review threshold', page: 2 }),
      JSON.stringify({ message: 'Duplicate service report detected against SR-10943', page: 1 }),
    ],
  );

  const validationCount = await query('select count(*)::int as count from validation_results v join cases c on c.id=v.case_id where c.organisation_id=$1', [orgId]);
  if (!validationCount.rows[0].count) await query(
    `insert into validation_results (case_id,rule_name,status,message,evidence) values
     ($1,'UDI format','passed','Device identifier follows configured format',$2),
     ($1,'Confidence threshold','warning','Delivery accuracy field is below 85% confidence',$3),
     ($4,'Supplier certificate expiry','failed','Certificate expiry conflicts with supplier master data',$5)`,
    [
      caseMap['CAS-24081'], JSON.stringify({ page: 1 }),
      JSON.stringify({ page: 4, confidence: 82 }),
      caseMap['CAS-24078'], JSON.stringify({ page: 3 }),
    ],
  );

  const notificationCount = await query('select count(*)::int as count from notifications where organisation_id=$1', [orgId]);
  if (!notificationCount.rows[0].count) await query(
    `insert into notifications (organisation_id,user_id,title,body,severity,entity_type,entity_id) values
     ($1,$2,'Review assigned','Design verification package requires review','urgent','case','CAS-24081'),
     ($1,$2,'Exception escalated','Complaint investigation has a critical supplier conflict','urgent','case','CAS-24078'),
     ($1,null,'AI extraction completed','A regulatory submission extraction finished and is ready for validation','normal','case','CAS-24076')`,
    [orgId, reviewerId],
  );

  await query(
    `insert into configuration (organisation_id,key,value) values
     ($1,'confidence_threshold',$2),
     ($1,'malware_scanning',$3),
     ($1,'retention_policy',$4)
     on conflict (organisation_id,key) do update set value=excluded.value, updated_at=now()`,
    [
      orgId,
      JSON.stringify({ default: 85, highImpactReview: true }),
      JSON.stringify({ required: true, status: 'enabled' }),
      JSON.stringify({ activeYears: 10, legalHoldSupported: true }),
    ],
  );

  return true;
}
