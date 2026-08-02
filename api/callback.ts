import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const MAX_BODY_BYTES = 100_000;
const TABLE = 'webhook_events';

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
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

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(500).json({ success: false, error: 'persistence_not_configured' });
  }

  const { data: existing, error: lookupError } = await supabase
    .from(TABLE)
    .select('event_id')
    .eq('event_id', eventId)
    .maybeSingle();

  if (lookupError) {
    return res.status(500).json({ success: false, error: 'lookup_failed' });
  }

  if (existing) {
    return res.status(200).json({ success: true, received: true, duplicate: true, eventId });
  }

  const { error: insertError } = await supabase.from(TABLE).insert({
    event_id: eventId,
    correlation_id: correlationId,
    job_id: jobId ?? null,
    operation: eventType ?? null,
    status: status ?? null,
    payload: data ?? null,
    received_at: new Date().toISOString(),
    occurred_at: occurredAt ?? null,
  });

  if (insertError) {
    return res.status(500).json({ success: false, error: 'insert_failed' });
  }

  return res.status(200).json({ success: true, received: true, duplicate: false, eventId });
}

async function handleGet(req: VercelRequest, res: VercelResponse) {
  const correlationId = req.query.correlationId;
  if (typeof correlationId !== 'string' || !correlationId) {
    return res.status(400).json({ success: false, error: 'missing_correlationId' });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(500).json({ success: false, error: 'persistence_not_configured' });
  }

  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('correlation_id', correlationId)
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ success: false, error: 'query_failed' });
  }

  if (!data) {
    return res.status(200).json({ success: true, found: false });
  }

  return res.status(200).json({
    success: true,
    found: true,
    event: {
      eventId: data.event_id,
      correlationId: data.correlation_id,
      jobId: data.job_id,
      operation: data.operation,
      status: data.status,
      data: data.payload,
      receivedAt: data.received_at,
      occurredAt: data.occurred_at,
    },
  });
}
