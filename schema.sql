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

alter table mcp_clients enable row level security;

-- El servidor MCP (anon key) puede leer credenciales por código.
-- Nadie puede insertar, actualizar ni borrar via anon key —
-- eso solo lo hace add-client.js con el service role key.
create policy "select by code"
  on mcp_clients for select
  using (true);
