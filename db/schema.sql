create extension if not exists "pgcrypto";

do $$ begin create type user_role as enum ('applicant','reviewer','supervisor','compliance_admin'); exception when duplicate_object then null; end $$;
do $$ begin create type case_status as enum ('draft','processing','review_required','approved','rejected','escalated','closed'); exception when duplicate_object then null; end $$;
do $$ begin create type exception_severity as enum ('low','medium','high','critical'); exception when duplicate_object then null; end $$;

create table if not exists organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  email text not null,
  password_hash text not null,
  display_name text not null,
  role user_role not null default 'applicant',
  active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organisation_id,email)
);

create table if not exists cases (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  case_number text not null,
  title text not null,
  document_type text not null,
  status case_status not null default 'draft',
  risk exception_severity not null default 'low',
  confidence numeric(5,2),
  assigned_to uuid references users(id),
  version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(organisation_id,case_number)
);

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  case_id uuid not null references cases(id),
  filename text not null,
  mime_type text not null,
  checksum text not null,
  storage_key text not null,
  malware_status text not null default 'pending',
  version integer not null default 1,
  created_at timestamptz not null default now(),
  unique(organisation_id,checksum,version)
);

create table if not exists extracted_fields (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id),
  field_name text not null,
  field_value jsonb not null,
  confidence numeric(5,2),
  page_number integer,
  bounding_region jsonb,
  model_version text,
  source_snapshot jsonb,
  created_at timestamptz not null default now()
);

create table if not exists validation_results (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id),
  rule_name text not null,
  status text not null,
  message text not null,
  evidence jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists exceptions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id),
  type text not null,
  severity exception_severity not null,
  status text not null default 'open',
  evidence jsonb not null default '{}',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists decisions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id),
  actor_id uuid not null references users(id),
  outcome text not null,
  reason text not null,
  previous_value jsonb,
  new_value jsonb,
  model_version text,
  created_at timestamptz not null default now()
);

create table if not exists ai_runs (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  actor_id uuid references users(id),
  case_id uuid references cases(id),
  task text not null,
  model_version text not null,
  input_snapshot jsonb not null,
  output jsonb not null,
  confidence numeric(5,2),
  reviewer_decision text,
  override_reason text,
  created_at timestamptz not null default now()
);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  user_id uuid references users(id),
  title text not null,
  body text not null,
  severity text not null default 'normal',
  entity_type text,
  entity_id text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists configuration (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  unique(organisation_id,key)
);

create table if not exists audit_events (
  id bigserial primary key,
  organisation_id uuid references organisations(id),
  actor_id uuid references users(id),
  action text not null,
  entity_type text not null,
  entity_id text,
  outcome text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists cases_org_status_idx on cases(organisation_id,status,created_at desc) where deleted_at is null;
create index if not exists cases_org_type_idx on cases(organisation_id,document_type,created_at desc) where deleted_at is null;
create index if not exists documents_case_idx on documents(case_id,created_at desc);
create index if not exists extracted_fields_document_idx on extracted_fields(document_id,field_name);
create index if not exists validation_results_case_idx on validation_results(case_id,status,created_at desc);
create index if not exists exceptions_case_status_idx on exceptions(case_id,status,severity);
create index if not exists notifications_user_idx on notifications(organisation_id,user_id,read_at,created_at desc);
create index if not exists audit_events_org_created_idx on audit_events(organisation_id,created_at desc);
