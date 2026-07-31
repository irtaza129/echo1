import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { FeatureModule } from '../src/lib/tenantConfig.js';

// Module entitlement gate. This is the mechanism that makes the POS and
// Reservations independently sellable: a tenant who bought bookings only gets
// 403 on every /api/pos/* route, and vice versa.
//
// Must run AFTER attachAdapter, which is what puts req.tenantConfig in place.
// If it somehow runs first, we fail closed (500, not "allow") — a missing
// config must never be read as "all modules enabled".
export function requireFeature(feature: FeatureModule): RequestHandler {
  return function (req: Request, res: Response, next: NextFunction): void {
    const config = req.tenantConfig;

    if (!config) {
      console.error(`[FEATURE] requireFeature('${feature}') ran before attachAdapter on ${req.method} ${req.originalUrl}`);
      res.status(500).json({ error: 'Tenant context unavailable' });
      return;
    }

    if (!config.features[feature]) {
      res.status(403).json({
        error:   `The ${feature} module is not enabled for this account`,
        feature,
      });
      return;
    }

    next();
  };
}
