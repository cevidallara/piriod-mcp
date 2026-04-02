// ============================================================
// Piriod MCP Server
// ============================================================
// Este archivo conecta Claude con tu cuenta de Piriod.com.
// Una vez configurado, puedes hablarle a Claude en lenguaje
// natural y él se encarga de consultar o crear facturas,
// buscar clientes y revisar pagos — sin tocar ningún sistema.
//
// Autenticación por URL única:
//   Cada usuario tiene su propia URL secreta:
//     https://tu-servidor.railway.app/mcp/{code}
//
//   El código identifica al usuario y el servidor busca sus
//   credenciales en Supabase. El usuario solo necesita pegar
//   su URL en claude.ai — no maneja tokens directamente.
//
// Fallback local (Claude Desktop):
//   Si no hay código en la URL, el servidor usa las variables
//   de entorno PIRIOD_TOKEN y PIRIOD_ORG (modo legacy).
// ============================================================

import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ============================================================
// Cliente de Supabase
// ============================================================
// Se conecta a la base de datos donde están guardadas las
// credenciales de cada usuario registrado.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

// URL base de la API de Piriod. No necesitas cambiar esto.
const API_URL = "https://api.piriod.com";

// ============================================================
// Resuelve las credenciales para el request entrante
// ============================================================
// Prioridad:
//   1. Código en la URL /mcp/:code → busca en Supabase
//   2. Variables de entorno PIRIOD_TOKEN / PIRIOD_ORG (fallback local)
//
// Retorna null si el código no existe o las credenciales no están.
const resolveCredentials = async (code) => {
  if (code) {
    const { data, error } = await supabase
      .from("mcp_clients")
      .select("piriod_token, piriod_org")
      .eq("code", code)
      .single();

    if (error || !data) return null;
    return { token: data.piriod_token, org: data.piriod_org };
  }

  // Fallback: variables de entorno (Claude Desktop / uso local)
  const token = process.env.PIRIOD_TOKEN;
  const org   = process.env.PIRIOD_ORG;
  if (!token || !org) return null;
  return { token, org };
};

// ============================================================
// Función auxiliar para hacer llamadas a la API de Piriod
// ============================================================
// Recibe las credenciales del usuario actual (no globales)
// y las incluye en cada petición automáticamente.
const makeApi = (token, org) => async (path, opts = {}) => {
  const res = await fetch(`${API_URL}${path}`, {
    ...opts,
    headers: {
      "Authorization": `Token ${token}`,   // Token del usuario
      "x-simple-workspace": org,            // Organización del usuario
      "Content-Type": "application/json",
      ...opts.headers,
    },
  });
  return res.json();
};

