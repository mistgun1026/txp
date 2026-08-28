// Minimal, spec-compliant MCP server over Streamable HTTP (stateless mode).
//
// Stateless means every POST is self-contained: no Mcp-Session-Id is issued, so
// hosted clients such as Composio Custom MCP can re-initialise freely and any
// request can be retried without server-side session state.

import { publicTools, toolMap } from './tools.js';
import { XeroError } from './xero.js';

export const SERVER_NAME = 'txp-xero';
export const SERVER_VERSION = '1.0.0';

const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0];

// Guard against a single Xero response overwhelming the client's context.
const MAX_RESULT_CHARS = 800_000;

const INSTRUCTIONS = [
  'Xero accounting connector for The Expert Project.',
  '',
  'Start with xero_list_tenants if you are unsure which organisation you are in, and',
  'xero_list_accounts / xero_list_tax_rates / xero_list_tracking_categories before',
  'creating transactions, so you use codes that exist in the file.',
  '',
  'Filtering uses Xero where-expressions, e.g. where=\'Status=="AUTHORISED"\' and',
  'Date>=DateTime(2026,07,01). Pass summaryOnly=true on large contact and invoice',
  'queries for a much faster, lighter response.',
  '',
  'Write tools take a "records" object (or array of objects) in Xero\'s own field',
  'casing, e.g. { "Type": "ACCREC", "Contact": { "ContactID": "..." }, "LineItems": [...] }.',
  'Creating with the same ID updates the existing record, so re-sending is an upsert.',
  'Anything not covered by a named tool can be reached with xero_api_request.',
].join('\n');

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}

function negotiateProtocol(requested) {
  if (requested && SUPPORTED_PROTOCOLS.includes(requested)) return requested;
  return LATEST_PROTOCOL;
}

function serialise(value) {
  if (value === null || value === undefined) return 'OK (no content returned).';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n\n...[truncated: response was ${text.length} characters. Narrow the request with "where", "page", a date range, or summaryOnly=true.]`;
}

async function handleToolCall(params) {
  const name = params?.name;
  const tool = toolMap.get(name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    const value = await tool.handler(params.arguments || {});
    return { content: [{ type: 'text', text: serialise(value) }] };
  } catch (err) {
    const hint =
      err instanceof XeroError && err.needsReconnect
        ? ' Open https://txp.densetsuph.com and reconnect Xero on the dashboard.'
        : '';
    console.error(`[mcp] tool ${name} failed:`, err.message);
    return {
      content: [{ type: 'text', text: `${err.message}${hint}` }],
      isError: true,
    };
  }
}

/**
 * Handle a single JSON-RPC message.
 * Returns a response object, or null for notifications (nothing to send back).
 */
export async function handleMessage(message) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
    return error(message?.id ?? null, JSONRPC_INVALID_REQUEST, 'Invalid JSON-RPC 2.0 message.');
  }

  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize':
        return result(id, {
          protocolVersion: negotiateProtocol(params?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: 'Xero (TXP)', version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        });

      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/progress':
      case 'notifications/roots/list_changed':
        return null;

      case 'ping':
        return result(id, {});

      case 'tools/list':
        return result(id, { tools: publicTools() });

      case 'tools/call': {
        if (!params?.name) {
          return error(id, JSONRPC_INVALID_PARAMS, 'tools/call requires a "name" parameter.');
        }
        return result(id, await handleToolCall(params));
      }

      // Not advertised, but answered politely so probing clients don't error out.
      case 'resources/list':
        return result(id, { resources: [] });
      case 'resources/templates/list':
        return result(id, { resourceTemplates: [] });
      case 'prompts/list':
        return result(id, { prompts: [] });
      case 'logging/setLevel':
        return result(id, {});

      default:
        if (isNotification) return null;
        return error(id, JSONRPC_METHOD_NOT_FOUND, `Method not supported: ${method}`);
    }
  } catch (err) {
    console.error('[mcp] unhandled error:', err);
    if (isNotification) return null;
    return error(id, JSONRPC_INTERNAL_ERROR, err.message || 'Internal error');
  }
}

/**
 * Express handler for POST /mcp.
 * Replies with application/json, or a single SSE event when the client will
 * only accept text/event-stream.
 */
export async function handlePost(req, res) {
  const body = req.body;

  if (body === undefined || body === null || (typeof body === 'string' && !body.trim())) {
    res.status(400).json(error(null, JSONRPC_PARSE_ERROR, 'Request body must be JSON-RPC 2.0.'));
    return;
  }

  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const message of messages) {
    const response = await handleMessage(message);
    if (response) responses.push(response);
  }

  // Every message was a notification: acknowledge with no content.
  if (responses.length === 0) {
    res.status(202).end();
    return;
  }

  const payload = Array.isArray(body) ? responses : responses[0];
  const accept = String(req.headers.accept || '');
  const sseOnly = accept.includes('text/event-stream') && !accept.includes('application/json');

  if (sseOnly) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    res.end();
    return;
  }

  res.status(200).json(payload);
}
