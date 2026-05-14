import type { IncomingMessage, ServerResponse } from 'http';
import { GoogleGenAI } from '@google/genai';

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
    const ai = new GoogleGenAI({ apiKey: geminiApiKey, httpOptions: { apiVersion: 'v1alpha' } });
    const token = await ai.authTokens.create({});
    if (!token.name) throw new Error('SDK returned no token name');
    console.log('[TOKEN] Ephemeral token issued');
    json(res, 200, { ephemeralToken: token.name });
  } catch (err: unknown) {
    console.error('[TOKEN] Failed:', err);
    json(res, 500, { error: String(err) });
  }
}
