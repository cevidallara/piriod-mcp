// ============================================================
// Piriod MCP Server
// ============================================================
// Conecta Claude con la API REST de Piriod.com.
// Autenticación por URL única: /mcp/{code} -> credenciales en Supabase.
// Fallback local: variables de entorno PIRIOD_TOKEN y PIRIOD_ORG.
// ============================================================

import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const API_URL = "https://api.piriod.com";

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
  const token = process.env.PIRIOD_TOKEN;
  const org   = process.env.PIRIOD_ORG;
  if (!token || !org) return null;
  return { token, org };
};

const makeApi = (token, org) => async (path, opts = {}) => {
  const res = await fetch(`${API_URL}${path}`, {
    ...opts,
    headers: {
      "Authorization": `Token ${token}`,
      "x-simple-workspace": org,
      "Content-Type": "application/json",
      ...opts.headers,
    },
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { status: res.status, body: text }; }
};

// ============================================================
// Helpers para reducir boilerplate al definir tools
// ============================================================
const json = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

const clean = (params) =>
  Object.fromEntries(Object.entries(params).filter(([_, v]) => v !== undefined && v !== null && v !== ""));

const qs = (params) => {
  const str = new URLSearchParams(clean(params)).toString();
  return str ? `?${str}` : "";
};

// ============================================================
// Factory: McpServer con tools enlazados a las credenciales
// ============================================================
const createMcpServer = (token, org) => {
  const api = makeApi(token, org);
  const server = new McpServer({ name: "piriod", version: "2.0.0" });

  // Helpers que requieren `api` en closure
  const list   = (path) => async (params = {}) => json(await api(`${path}${qs(params)}`));
  const get    = (path) => async ({ id }) => json(await api(`${path}/${id}/`));
  const post   = (path) => async (body) => json(await api(path, { method: "POST", body: JSON.stringify(body) }));
  const patch  = (path) => async ({ id, ...body }) => json(await api(`${path}/${id}/`, { method: "PATCH", body: JSON.stringify(body) }));
  const del    = (path) => async ({ id }) => json(await api(`${path}/${id}/`, { method: "DELETE" }));
  const act    = (path, suffix, method = "POST") => async ({ id, ...body }) =>
    json(await api(`${path}/${id}/${suffix}/`, {
      method,
      body: Object.keys(body).length ? JSON.stringify(body) : undefined,
    }));

  // Body genérico para crear/actualizar recursos. Aceptamos cualquier
  // shape; la API de Piriod valida los campos requeridos.
  const anyBody = z.record(z.string(), z.any()).describe("Objeto con los campos del recurso (ver docs de Piriod).");

  // ============================================================
  // REFERENCIAS / LOOKUPS (críticos para construir formularios)
  // ============================================================
  server.tool("list_document_types",
    "Lista los tipos de documento disponibles (boleta, factura, etc). Devuelve el ID que se usa en create_invoice.",
    { country: z.string().optional().describe("Filtrar por país"), search: z.string().optional() },
    list("/generals/documents/"));

  server.tool("list_currencies", "Lista las monedas soportadas (CLP, USD, etc).",
    { search: z.string().optional() }, list("/generals/currencies/"));

  server.tool("list_countries", "Lista los países disponibles.",
    { search: z.string().optional() }, list("/generals/countries/"));

  server.tool("list_states", "Lista estados / provincias.",
    { country: z.string().optional().describe("ID del país"), search: z.string().optional() },
    list("/generals/states/"));

  server.tool("list_exchange_rates", "Lista tipos de cambio entre monedas.",
    { date: z.string().optional().describe("YYYY-MM-DD") }, list("/generals/changes/"));

  server.tool("list_document_references", "Lista los tipos de referencia de documento.",
    {}, list("/generals/references/"));

  server.tool("list_general_banks", "Lista los bancos del directorio (no las cuentas conectadas).",
    { country: z.string().optional() }, list("/generals/banks/"));

  server.tool("list_frequencies", "Lista las frecuencias de facturación (mensual, anual, etc).",
    {}, list("/frequencies/"));

  // ============================================================
  // CUSTOMERS
  // ============================================================
  server.tool("list_customers", "Lista clientes con filtros.", {
    search:   z.string().optional().describe("Nombre o email"),
    country:  z.string().optional(),
    email:    z.string().optional(),
    name:     z.string().optional(),
    tax_id:   z.string().optional(),
    created__gte: z.string().optional().describe("YYYY-MM-DD"),
    created__lte: z.string().optional(),
  }, list("/customers/"));

  // Compat: find_customer es alias por nombre/email (uso histórico del chatbot)
  server.tool("find_customer", "Busca clientes por nombre o email (alias de list_customers con search).",
    { search: z.string() },
    async ({ search }) => json(await api(`/customers/${qs({ search })}`)));

  server.tool("retrieve_customer", "Obtiene un cliente por ID.",
    { id: z.string().describe("cus_xxx") }, get("/customers"));

  server.tool("create_customer",
    "Crea un cliente. Campos requeridos: name, address, country (ID), state (ID). Opcionales: currency, email, phone, tax_id, zip_code, reference, send_invoices, metadata.",
    {
      name:     z.string(),
      address:  z.string(),
      country:  z.string().describe("ID del país (ver list_countries)"),
      state:    z.number().describe("ID del estado (ver list_states)"),
      currency: z.string().optional(),
      email:    z.string().optional(),
      phone:    z.string().optional(),
      tax_id:   z.string().optional(),
      zip_code: z.string().optional(),
      reference: z.string().optional(),
      manager:  z.string().optional(),
      metadata: z.record(z.string(), z.any()).optional(),
      send_invoices:    z.boolean().optional(),
      send_collections: z.boolean().optional(),
      send_vouchers:    z.boolean().optional(),
    },
    post("/customers/"));

  server.tool("update_customer", "Actualiza parcialmente un cliente.",
    { id: z.string(), body: anyBody },
    async ({ id, body }) => json(await api(`/customers/${id}/`, { method: "PATCH", body: JSON.stringify(body) })));

  server.tool("delete_customer", "Elimina un cliente (soft-archive si tiene actividad).",
    { id: z.string() }, del("/customers"));

  server.tool("customer_status", "Snapshot del estado del cliente (suscripciones, deuda, etc).",
    { id: z.string() },
    async ({ id }) => json(await api(`/customers/${id}/status/`)));

  // ============================================================
  // CONTACTS
  // ============================================================
  server.tool("list_contacts", "Lista contactos.", { customer: z.string().optional() }, list("/contacts/"));
  server.tool("retrieve_contact", "Obtiene un contacto.", { id: z.string() }, get("/contacts"));
  server.tool("create_contact", "Crea un contacto.", { body: anyBody },
    async ({ body }) => json(await api(`/contacts/`, { method: "POST", body: JSON.stringify(body) })));
  server.tool("update_contact", "Actualiza un contacto.",
    { id: z.string(), body: anyBody },
    async ({ id, body }) => json(await api(`/contacts/${id}/`, { method: "PATCH", body: JSON.stringify(body) })));
  server.tool("delete_contact", "Elimina un contacto.", { id: z.string() }, del("/contacts"));

  // ============================================================
  // ORG UNITS
  // ============================================================
  server.tool("list_org_units", "Lista unidades organizacionales.", {}, list("/orgunits/"));
  server.tool("retrieve_org_unit", "Obtiene una unidad organizacional.", { id: z.string() }, get("/orgunits"));
  server.tool("create_org_unit", "Crea una unidad organizacional.", { body: anyBody },
    async ({ body }) => json(await api(`/orgunits/`, { method: "POST", body: JSON.stringify(body) })));
  server.tool("update_org_unit", "Actualiza una unidad organizacional.",
    { id: z.string(), body: anyBody },
    async ({ id, body }) => json(await api(`/orgunits/${id}/`, { method: "PATCH", body: JSON.stringify(body) })));
  server.tool("delete_org_unit", "Elimina una unidad organizacional.", { id: z.string() }, del("/orgunits"));

  // ============================================================
  // INVOICES
  // ============================================================
  server.tool("list_invoices", "Lista facturas con filtros.", {
    customer:   z.string().optional().describe("cus_xxx"),
    status:     z.string().optional().describe("draft | finalized | paid | uncollectible"),
    document:   z.number().optional(),
    number:     z.number().optional(),
    date__gte:  z.string().optional().describe("YYYY-MM-DD"),
    date__lte:  z.string().optional(),
    due_date__gte: z.string().optional(),
    due_date__lte: z.string().optional(),
    collection_method: z.string().optional(),
    subscription: z.number().optional(),
  }, list("/invoices/"));

  server.tool("retrieve_invoice", "Obtiene una factura por ID.", { id: z.string() }, get("/invoices"));

  // create_invoice: helper que crea draft + finaliza en un paso (uso del chatbot existente)
  server.tool("create_invoice",
    "Crea y finaliza una factura en un solo paso. Campos requeridos: customer, document (ID, ver list_document_types), date, collection_method, lines. due_date opcional.",
    {
      customer: z.string().describe("ID del cliente cus_xxx"),
      document: z.number().describe("ID numérico del tipo de documento (ver list_document_types)"),
      date:     z.string().describe("Fecha YYYY-MM-DD"),
      due_date: z.string().optional().describe("Vencimiento YYYY-MM-DD"),
      currency: z.string().optional().describe("CLP, USD, etc"),
      collection_method: z.string().describe("manual | charge_automatically"),
      note: z.string().optional(),
      lines: z.array(z.object({
        name:     z.string(),
        quantity: z.number(),
        amount:   z.number().describe("Precio unitario"),
        description: z.string().optional(),
      })),
    },
    async (params) => {
      const draft = await api("/invoices/", { method: "POST", body: JSON.stringify(params) });
      if (!draft.id) return json({ error: "No se pudo crear el draft", details: draft });
      const final = await api(`/invoices/${draft.id}/finalize/`, { method: "POST" });
      return json(final);
    });

  server.tool("create_invoice_draft",
    "Crea una factura en estado draft (sin finalizar). Acepta cualquier campo válido del recurso Invoice.",
    { body: anyBody },
    async ({ body }) => json(await api(`/invoices/`, { method: "POST", body: JSON.stringify(body) })));

  server.tool("update_invoice_draft", "Actualiza una factura en estado draft.",
    { id: z.string(), body: anyBody },
    async ({ id, body }) => json(await api(`/invoices/${id}/`, { method: "PATCH", body: JSON.stringify(body) })));

  server.tool("delete_invoice_draft", "Elimina una factura draft.", { id: z.string() }, del("/invoices"));

  server.tool("finalize_invoice", "Finaliza una factura draft.",
    { id: z.string() },
    async ({ id }) => json(await api(`/invoices/${id}/finalize/`, { method: "POST" })));

  server.tool("render_invoice_pdf", "Devuelve el PDF de la factura (base64).",
    { id: z.string() },
    async ({ id }) => json(await api(`/invoices/${id}/pdf/`)));

  server.tool("toggle_invoice_uncollectible", "Marca/desmarca factura como incobrable.",
    { id: z.string() },
    async ({ id }) => json(await api(`/invoices/${id}/uncollectible/`, { method: "POST" })));

  // ============================================================
  // CREDIT NOTES
  // ============================================================
  server.tool("list_credit_notes", "Lista notas de crédito.",
    { invoice: z.string().optional(), status: z.string().optional() }, list("/creditnotes/"));
  server.tool("retrieve_credit_note", "Obtiene una nota de crédito.", { id: z.string() }, get("/creditnotes"));
  server.tool("create_credit_note_draft",
    "Crea nota de crédito draft. Requeridos: invoice (string), date (YYYY-MM-DD).",
    { body: anyBody },
    async ({ body }) => json(await api(`/creditnotes/`, { method: "POST", body: JSON.stringify(body) })));
  server.tool("update_credit_note_draft", "Actualiza nota de crédito draft.",
    { id: z.string(), body: anyBody },
    async ({ id, body }) => json(await api(`/creditnotes/${id}/`, { method: "PATCH", body: JSON.stringify(body) })));
  server.tool("delete_credit_note_draft", "Elimina nota de crédito draft.", { id: z.string() }, del("/creditnotes"));
  server.tool("finalize_credit_note", "Finaliza nota de crédito.",
    { id: z.string() },
    async ({ id }) => json(await api(`/creditnotes/${id}/finalize/`, { method: "POST" })));
  server.tool("render_credit_note_pdf", "PDF de nota de crédito (base64).",
    { id: z.string() }, async ({ id }) => json(await api(`/creditnotes/${id}/pdf/`)));

  // ============================================================
  // DEBIT NOTES
  // ============================================================
  server.tool("list_debit_notes", "Lista notas de débito.",
    { invoice: z.string().optional() }, list("/debitnotes/"));
  server.tool("retrieve_debit_note", "Obtiene nota de débito.", { id: z.string() }, get("/debitnotes"));
  server.tool("create_debit_note", "Crea nota de débito.", { body: anyBody },
    async ({ body }) => json(await api(`/debitnotes/`, { method: "POST", body: JSON.stringify(body) })));
  server.tool("update_debit_note", "Actualiza nota de débito.",
    { id: z.string(), body: anyBody },
    async ({ id, body }) => json(await api(`/debitnotes/${id}/`, { method: "PATCH", body: JSON.stringify(body) })));
  server.tool("delete_debit_note", "Elimina nota de débito.", { id: z.string() }, del("/debitnotes"));

  // ============================================================
  // PAYMENT RECEIPTS (comprobantes de pago)
  // ============================================================
  server.tool("list_payment_receipts", "Lista comprobantes de pago.", {}, list("/payment-receipts/"));
  server.tool("retrieve_payment_receipt", "Obtiene comprobante de pago.", { id: z.string() }, get("/payment-receipts"));
  server.tool("create_payment_receipt_draft",
    "Crea comprobante de pago draft. Requerido: sources (array de IDs).",
    { body: anyBody },
    async ({ body }) => json(await api(`/payment-receipts/`, { method: "POST", body: JSON.stringify(body) })));
  server.tool("update_payment_receipt_draft", "Actualiza comprobante draft.",
    { id: z.string(), body: anyBody },
    async ({ id, body }) => json(await api(`/payment-receipts/${id}/`, { method: "PATCH", body: JSON.stringify(body) })));
  server.tool("delete_payment_receipt_draft", "Elimina comprobante draft.", { id: z.string() }, del("/payment-receipts"));
  server.tool("finalize_payment_receipt", "Finaliza comprobante de pago.",
    { id: z.string() },
    async ({ id }) => json(await api(`/payment-receipts/${id}/finalize/`, { method: "POST" })));

  // ============================================================
  // PRODUCTS
  // ============================================================
  server.tool("list_products", "Lista productos.", { search: z.string().optional() }, list("/products/"));
  server.tool("retrieve_product", "Obtiene un producto.", { id: z.string() }, get("/products"));
  server.tool("create_product", "Crea un producto. Requeridos: name, unit_label.",
    { name: z.string(), unit_label: z.string().describe("ej: 'unidad', 'hora'") },
    post("/products/"));
  server.tool("update_product", "Actualiza un producto.",
    { id: z.string(), body: anyBody },
    async ({ id, body }) => json(await api(`/products/${id}/`, { method: "PATCH", body: JSON.stringify(body) })));
  server.tool("archive_product", "Archiva un producto (soft-delete).", { id: z.string() }, del("/products"));

  // ============================================================
  // PLANS
  // ============================================================
  server.tool("list_plans", "Lista planes.", { product: z.string().optional() }, list("/plans/"));
  server.tool("retrieve_plan", "Obtiene un plan.", { id: z.string() }, get("/plans"));
  server.tool("create_plan",
    "Crea un plan. Requeridos: product (ID), name, description, frequency, currency, amount.",
    {
      product:     z.string(),
      name:        z.string(),
      description: z.string(),
      frequency:   z.string().describe("ID de frecuencia (ver list_frequencies)"),
      currency:    z.string(),
      amount:      z.number(),
      sku:         z.string().optional(),
      exempt:      z.boolean().optional(),
      unit_label:  z.string().optional(),
    },
    post("/plans/"));
  server.tool("update_plan", "Actualiza campos mutables de un plan.",
    { id: z.string(), body: anyBody },
    async ({ id, body }) => json(await api(`/plans/${id}/`, { method: "PATCH", body: JSON.stringify(body) })));
  server.tool("archive_plan", "Archiva un plan.", { id: z.string() }, del("/plans"));

  // ============================================================
  // ADDONS
  // ============================================================
  server.tool("list_addons", "Lista addons.", {}, list("/addons/"));
  server.tool("retrieve_addon", "Obtiene addon.", { id: z.string() }, get("/addons"));
  server.tool("create_addon", "Crea addon.", { body: anyBody },
    async ({ body }) => json(await api(`/addons/`, { method: "POST", body: JSON.stringify(body) })));
  server.tool("update_addon", "Actualiza addon.",
    { id: z.string(), body: anyBody },
    async ({ id, body }) => json(await api(`/addons/${id}/`, { method: "PATCH", body: JSON.stringify(body) })));
  server.tool("archive_addon", "Archiva addon.", { id: z.string() }, del("/addons"));

  // ============================================================
  // COUPONS
  // ============================================================
  server.tool("list_coupons", "Lista cupones.", {}, list("/coupons/"));
  server.tool("retrieve_coupon", "Obtiene cupón.", { id: z.string() }, get("/coupons"));
  server.tool("create_coupon", "Crea cupón.", { body: anyBody },
    async ({ body }) => json(await api(`/coupons/`, { method: "POST", body: JSON.stringify(body) })));
  server.tool("update_coupon", "Actualiza cupón.",
    { id: z.string(), body: anyBody },
    async ({ id, body }) => json(await api(`/coupons/${id}/`, { method: "PATCH", body: JSON.stringify(body) })));
  server.tool("archive_coupon", "Archiva cupón.", { id: z.string() }, del("/coupons"));

  // ============================================================
  // SUBSCRIPTIONS
  // ============================================================
  server.tool("list_subscriptions", "Lista suscripciones.",
    { customer: z.string().optional(), status: z.string().optional() }, list("/subscriptions/"));
  server.tool("retrieve_subscription", "Obtiene suscripción.", { id: z.string() }, get("/subscriptions"));
  server.tool("create_subscription",
    "Crea suscripción. Requeridos: customer, document (ID), date_start, next_billing, lines.",
    { body: anyBody },
    async ({ body }) => json(await api(`/subscriptions/`, { method: "POST", body: JSON.stringify(body) })));
  server.tool("update_subscription", "Actualiza suscripción.",
    { id: z.string(), body: anyBody },
    async ({ id, body }) => json(await api(`/subscriptions/${id}/`, { method: "PATCH", body: JSON.stringify(body) })));
  server.tool("cancel_subscription", "Cancela suscripción.", { id: z.string() }, del("/subscriptions"));
  server.tool("pause_subscription", "Pausa una suscripción.",
    { id: z.string(), pause_until: z.string().optional(), paused_reason: z.string().optional() },
    async ({ id, ...body }) => json(await api(`/subscriptions/${id}/pause/`, { method: "POST", body: JSON.stringify(body) })));
  server.tool("resume_subscription", "Reanuda una suscripción.",
    { id: z.string() },
    async ({ id }) => json(await api(`/subscriptions/${id}/resume/`, { method: "POST" })));
  server.tool("list_subscription_events", "Lista eventos de una suscripción.",
    { id: z.string() }, async ({ id }) => json(await api(`/subscriptions/${id}/events/`)));

  // ============================================================
  // USAGES (medición para planes por consumo)
  // ============================================================
  server.tool("list_usages", "Lista registros de uso.",
    { subscription: z.string().optional() }, list("/usages/"));
  server.tool("record_usage", "Registra uso para un plan medido.", { body: anyBody },
    async ({ body }) => json(await api(`/usages/`, { method: "POST", body: JSON.stringify(body) })));

  // ============================================================
  // PAYMENTS
  // ============================================================
  server.tool("list_payments", "Lista pagos.",
    {
      status: z.string().optional().describe("requires_payment_method | processing | succeeded"),
      customer: z.string().optional(),
      invoice: z.string().optional(),
    },
    list("/payments/"));
  server.tool("retrieve_payment", "Obtiene un pago.", { id: z.string() }, get("/payments"));
  server.tool("create_payment",
    "Crea un pago. Requeridos: amount, currency, date, description. Opcional: invoice, customer, source.",
    {
      amount: z.number(),
      currency: z.string(),
      date: z.string(),
      description: z.string(),
      invoice: z.string().optional(),
      customer: z.string().optional(),
      source: z.number().optional(),
      metadata: z.record(z.string(), z.any()).optional(),
    },
    post("/payments/"));
  server.tool("update_payment", "Actualiza un pago.",
    { id: z.string(), body: anyBody },
    async ({ id, body }) => json(await api(`/payments/${id}/`, { method: "PATCH", body: JSON.stringify(body) })));
  server.tool("delete_payment", "Elimina un pago.", { id: z.string() }, del("/payments"));

  // ============================================================
  // REFUNDS
  // ============================================================
  server.tool("create_refund", "Crea un refund.", { body: anyBody },
    async ({ body }) => json(await api(`/refunds/`, { method: "POST", body: JSON.stringify(body) })));

  // ============================================================
  // SOURCES (métodos de pago tokenizados)
  // ============================================================
  server.tool("list_sources", "Lista sources de pago.",
    { customer: z.string().optional() }, list("/sources/"));
  server.tool("retrieve_source", "Obtiene un source.", { id: z.string() }, get("/sources"));
  server.tool("delete_source", "Elimina o finaliza un source.", { id: z.string() }, del("/sources"));

  // ============================================================
  // PAYMENT LINKS
  // ============================================================
  server.tool("list_payment_links", "Lista links de pago.", {}, list("/payment_links/links/"));
  server.tool("retrieve_payment_link", "Obtiene un link de pago.", { id: z.string() }, get("/payment_links/links"));
  server.tool("create_payment_link", "Crea un link de pago.", { body: anyBody },
    async ({ body }) => json(await api(`/payment_links/links/`, { method: "POST", body: JSON.stringify(body) })));
  server.tool("update_payment_link", "Actualiza un link de pago.",
    { id: z.string(), body: anyBody },
    async ({ id, body }) => json(await api(`/payment_links/links/${id}/`, { method: "PATCH", body: JSON.stringify(body) })));
  server.tool("archive_payment_link", "Archiva un link de pago.", { id: z.string() }, del("/payment_links/links"));

  // ============================================================
  // BANKS
  // ============================================================
  server.tool("list_banks", "Lista cuentas bancarias conectadas.", {}, list("/banks/"));
  server.tool("create_bank", "Conecta una cuenta bancaria.", { body: anyBody },
    async ({ body }) => json(await api(`/banks/`, { method: "POST", body: JSON.stringify(body) })));
  server.tool("update_bank", "Actualiza una cuenta bancaria.",
    { id: z.string(), body: anyBody },
    async ({ id, body }) => json(await api(`/banks/${id}/`, { method: "PATCH", body: JSON.stringify(body) })));
  server.tool("sync_bank", "Sincroniza movimientos del banco.",
    { id: z.string() }, async ({ id }) => json(await api(`/banks/${id}/sync/`, { method: "POST" })));

  // ============================================================
  // BOLETOS (Brasil)
  // ============================================================
  server.tool("list_boletos", "Lista boletos.", {}, list("/boletos/"));
  server.tool("retrieve_boleto", "Obtiene boleto.", { id: z.string() }, get("/boletos"));
  server.tool("create_boleto", "Crea boleto.", { body: anyBody },
    async ({ body }) => json(await api(`/boletos/`, { method: "POST", body: JSON.stringify(body) })));
  server.tool("update_boleto", "Actualiza boleto.",
    { id: z.string(), body: anyBody },
    async ({ id, body }) => json(await api(`/boletos/${id}/`, { method: "PATCH", body: JSON.stringify(body) })));
  server.tool("delete_boleto", "Elimina boleto.", { id: z.string() }, del("/boletos"));

  // ============================================================
  // ACH TRANSFERS
  // ============================================================
  server.tool("list_ach_transfers", "Lista transferencias ACH.", {}, list("/ach_transfers/"));
  server.tool("retrieve_ach_transfer", "Obtiene transferencia ACH.", { id: z.string() }, get("/ach_transfers"));
  server.tool("create_ach_transfer", "Crea transferencia ACH.", { body: anyBody },
    async ({ body }) => json(await api(`/ach_transfers/`, { method: "POST", body: JSON.stringify(body) })));
  server.tool("update_ach_transfer", "Actualiza transferencia ACH.",
    { id: z.string(), body: anyBody },
    async ({ id, body }) => json(await api(`/ach_transfers/${id}/`, { method: "PATCH", body: JSON.stringify(body) })));
  server.tool("archive_ach_transfer", "Archiva transferencia ACH.", { id: z.string() }, del("/ach_transfers"));

  // ============================================================
  // SUPPLIERS
  // ============================================================
  server.tool("list_suppliers", "Lista proveedores.", { search: z.string().optional() }, list("/suppliers/"));
  server.tool("retrieve_supplier", "Obtiene proveedor.", { id: z.string() }, get("/suppliers"));
  server.tool("create_supplier", "Crea proveedor.", { body: anyBody },
    async ({ body }) => json(await api(`/suppliers/`, { method: "POST", body: JSON.stringify(body) })));
  server.tool("update_supplier", "Actualiza proveedor.",
    { id: z.string(), body: anyBody },
    async ({ id, body }) => json(await api(`/suppliers/${id}/`, { method: "PATCH", body: JSON.stringify(body) })));
  server.tool("delete_supplier", "Elimina proveedor.", { id: z.string() }, del("/suppliers"));

  // ============================================================
  // ORDERS (procurement / órdenes de compra)
  // ============================================================
  server.tool("list_orders", "Lista órdenes.", { supplier: z.string().optional(), status: z.string().optional() }, list("/orders/"));
  server.tool("retrieve_order", "Obtiene una orden.", { id: z.string() }, get("/orders"));
  server.tool("create_order_draft", "Crea una orden en draft.", { body: anyBody },
    async ({ body }) => json(await api(`/orders/`, { method: "POST", body: JSON.stringify(body) })));
  server.tool("update_order", "Actualiza una orden.",
    { id: z.string(), body: anyBody },
    async ({ id, body }) => json(await api(`/orders/${id}/`, { method: "PATCH", body: JSON.stringify(body) })));
  server.tool("delete_order", "Elimina una orden.", { id: z.string() }, del("/orders"));
  server.tool("finalize_order", "Finaliza orden.",
    { id: z.string() }, async ({ id }) => json(await api(`/orders/${id}/finalize/`, { method: "POST" })));
  server.tool("render_order_pdf", "PDF de la orden.", { id: z.string() },
    async ({ id }) => json(await api(`/orders/${id}/pdf/`)));

  // ============================================================
  // PURCHASES (compras recibidas)
  // ============================================================
  server.tool("list_purchases", "Lista compras.", { supplier: z.string().optional() }, list("/purchases/"));
  server.tool("retrieve_purchase", "Obtiene compra.", { id: z.string() }, get("/purchases"));
  server.tool("create_purchase_draft", "Crea compra en draft.", { body: anyBody },
    async ({ body }) => json(await api(`/purchases/`, { method: "POST", body: JSON.stringify(body) })));
  server.tool("update_purchase_draft", "Actualiza compra draft.",
    { id: z.string(), body: anyBody },
    async ({ id, body }) => json(await api(`/purchases/${id}/`, { method: "PATCH", body: JSON.stringify(body) })));
  server.tool("delete_purchase_draft", "Elimina compra draft.", { id: z.string() }, del("/purchases"));
  server.tool("finalize_purchase", "Finaliza una compra.",
    { id: z.string() }, async ({ id }) => json(await api(`/purchases/${id}/finalize/`, { method: "POST" })));
  server.tool("render_purchase_pdf", "PDF de compra.", { id: z.string() },
    async ({ id }) => json(await api(`/purchases/${id}/pdf/`)));

  // ============================================================
  // PURCHASE CREDIT NOTES
  // ============================================================
  server.tool("list_purchase_credit_notes", "Lista notas de crédito de compra.", {}, list("/purchases/credit-notes/"));
  server.tool("retrieve_purchase_credit_note", "Obtiene nota de crédito de compra.",
    { id: z.string() }, get("/purchases/credit-notes"));
  server.tool("create_purchase_credit_note_draft", "Crea nota de crédito de compra en draft.",
    { body: anyBody },
    async ({ body }) => json(await api(`/purchases/credit-notes/`, { method: "POST", body: JSON.stringify(body) })));
  server.tool("finalize_purchase_credit_note", "Finaliza nota de crédito de compra.",
    { id: z.string() },
    async ({ id }) => json(await api(`/purchases/credit-notes/${id}/finalize/`, { method: "POST" })));

  // ============================================================
  // RETENTIONS
  // ============================================================
  server.tool("list_retentions", "Lista retenciones.", {}, list("/retentions/"));
  server.tool("retrieve_retention", "Obtiene retención.", { id: z.string() }, get("/retentions"));
  server.tool("create_retention_draft", "Crea retención en draft.", { body: anyBody },
    async ({ body }) => json(await api(`/retentions/`, { method: "POST", body: JSON.stringify(body) })));
  server.tool("update_retention_draft", "Actualiza retención draft.",
    { id: z.string(), body: anyBody },
    async ({ id, body }) => json(await api(`/retentions/${id}/`, { method: "PATCH", body: JSON.stringify(body) })));
  server.tool("delete_retention_draft", "Elimina retención draft.", { id: z.string() }, del("/retentions"));
  server.tool("finalize_retention", "Finaliza retención.",
    { id: z.string() }, async ({ id }) => json(await api(`/retentions/${id}/finalize/`, { method: "POST" })));

  // ============================================================
  // CANCELLATIONS (cancelaciones fiscales)
  // ============================================================
  server.tool("list_cancellations", "Lista cancelaciones.", {}, list("/cancellations/"));
  server.tool("retrieve_cancellation", "Obtiene cancelación.", { id: z.string() }, get("/cancellations"));
  server.tool("create_cancellation", "Crea cancelación.", { body: anyBody },
    async ({ body }) => json(await api(`/cancellations/`, { method: "POST", body: JSON.stringify(body) })));

  // ============================================================
  // PROVIDERS (procesadores de pago configurados)
  // ============================================================
  server.tool("list_payment_providers", "Lista procesadores de pago configurados.", {}, list("/providers/"));
  server.tool("retrieve_payment_provider", "Obtiene un procesador de pago.",
    { gateway: z.string() },
    async ({ gateway }) => json(await api(`/providers/${gateway}/`)));

  // ============================================================
  // INTENTS (transacciones internas)
  // ============================================================
  server.tool("list_intents", "Lista intents.", {}, list("/intents/"));

  // ============================================================
  // ESCAPE HATCH: llamada genérica a cualquier endpoint
  // ============================================================
  server.tool("piriod_request",
    "Hace una llamada arbitraria a la API de Piriod. Usar SOLO si no hay un tool específico. Path empieza con '/', no incluir base URL.",
    {
      method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).describe("Método HTTP"),
      path:   z.string().describe("Ruta relativa, ej: /invoices/inv_xxx/"),
      query:  z.record(z.string(), z.string()).optional().describe("Query params como objeto plano"),
      body:   z.record(z.string(), z.any()).optional().describe("Body JSON (para POST/PATCH/PUT)"),
    },
    async ({ method, path, query, body }) => {
      const fullPath = `${path}${query ? qs(query) : ""}`;
      const opts = { method };
      if (body && method !== "GET") opts.body = JSON.stringify(body);
      return json(await api(fullPath, opts));
    });

  return server;
};

