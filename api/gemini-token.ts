import type { IncomingMessage, ServerResponse } from 'http';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export default async function handler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    console.error('[TOKEN] GEMINI_API_KEY is not set');
    json(res, 500, { error: 'Server configuration error' });
    return;
  }

  let text = '';
  try {
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-live-preview:generateEphemeralToken',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': geminiApiKey,
        },
        body: JSON.stringify({ ttl: '60s' }),
      }
    );

    text = await r.text();

    const data = JSON.parse(text) as { token?: string; ephemeralToken?: string; error?: unknown };
    const ephemeralToken = data.token ?? data.ephemeralToken;

    if (!ephemeralToken) {
      console.error('[TOKEN] No token in Google response (HTTP', r.status, '):', text.slice(0, 300));
      json(res, 500, { error: 'No token in Google response', detail: text.slice(0, 300) });
      return;
    }

    console.log('[TOKEN] Ephemeral token issued');
    json(res, 200, { ephemeralToken });
  } catch (err) {
    console.error('[TOKEN] Failed:', err, '| raw response:', text.slice(0, 300));
    json(res, 500, { error: `Token request failed: ${String(err)}`, raw: text.slice(0, 300) });
  }
}
