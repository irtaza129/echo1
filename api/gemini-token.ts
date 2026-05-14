import type { IncomingMessage, ServerResponse } from 'http';
import https from 'https';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export default function handler(_req: IncomingMessage, res: ServerResponse): void {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    console.error('[TOKEN] GEMINI_API_KEY is not set');
    json(res, 500, { error: 'Server configuration error' });
    return;
  }

  const payload = JSON.stringify({ ttl: '60s' });
  const options: https.RequestOptions = {
    hostname: 'generativelanguage.googleapis.com',
    path: '/v1beta/models/gemini-3.1-flash-live-preview:generateEphemeralToken',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'x-goog-api-key': geminiApiKey,
    },
  };

  const req = https.request(options, (googleRes) => {
    let raw = '';
    googleRes.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
    googleRes.on('end', () => {
      try {
        const data = JSON.parse(raw) as { token?: string; ephemeralToken?: string; error?: unknown };
        const ephemeralToken = data.token ?? data.ephemeralToken;
        if (!ephemeralToken) {
          console.error('[TOKEN] No token field in Google response:', raw.slice(0, 200));
          json(res, 500, { error: 'No token in Google response' });
          return;
        }
        console.log('[TOKEN] Ephemeral token issued');
        json(res, 200, { ephemeralToken });
      } catch (e) {
        console.error('[TOKEN] Failed to parse Google response:', e);
        json(res, 500, { error: 'Failed to parse token response' });
      }
    });
  });

  req.on('error', (e) => {
    console.error('[TOKEN] HTTPS request to Google failed:', e.message);
    json(res, 500, { error: `Token request failed: ${e.message}` });
  });

  req.setTimeout(10000, () => {
    req.destroy();
    json(res, 504, { error: 'Token request timed out' });
  });

  req.write(payload);
  req.end();
}
