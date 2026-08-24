import type { Request, Response, NextFunction } from 'express';
import { extractJwt } from '../src/lib/jwt.js';

// Gate for /api/guest/*. The mirror image of requireAuth: that one refuses a
// guest token, this one accepts nothing else.
//
// Why the pairing matters
// -----------------------
// A guest token is a correctly signed token for a real tenant. Any middleware
// that asks only "is this valid?" will let a diner through. So the split is
// made on ROLE, explicitly, in both directions, and both directions are tested.
//
// Everything downstream reads the table and session from the TOKEN, never from
// the request body or a query parameter. A guest who edits a body to name
// another table changes nothing, because nothing here reads it.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      guest?: {
        tenantId:      string;
        slug:          string;
        tableId:       string;
        dineSessionId: string;
      };
    }
  }
}

export function requireGuest(req: Request, res: Response, next: NextFunction): void {
  const payload = extractJwt(req.headers['authorization']);

  if (!payload) {
    res.status(401).json({ error: 'Scan the QR code at your table to start ordering' });
    return;
  }

  if (payload.role !== 'guest') {
    // A staff token here is not an attack, it is a bug — but it must not be
    // allowed to act as a guest either, because these routes attribute orders
    // to a table and a dine session that a staff token does not have.
    res.status(403).json({ error: 'This endpoint is for table sessions only' });
    return;
  }

  if (!payload.tableId || !payload.dineSessionId) {
    // A guest token that predates a schema change, or was hand-made. Refuse
    // rather than defaulting to some table.
    res.status(401).json({ error: 'Your table session is invalid — please scan again' });
    return;
  }

  req.guest = {
    tenantId:      payload.tenantId,
    slug:          payload.slug,
    tableId:       payload.tableId,
    dineSessionId: payload.dineSessionId,
  };

  next();
}
