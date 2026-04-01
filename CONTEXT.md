# Proyecto: Piriod MCP Server

## Qué es esto
Servidor MCP para conectar Claude con la API REST de Piriod.com (facturación/pagos).

## API de Piriod
- Base URL: https://api.piriod.com
- Auth: header `Authorization: Token {API_KEY}` + header `x-simple-workspace: {ORG_ID}`
- ORG_ID empieza con `acc_`
- Facturas se crean como draft y luego se finalizan con POST /invoices/{id}/finalize/

## Tools implementados
1. list_invoices — GET /invoices/ con filtros status y customer
2. create_invoice — POST /invoices/ + POST /invoices/{id}/finalize/
3. find_customer — GET /customers/?search=
4. list_payments — GET /payments/ con filtro status

## Stack
- Node.js con ES modules (type: module en package.json)
- @modelcontextprotocol/sdk para el servidor MCP
- zod para validar parámetros
- Variables de entorno: PIRIOD_TOKEN y PIRIOD_ORG

## Siguiente paso
El index.js base ya está listo. Falta probarlo y agregar más tools.