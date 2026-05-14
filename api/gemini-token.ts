import type { IncomingMessage, ServerResponse } from 'http';
import axios from 'axios';

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

  try {
    const r = await axios.post<{ token?: string; ephemeralToken?: string }>(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-live-preview:generateEphemeralToken',
      { ttl: '60s' },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': geminiApiKey,
        },
        timeout: 10000,
      }
    );

    const ephemeralToken = r.data.token ?? r.data.ephemeralToken;
    if (!ephemeralToken) {
      console.error('[TOKEN] No token field in Google response (HTTP', r.status, '):', JSON.stringify(r.data).slice(0, 300));
      json(res, 500, { error: 'No token in Google response', detail: JSON.stringify(r.data).slice(0, 300) });
      return;
    }

    console.log('[TOKEN] Ephemeral token issued');
    json(res, 200, { ephemeralToken });
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const status  = err.response?.status ?? 500;
      const detail  = JSON.stringify(err.response?.data ?? err.message).slice(0, 300);
      console.error('[TOKEN] Google API error:', status, detail);
      json(res, status >= 400 && status < 600 ? status : 500, { error: `Google API error (${status})`, detail });
    } else {
      console.error('[TOKEN] Unexpected error:', err);
      json(res, 500, { error: String(err) });
    }
  }
}
