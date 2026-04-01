import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = "https://api.piriod.com";
const API_KEY = process.env.PIRIOD_TOKEN;
const ORG_ID  = process.env.PIRIOD_ORG;

const api = async (path, opts = {}) => {
  const res = await fetch(`${API_URL}${path}`, {
    ...opts,
    headers: {
      "Authorization": `Token ${API_KEY}`,
      "x-simple-workspace": ORG_ID,
      "Content-Type": "application/json",
      ...opts.headers,
    },
  });
  return res.json();
};

const server = new McpServer({ name: "piriod", version: "1.0.0" });

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

server.tool("find_customer", "Busca clientes por nombre o email.", {
  search: z.string().describe("Nombre o email del cliente"),
}, async ({ search }) => {
  const data = await api(`/customers/?search=${encodeURIComponent(search)}`);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

server.tool("list_payments", "Lista los pagos.", {
  status: z.string().optional().describe("requires_payment_method | processing | succeeded"),
}, async ({ status }) => {
  const q = status ? `?status=${status}` : "";
  const data = await api(`/payments/${q}`);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