// ============================================================
// Factory: crea un McpServer con las credenciales del usuario
// ============================================================
// En modo stateless (una petición HTTP = una sesión MCP),
// se crea un McpServer nuevo por cada request.
// Las credenciales se pasan por closure, así cada sesión
// usa el token y la organización del usuario que se conectó.
const createMcpServer = (token, org) => {
  const api = makeApi(token, org);
  const server = new McpServer({ name: "piriod", version: "1.0.0" });

  // ============================================================
  // TOOL 1: list_invoices — Listar facturas
  // ============================================================
  // Claude usa esta herramienta cuando le pides cosas como:
  //   "¿Cuáles facturas tengo pendientes?"
  //   "Muéstrame las facturas pagadas del cliente cus_abc"
  //   "Lista todas las facturas en borrador"
  //
  // Parámetros opcionales:
  //   - status:   filtra por estado (draft, finalized, paid)
  //   - customer: filtra por ID de cliente (ej: cus_abc123)
  server.tool("list_invoices", "Lista las facturas.", {
    status:   z.string().optional().describe("draft | finalized | paid"),
    customer: z.string().optional().describe("ID del cliente cus_xxx"),
  }, async ({ status, customer }) => {
    const q = new URLSearchParams();
    if (status)   q.set("status",   status);
    if (customer) q.set("customer", customer);
    const data = await api(`/invoices/?${q}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // ============================================================
  // TOOL 2: create_invoice — Crear y finalizar una factura
  // ============================================================
  // Claude usa esta herramienta cuando le pides cosas como:
  //   "Crea una factura para Juan por 2 horas de consultoría a $500"
  //   "Factura al cliente cus_xyz3 por el servicio mensual de marzo"
  //
  // El proceso es automático: primero crea la factura como borrador
  // y luego la finaliza en un solo paso.
  //
  // Parámetros requeridos:
  //   - customer: ID del cliente (ej: cus_abc123)
  //   - document: tipo de documento (ej: US1)
  //   - date:     fecha de emisión en formato YYYY-MM-DD
  //   - due_date: fecha de vencimiento en formato YYYY-MM-DD
  //   - lines:    lista de conceptos con nombre, cantidad y precio unitario
  server.tool("create_invoice", "Crea y finaliza una factura para un cliente.", {
    customer: z.string().describe("ID del cliente cus_xxx"),
    document: z.string().describe("ID del tipo de documento ej: US1"),
    date:     z.string().describe("Fecha YYYY-MM-DD"),
    due_date: z.string().describe("Vencimiento YYYY-MM-DD"),
    lines:    z.array(z.object({
      name:     z.string(),
      quantity: z.number(),
      amount:   z.number().describe("Precio unitario"),
    })),
  }, async (params) => {
    const draft = await api("/invoices/", { method: "POST", body: JSON.stringify(params) });
    const final = await api(`/invoices/${draft.id}/finalize/`, { method: "POST" });
    return { content: [{ type: "text", text: JSON.stringify(final, null, 2) }] };
  });

  // ============================================================
  // TOOL 3: find_customer — Buscar clientes
  // ============================================================
  // Claude usa esta herramienta cuando le pides cosas como:
  //   "Busca el cliente María García"
  //   "¿Cuál es el ID del cliente con email maria@empresa.com?"
  //
  // Útil para encontrar el ID de un cliente antes de crear
  // una factura o filtrar resultados.
  //
  // Parámetros requeridos:
  //   - search: nombre o email del cliente a buscar
  server.tool("find_customer", "Busca clientes por nombre o email.", {
    search: z.string().describe("Nombre o email del cliente"),
  }, async ({ search }) => {
    const data = await api(`/customers/?search=${encodeURIComponent(search)}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // ============================================================
  // TOOL 4: list_payments — Listar pagos
  // ============================================================
  // Claude usa esta herramienta cuando le pides cosas como:
  //   "¿Cuáles pagos están procesando?"
  //   "Muéstrame los pagos exitosos"
  //   "¿Hay pagos que requieren método de pago?"
  //
  // Parámetros opcionales:
  //   - status: filtra por estado del pago:
  //       requires_payment_method → pendiente de método de pago
  //       processing              → en proceso
  //       succeeded               → completado con éxito
  server.tool("list_payments", "Lista los pagos.", {
    status: z.string().optional().describe("requires_payment_method | processing | succeeded"),
  }, async ({ status }) => {
    const q = status ? `?status=${status}` : "";
    const data = await api(`/payments/${q}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  return server;
};

// ============================================================
// Arranque del servidor HTTP
// ============================================================
// El servidor escucha en el puerto definido por la variable
// de entorno PORT. Railway asigna este valor automáticamente.
// En local puedes usar: PORT=3000 node index.js
const PORT = process.env.PORT || 3000;

// Headers CORS necesarios para que claude.ai (y cualquier
// cliente web) pueda conectarse sin que el navegador bloquee
// la petición.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id",
};

const httpServer = createServer(async (req, res) => {
  // Preflight CORS: el navegador envía OPTIONS antes de la
  // petición real para verificar que el servidor la permite.
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS).end();
    return;
  }

  // Aplicamos los headers CORS a todas las respuestas
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  // Parseamos la URL para soportar /mcp y /mcp/:code
  //   /mcp        → modo legacy con variables de entorno
  //   /mcp/abc123 → busca credenciales del usuario en Supabase
  const { pathname } = new URL(req.url, "http://localhost");
  const match = pathname.match(/^\/mcp\/?([^/]*)$/);

  if (!match) {
    res.writeHead(404).end("Not found");
    return;
  }

  const code = match[1] || null;

  // Buscamos las credenciales del usuario según el código
  const credentials = await resolveCredentials(code);
  if (!credentials) {
    res.writeHead(401).end(JSON.stringify({
      error: code
        ? "Código de acceso inválido o no encontrado."
        : "Se requieren credenciales. Configura PIRIOD_TOKEN y PIRIOD_ORG.",
    }));
    return;
  }

  // Creamos un servidor con las credenciales de este usuario.
  // Cada request tiene su propia instancia — las credenciales
  // nunca se mezclan entre usuarios distintos.
  const server = createMcpServer(credentials.token, credentials.org);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

httpServer.listen(PORT, () => {
  console.log(`Piriod MCP server corriendo en http://localhost:${PORT}/mcp`);
});
