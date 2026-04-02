-- Ejecuta este SQL en el SQL Editor de tu proyecto Supabase
-- antes de usar el servidor.

create table mcp_clients (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  piriod_token text not null,
  piriod_org   text not null,
  nombre       text not null,
  created_at   timestamptz default now()
);

-- Ningún usuario anónimo puede leer ni escribir directamente.
-- Solo el servidor (service role) accede a esta tabla.
alter table mcp_clients enable row level security;
