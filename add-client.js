// ============================================================
// add-client.js — Registra un nuevo cliente en Supabase
// ============================================================
// Uso:
//   node add-client.js "Nombre Cliente" TOKEN_PIRIOD acc_ORG
//
// Ejemplo:
//   node add-client.js "CFO Empresa SA" 9046abc123 acc_DcbDbX0
//
// El script genera un código secreto único, lo guarda en
// Supabase junto con las credenciales, e imprime la URL
// que el cliente debe pegar en claude.ai.
// ============================================================

import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVER_URL       = process.env.SERVER_URL || "http://localhost:3000";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Error: faltan variables de entorno SUPABASE_URL y SUPABASE_ANON_KEY");
  process.exit(1);
}

const [, , nombre, piriod_token, piriod_org] = process.argv;

if (!nombre || !piriod_token || !piriod_org) {
  console.error('Uso: node add-client.js "Nombre" PIRIOD_TOKEN PIRIOD_ORG');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Generamos un código de 32 caracteres hexadecimales (128 bits de entropía).
// Es lo suficientemente largo para que sea imposible de adivinar.
const code = randomBytes(16).toString("hex");

const { error } = await supabase
  .from("mcp_clients")
  .insert({ code, piriod_token, piriod_org, nombre });

if (error) {
  console.error("Error guardando en Supabase:", error.message);
  process.exit(1);
}

console.log(`
Cliente registrado: ${nombre}

URL para claude.ai:
  ${SERVER_URL}/mcp/${code}

Guarda esta URL en un lugar seguro — no se puede recuperar el código.
`);
