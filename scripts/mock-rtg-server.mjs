#!/usr/bin/env node
// Tiny local stand-in for the Reva RTG + ingestion API, for exercising the
// plugin end-to-end without hitting the real endpoints. Evaluation calls
// honor MOCK_HTTP_STATUS (default 200) so you can drive the plugin's
// 200/403/401/5xx matrix. Ingestion calls are just logged and acknowledged.
// Every request is logged so you can confirm the exact shape the plugin
// sent — headers are redacted, not omitted, so a real token can be used
// here without ever being written to this log or console.
import http from 'node:http';

const PORT = process.env.MOCK_RTG_PORT || 8787;
const DECISION = process.env.MOCK_DECISION || 'allow'; // allow | deny (200 remains authoritative allow to the plugin)
const HTTP_STATUS = Number(process.env.MOCK_HTTP_STATUS || 200);
const ERROR_TYPE = process.env.MOCK_ERROR_TYPE; // USER_DISABLED | USER_NOT_FOUND | engine/service type

const ENTITY_TYPES = [
  { id: 'mock-user-type-id', name: 'User', schemaName: 'CodingAgent' },
  { id: 'mock-agent-type-id', name: 'Agent', schemaName: 'CodingAgent' },
  { id: 'mock-mcpserver-type-id', name: 'MCPServer', schemaName: 'CodingAgent' },
];

function redactedHeaders(req) {
  return {
    policyStoreId: req.headers.policystoreid,
    'x-api-token': req.headers['x-api-token'] ? '<redacted>' : undefined,
    authorization: req.headers.authorization ? '<redacted>' : undefined,
    traceparent: req.headers.traceparent,
  };
}

function evaluationReply(res) {
  if (HTTP_STATUS === 401) {
    const errorType = ERROR_TYPE || 'USER_NOT_FOUND';
    console.log('responding with HTTP 401 error_type:', errorType);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error_type: errorType }));
    return;
  }
  if (HTTP_STATUS === 403) {
    console.log('responding with HTTP 403');
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ context: { reason: 'Denied by mock governance policy' } }));
    return;
  }
  if (HTTP_STATUS >= 500 && HTTP_STATUS < 600) {
    const errorType = ERROR_TYPE || 'RTG_SERVER_ERROR';
    console.log(`responding with HTTP ${HTTP_STATUS} error_type:`, errorType);
    res.writeHead(HTTP_STATUS, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error_type: errorType }));
    return;
  }
  if (DECISION === 'conditional_allow') {
    console.log('responding with HTTP 200 decision: conditional_allow (guardrails)');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        decision: true,
        threadId: `mock-${Date.now()}`,
        guardrails: {
          status: 'complete',
          outcome: 'conditional_allow',
          health: 'ok',
          reason: 'Synchronous enforce guardrails conditionally allowed the request.',
        },
      }),
    );
    return;
  }
  console.log('responding with HTTP 200 decision:', DECISION);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ decision: DECISION === 'allow', threadId: `mock-${Date.now()}` }));
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/ingestion/v2/policy-store/entity-types') {
      console.log(`\n--- Reva mock ingestion API: GET ${url.pathname} ---`);
      console.log('headers:', JSON.stringify(redactedHeaders(req)));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ENTITY_TYPES));
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }

    if (url.pathname === '/ingestion/v2/entity' && req.method === 'POST') {
      console.log(`\n--- Reva mock ingestion API: POST /ingestion/v2/entity?${url.searchParams} ---`);
      console.log('headers:', JSON.stringify(redactedHeaders(req)));
      console.log('body:', JSON.stringify(parsed, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'created' }));
      return;
    }

    if (/^\/ingestion\/v2\/entity\/[^/?]+$/.test(url.pathname) && req.method === 'PATCH') {
      console.log(`\n--- Reva mock ingestion API: PATCH ${url.pathname}?${url.searchParams} ---`);
      console.log('headers:', JSON.stringify(redactedHeaders(req)));
      console.log('body:', JSON.stringify(parsed, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'updated' }));
      return;
    }

    // Real Reva backend route — kept as /pdp/v2/... regardless of internal
    // RTG naming, since this has to match what the client actually requests
    // (config.ts's RTG_PATH is deliberately not renamed either — see there).
    if (url.pathname === '/pdp/v2/ai/evaluation' && req.method === 'POST') {
      console.log('\n--- Reva mock RTG received a direct-AI request ---');
      console.log('headers:', JSON.stringify(redactedHeaders(req)));
      console.log('body:', JSON.stringify(parsed, null, 2));
      evaluationReply(res);
      return;
    }

    if (url.pathname === '/pdp/access/v1/principal/exists' && req.method === 'POST') {
      console.log('\n--- Reva mock RTG: POST /pdp/access/v1/principal/exists ---');
      console.log('headers:', JSON.stringify(redactedHeaders(req)));
      console.log('body:', JSON.stringify(parsed, null, 2));
      if (HTTP_STATUS === 401) {
        const errorType = ERROR_TYPE || 'USER_NOT_FOUND';
        console.log('responding with HTTP 401 error_type:', errorType);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error_type: errorType }));
        return;
      }
      if (HTTP_STATUS === 403) {
        console.log('responding with HTTP 403');
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ context: { reason: 'Denied by mock governance policy' } }));
        return;
      }
      if (HTTP_STATUS === 404) {
        console.log('responding with HTTP 404 principal not found');
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error_type: 'USER_NOT_FOUND' }));
        return;
      }
      if (HTTP_STATUS >= 500 && HTTP_STATUS < 600) {
        const errorType = ERROR_TYPE || 'RTG_SERVER_ERROR';
        console.log(`responding with HTTP ${HTTP_STATUS} error_type:`, errorType);
        res.writeHead(HTTP_STATUS, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error_type: errorType }));
        return;
      }
      const entityType = parsed?.entityType || 'User';
      const entityId = parsed?.entityId || 'unknown-user';
      console.log('responding with HTTP 200 principal active');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          uid: { type: entityType, id: entityId },
          type: entityType,
          attrs: { name: 'Mock User', status: 'active' },
          parents: [],
        }),
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error_type: 'NOT_FOUND' }));
  });
});

server.listen(PORT, () => {
  console.log(
    `Reva mock RTG + ingestion API listening on http://localhost:${PORT} (HTTP ${HTTP_STATUS}, decision=${DECISION}${
      ERROR_TYPE ? `, error_type=${ERROR_TYPE}` : ''
    })`,
  );
  console.log('Point REVA_HOST at this address to test the plugin end-to-end.');
});
