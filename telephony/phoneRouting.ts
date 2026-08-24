import { getRedis, redisKey } from '../src/lib/redis.js';
import { parseTenantConfig } from '../src/lib/tenantConfig.js';

// Which restaurant did this caller dial?
//
// Same shape as findTenantByPhoneNumberId in WhatsAppHandler: a cached lookup,
// falling back to a scan of tenant configs. The dialled number (DID) plays the
// role the WhatsApp phone_number_id plays there.

const ROUTING_TTL = 300;   // 5 min — a DID changes about once a year

/** Strip everything but digits so +92 300 1234567 and 923001234567 match. */
export function normaliseDid(did: string): string {
  return did.replace(/\D/g, '');
}

const routingKey = (did: string) => `phone:routing:${normaliseDid(did)}`;

export async function findTenantByDid(did: string): Promise<string | null> {
  const digits = normaliseDid(did);
  if (!digits) return null;

  try {
    const cached = await getRedis().get<string>(routingKey(digits));
    if (cached) return cached;
  } catch { /* Redis down — fall through to the scan */ }

  const redis = getRedis();
  let tenantIds: string[] = [];
  try {
    tenantIds = (await redis.smembers(redisKey.tenantsIndex)) as string[];
  } catch (err) {
    console.error('[PHONE] could not read the tenant index:', err);
    return null;
  }

  for (const tenantId of tenantIds) {
    const raw = await redis.get<unknown>(redisKey.tenantConfig(tenantId)).catch(() => null);
    if (!raw) continue;

    try {
      const cfg   = parseTenantConfig(raw);
      const phone = cfg.channels?.phone;
      if (!phone?.didNumber) continue;
      if (normaliseDid(phone.didNumber) !== digits) continue;

      if (!phone.enabled) {
        // Matched, but switched off. Say so rather than silently falling
        // through to "no such number" — the two need different fixes.
        console.warn(`[PHONE] DID ${digits} belongs to tenant ${tenantId} but the phone channel is disabled`);
        return null;
      }

      await redis.set(routingKey(digits), tenantId, { ex: ROUTING_TTL }).catch(() => undefined);
      console.log(`[PHONE] DID ${digits} → tenant ${tenantId} (${cfg.restaurantName})`);
      return tenantId;
    } catch (err) {
      console.warn(`[PHONE] skipping tenant ${tenantId} — config failed to parse:`, (err as Error).message);
    }
  }

  console.warn(`[PHONE] no tenant claims DID ${digits}`);
  return null;
}
