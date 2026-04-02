# Piriod MCP Server

Servidor [MCP (Model Context Protocol)](https://modelcontextprotocol.io) que conecta Claude con la API REST de [Piriod.com](https://piriod.com) para gestionar facturación y pagos directamente desde conversaciones con Claude.

## Qué hace

Expone 4 tools que Claude puede usar para:

- Listar y filtrar facturas
- Crear y finalizar facturas con líneas de detalle
- Buscar clientes por nombre o email
- Listar pagos por estado

## Requisitos

- Node.js 18 o superior
- Una cuenta en [Piriod.com](https://piriod.com) con acceso a la API
- Claude Desktop

## Instalación

```bash
git clone https://github.com/cevidallara/piriod-mcp.git
cd piriod-mcp
npm install
```

## Variables de entorno

| Variable        | Descripción                              |
|-----------------|------------------------------------------|
| `PIRIOD_TOKEN`  | Token de API de Piriod                   |
| `PIRIOD_ORG`    | ID de la organización (empieza con `acc_`) |

Puedes obtenerlos desde el panel de configuración de tu cuenta en Piriod.com.

## Conectar a Claude Desktop

Edita el archivo de configuración de Claude Desktop:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Agrega la siguiente configuración:

```json
{
  "mcpServers": {
    "piriod": {
      "command": "node",
      "args": ["/ruta/absoluta/a/piriod-mcp/index.js"],
      "env": {
        "PIRIOD_TOKEN": "tu_token_aqui",
        "PIRIOD_ORG": "acc_xxxxxxxxxx"
      }
    }
  }
}
```

Reinicia Claude Desktop. El servidor aparecerá disponible en el menú de herramientas.

## Tools disponibles

### `list_invoices`

Lista las facturas con filtros opcionales.

| Parámetro  | Tipo   | Descripción                           |
|------------|--------|---------------------------------------|
| `status`   | string | `draft`, `finalized` o `paid`         |
| `customer` | string | ID del cliente, ej: `cus_xxx`         |

**Ejemplo de uso en Claude:**
> "Muéstrame todas las facturas finalizadas del cliente cus_abc123"

---

### `create_invoice`

Crea una factura en estado draft y la finaliza automáticamente.

| Parámetro  | Tipo   | Descripción                                  |
|------------|--------|----------------------------------------------|
| `customer` | string | ID del cliente, ej: `cus_xxx`                |
| `document` | string | ID del tipo de documento, ej: `US1`          |
| `date`     | string | Fecha de emisión en formato `YYYY-MM-DD`     |
| `due_date` | string | Fecha de vencimiento en formato `YYYY-MM-DD` |
| `lines`    | array  | Líneas de la factura (ver estructura abajo)  |

Estructura de cada línea:

```json
{
  "name": "Servicio de consultoría",
  "quantity": 2,
  "amount": 500.00
}
```

**Ejemplo de uso en Claude:**
> "Crea una factura para el cliente cus_abc123 por 3 horas de soporte a $100 cada una, con vencimiento el 30 de abril"

---

### `find_customer`

Busca clientes por nombre o email.

| Parámetro | Tipo   | Descripción               |
|-----------|--------|---------------------------|
| `search`  | string | Nombre o email a buscar   |

**Ejemplo de uso en Claude:**
> "Busca el cliente con email juan@empresa.com"

---

### `list_payments`

Lista los pagos con filtro opcional por estado.

| Parámetro | Tipo   | Descripción                                                             |
|-----------|--------|-------------------------------------------------------------------------|
| `status`  | string | `requires_payment_method`, `processing` o `succeeded`                  |

**Ejemplo de uso en Claude:**
> "¿Cuáles pagos están en estado processing?"

## Stack

- [Node.js](https://nodejs.org) con ES Modules
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- [zod](https://zod.dev) para validación de parámetros

## Licencia

ISC
