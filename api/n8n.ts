import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'node:crypto';

const OPERATIONS = ['confirm', 'transform', 'notify', 'async-callback'] as const;
type Operation = (typeof OPERATIONS)[number];

const OUTBOUND_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 100_000;

interface OutboundEnvelope {
  schemaVersion: '1.0';
  operation: Operation;
  correlationId: string;
  sentAt: string;
  source: 'vercel-lab';
  payload: unknown;
}

interface NormalizedResponse {
  success: boolean;
  operation: Operation;
  correlationId: string;
  receivedAt: string;
  status: string | null;
  data: unknown;
  error: string | null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'method_not_allowed' });
  }

  if (!req.headers['content-type']?.includes('application/json')) {
    return res.status(415).json({ success: false, error: 'expected_application_json' });
  }

  const rawSize = req.headers['content-length'] ? Number(req.headers['content-length']) : 0;
  if (rawSize > MAX_BODY_BYTES) {
    return res.status(413).json({ success: false, error: 'payload_too_large' });
  }

  const body = req.body as { operation?: string; payload?: unknown } | undefined;

  if (!body || typeof body !== 'object') {
    return res.status(400).json({ success: false, error: 'invalid_json_body' });
  }

  const { operation, payload } = body;

  if (typeof operation !== 'string' || !OPERATIONS.includes(operation as Operation)) {
    return res.status(400).json({
      success: false,
      error: `invalid_operation: expected one of ${OPERATIONS.join(', ')}`,
    });
  }

  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  const outboundSecret = process.env.N8N_OUTBOUND_SECRET;

  if (!webhookUrl || !outboundSecret) {
    return res.status(500).json({ success: false, error: 'server_misconfigured' });
  }

  const correlationId = randomUUID();
  const envelope: OutboundEnvelope = {
    schemaVersion: '1.0',
    operation: operation as Operation,
    correlationId,
    sentAt: new Date().toISOString(),
    source: 'vercel-lab',
    payload: payload ?? null,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);

  try {
    const n8nResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${outboundSecret}`,
      },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });

    const rawText = await n8nResponse.text();
    let parsed: unknown = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = null;
    }

    if (!n8nResponse.ok) {
      const normalized: NormalizedResponse = {
        success: false,
        operation: operation as Operation,
        correlationId,
        receivedAt: new Date().toISOString(),
        status: 'n8n_error',
        data: null,
        error: `n8n respondeu HTTP ${n8nResponse.status}`,
      };
      return res.status(502).json(normalized);
    }

    const parsedObj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    const normalized: NormalizedResponse = {
      success: true,
      operation: operation as Operation,
      correlationId,
      receivedAt: new Date().toISOString(),
      status: (parsedObj.status as string) ?? 'ok',
      data: parsedObj,
      error: null,
    };

    return res.status(200).json(normalized);
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const normalized: NormalizedResponse = {
      success: false,
      operation: operation as Operation,
      correlationId,
      receivedAt: new Date().toISOString(),
      status: isAbort ? 'timeout' : 'network_error',
      data: null,
      error: isAbort ? 'timeout_calling_n8n' : 'failed_to_reach_n8n',
    };
    return res.status(502).json(normalized);
  } finally {
    clearTimeout(timeout);
  }
}
