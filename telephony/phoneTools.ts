import type { FunctionDeclaration } from '@google/genai';
import { allTools } from '../src/lib/geminiTools.js';

// Tools the phone agent has that the other channels do not.
//
// Kept separate rather than added to `allTools` on purpose: the kiosk must not
// gain a transfer_to_human tool it cannot honour, and a diner at a table has no
// use for capture_address. A tool the model can see is a tool it will eventually
// call, so each channel gets exactly the set it can actually service.

export const set_order_type: FunctionDeclaration = {
  name: 'set_order_type',
  description:
    'Record whether this call is for delivery, pick-up or take-away. ' +
    'Call this as soon as the caller answers the opening question, BEFORE taking any items. ' +
    'If they are asking about dining in instead, do not call this — answer their question.',
  parameters: {
    type: 'OBJECT',
    properties: {
      order_type: {
        type: 'STRING',
        description: 'One of: delivery, pickup, takeaway.',
      },
    },
    required: ['order_type'],
  },
} as unknown as FunctionDeclaration;

export const capture_address: FunctionDeclaration = {
  name: 'capture_address',
  description:
    'Record the delivery address. Only for delivery orders. ' +
    'Ask for the full address including a nearby landmark, read it back to the caller ' +
    'to confirm, and only then call this.',
  parameters: {
    type: 'OBJECT',
    properties: {
      address:  { type: 'STRING', description: 'The full address as the caller gave it.' },
      landmark: { type: 'STRING', description: 'A nearby landmark, if they mentioned one.' },
    },
    required: ['address'],
  },
} as unknown as FunctionDeclaration;

export const check_hours: FunctionDeclaration = {
  name: 'check_hours',
  description:
    'Look up the opening hours and location. Use this for questions about visiting, ' +
    'timings, or whether the restaurant is open — never guess these.',
  parameters: { type: 'OBJECT', properties: {} },
} as unknown as FunctionDeclaration;

export const transfer_to_human: FunctionDeclaration = {
  name: 'transfer_to_human',
  description:
    'Hand the call to a member of staff. Use when the caller asks for a person, is upset, ' +
    'or wants something outside ordering — a complaint, a large booking, a refund. ' +
    'Do not argue with someone who has asked for a human.',
  parameters: {
    type: 'OBJECT',
    properties: {
      reason: { type: 'STRING', description: 'Briefly, why the call is being transferred.' },
    },
  },
} as unknown as FunctionDeclaration;

export const end_call: FunctionDeclaration = {
  name: 'end_call',
  description:
    'Hang up. Call this ONLY after saying goodbye, once the caller has confirmed ' +
    'they need nothing else. Never hang up on an unfinished conversation.',
  parameters: { type: 'OBJECT', properties: {} },
} as unknown as FunctionDeclaration;

/**
 * The full tool set for a phone call.
 *
 * `session_id` is stripped from the shared tools for the same reason it is on
 * WhatsApp and at the table: the session is the call, the server knows which
 * call this is, and a model that can name a session id is a model that can name
 * the wrong one.
 */
export function phoneTools(opts: { canTransfer: boolean }): FunctionDeclaration[] {
  const stripped = allTools.map(stripSessionId);

  const extra = [set_order_type, capture_address, check_hours, end_call];
  // Only offered when there is somewhere to transfer TO. Advertising a tool
  // that always fails teaches the model to keep trying it.
  if (opts.canTransfer) extra.push(transfer_to_human);

  return [...stripped, ...extra];
}

function stripSessionId(d: FunctionDeclaration): FunctionDeclaration {
  const props = { ...(d.parameters?.properties ?? {}) } as Record<string, unknown>;
  delete props.session_id;
  return {
    ...d,
    parameters: {
      ...d.parameters,
      properties: props,
      required: (d.parameters?.required ?? []).filter(r => r !== 'session_id'),
    },
  } as FunctionDeclaration;
}
