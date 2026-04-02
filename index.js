// ============================================================
// Piriod MCP Server
// ============================================================
// Este archivo conecta Claude con tu cuenta de Piriod.com.
// Una vez configurado, puedes hablarle a Claude en lenguaje
// natural y él se encarga de consultar o crear facturas,
// buscar clientes y revisar pagos — sin tocar ningún sistema.
//
// Para que funcione necesitas dos datos de tu cuenta Piriod:
//   - PIRIOD_TOKEN: tu token de API (lo encuentras en Configuración > API)
//   - PIRIOD_ORG:   tu ID de organización (empieza con "acc_")
//
// Estos se configuran en Claude Desktop, no aquí en el código.
// Ver README.md para instrucciones paso a paso.
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// URL base de la API de Piriod. No necesitas cambiar esto.
const API_URL = "https://api.piriod.com";

// Las credenciales se leen desde las variables de entorno
// que configuraste en claude_desktop_config.json.
const API_KEY = process.env.PIRIOD_TOKEN;
const ORG_ID  = process.env.PIRIOD_ORG;

// ============================================================
// Función auxiliar para hacer llamadas a la API de Piriod
// ============================================================
// Cada vez que Claude necesita consultar o enviar algo a Piriod,
// usa esta función. Ella se encarga de incluir tu token y tu
// organización en cada petición automáticamente.
const api = async (path, opts = {}) => {
  const res = await fetch(`${API_URL}${path}`, {
    ...opts,
    headers: {
      "Authorization": `Token ${API_KEY}`,      // Tu token de autenticación
      "x-simple-workspace": ORG_ID,              // Tu organización en Piriod
      "Content-Type": "application/json",
      ...opts.headers,
    },
  });
  return res.json();
};

// ============================================================
// Inicialización del servidor MCP
// ============================================================
// Esto crea el servidor que Claude Desktop va a reconocer
// como "piriod" en su lista de herramientas disponibles.
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

// ============================================================
// Arranque del servidor
// ============================================================
// Esto inicia la conexión entre este servidor y Claude Desktop.
// Claude Desktop ejecuta este archivo automáticamente cuando
// lo necesita — no tienes que hacer nada manualmente.
const transport = new StdioServerTransport();
await server.connect(transport);