// ============================================================
// Servidor HTTP
// ============================================================
const PORT = process.env.PORT || 3000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id",
};

const httpServer = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS).end();
    return;
  }

  if (req.url === "/.well-known/oauth-protected-resource") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      resource:                 `${process.env.SERVER_URL || "http://localhost:" + PORT}`,
      bearer_methods_supported: ["header"],
    }));
    return;
  }

  if (req.url === "/health") {
    const { data, error } = await supabase.from("mcp_clients").select("id").limit(1);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      supabase_url: !!process.env.SUPABASE_URL,
      supabase_key: !!process.env.SUPABASE_ANON_KEY,
      db_ok:        !error,
      db_error:     error?.message ?? null,
    }));
    return;
  }

  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  const { pathname } = new URL(req.url, "http://localhost");
  const match = pathname.match(/^\/mcp\/?([^/]*)$/);

  if (!match) {
    res.writeHead(404).end("Not found");
    return;
  }

  const code = match[1] || null;
  const credentials = await resolveCredentials(code);
  if (!credentials) {
    res.writeHead(401).end(JSON.stringify({
      error: code
        ? "Código de acceso inválido o no encontrado."
        : "Se requieren credenciales. Configura PIRIOD_TOKEN y PIRIOD_ORG.",
    }));
    return;
  }

  const server = createMcpServer(credentials.token, credentials.org);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

httpServer.listen(PORT, () => {
  console.log(`Piriod MCP server corriendo en http://localhost:${PORT}/mcp`);
});
