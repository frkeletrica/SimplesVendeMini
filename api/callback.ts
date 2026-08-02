import type { VercelRequest, VercelResponse } from '@vercel/node';

const MAX_BODY_BYTES = 100_000;
const EVENT_TTL_MS = 10 * 60 * 1000;

interface StoredEvent {
  eventId: string;
  correlationId: string;
  jobId: string | null;
  operation: string | null;
  status: string | null;
  data: unknown;
  receivedAt: string;
  occurredAt: string | null;
}

/**
 * Armazenamento em memoria, valido apenas enquanto a instancia da Function
 * estiver "quente". Nao ha banco de dados neste laboratorio: o navegador
 * persiste seu proprio historico via localStorage (ver index.html); aqui
 * so precisamos segurar o evento pelos poucos segundos entre o POST do n8n
 * e o proximo GET de polling do frontend.
 */
const eventsByCorrelationId = new Map<string, StoredEvent>();
const seenEventIds = new Set<string>();

function sweepExpired() {
  const cutoff = Date.now() - EVENT_TTL_MS;
  for (const [correlationId, event] of eventsByCorrelationId) {
    if (new Date(event.receivedAt).getTime() < cutoff) {
      eventsByCorrelationId.delete(correlationId);
    }
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'POST') return handlePost(req, res);
  if (req.method === 'GET') return handleGet(req, res);

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ success: false, error: 'method_not_allowed' });
}

async function handlePost(req: VercelRequest, res: VercelResponse) {
  const expectedSecret = process.env.VERCEL_CALLBACK_SECRET;
  if (!expectedSecret) {
    return res.status(500).json({ success: false, error: 'server_misconfigured' });
  }

  const authHeader = req.headers.authorization ?? '';
  const providedSecret = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (providedSecret !== expectedSecret) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }

  if (!req.headers['content-type']?.includes('application/json')) {
    return res.status(415).json({ success: false, error: 'expected_application_json' });
  }

  const rawSize = req.headers['content-length'] ? Number(req.headers['content-length']) : 0;
  if (rawSize > MAX_BODY_BYTES) {
    return res.status(413).json({ success: false, error: 'payload_too_large' });
  }

  const body = req.body as {
    eventId?: string;
    eventType?: string;
    correlationId?: string;
    jobId?: string;
    status?: string;
    occurredAt?: string;
    data?: unknown;
  } | undefined;

  if (!body || typeof body !== 'object') {
    return res.status(400).json({ success: false, error: 'invalid_json_body' });
  }

  const { eventId, eventType, correlationId, jobId, status, occurredAt, data } = body;

  if (!eventId || !correlationId) {
    return res.status(400).json({ success: false, error: 'missing_eventId_or_correlationId' });
  }

  sweepExpired();

  if (seenEventIds.has(eventId)) {
    return res.status(200).json({ success: true, received: true, duplicate: true, eventId });
  }
  seenEventIds.add(eventId);

  eventsByCorrelationId.set(correlationId, {
    eventId,
    correlationId,
    jobId: jobId ?? null,
    operation: eventType ?? null,
    status: status ?? null,
    data: data ?? null,
    receivedAt: new Date().toISOString(),
    occurredAt: occurredAt ?? null,
  });

  return res.status(200).json({ success: true, received: true, duplicate: false, eventId });
}

async function handleGet(req: VercelRequest, res: VercelResponse) {
  const correlationId = req.query.correlationId;
  if (typeof correlationId !== 'string' || !correlationId) {
    return res.status(400).json({ success: false, error: 'missing_correlationId' });
  }

  sweepExpired();

  const event = eventsByCorrelationId.get(correlationId);
  if (!event) {
    return res.status(200).json({ success: true, found: false });
  }

  return res.status(200).json({ success: true, found: true, event });
}
