import fs from 'fs/promises';
import pg from 'pg';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(backendDir, '.env') });

function buildConnectionConfig() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    return {
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
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
    ssl: { rejectUnauthorized: false },
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

export async function initializeDatabase() {
  if (!pool) return false;

  try {
    await query('select 1');
    const schemaSql = await fs.readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
    await query(schemaSql);

    const organisation = await query("insert into organisations (name) values ('Arbor Medical') on conflict do nothing returning id");
    const orgId = organisation.rows[0]?.id || (await query("select id from organisations where name='Arbor Medical' limit 1")).rows[0].id;
    const passwordHash = await bcrypt.hash('reviewer123', 12);
    await query("insert into users (organisation_id,email,password_hash,display_name,role) values ($1,'sofia@arbormedical.com',$2,'Sofia Clark','reviewer') on conflict (organisation_id,email) do update set password_hash=excluded.password_hash", [orgId, passwordHash]);

    const caseCount = await query('select count(*)::int as count from cases where organisation_id=$1', [orgId]);
    if (!caseCount.rows[0].count) {
      await query("insert into cases (organisation_id,case_number,title,document_type,status,risk,confidence,assigned_to) values ($1,'CAS-24081','Infusion Pump — Design Verification','Test report','review_required','high',94,$2),($1,'CAS-24080','Sterile Catheter — Supplier Certificate','Certificate','approved','medium',98,$2)", [orgId, (await query("select id from users where lower(email)=lower('sofia@arbormedical.com') limit 1")).rows[0].id]);
    }

    return true;
  } catch (error) {
    console.error('Database initialization failed:', error);
    throw error;
  }
}
