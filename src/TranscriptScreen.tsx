import { useEffect, useRef } from 'react';
import type { TranscriptTurn, ToolCallRecord } from './lib/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function toolSummary(tc: ToolCallRecord): string {
  const args = tc.args;
  switch (tc.name) {
    case 'add_item':    return `add_item → "${args.dish_query ?? '?'}"${args.quantity && args.quantity !== 1 ? ` ×${args.quantity}` : ''}`;
    case 'remove_item': return `remove_item → ${args.cart_item_id ?? '?'}`;
    case 'clear_cart':  return 'clear_cart';
    case 'confirm_order': return `confirm_order (${args.order_type ?? 'dine_in'})`;
    default:            return tc.name;
  }
}

function toolSuccess(tc: ToolCallRecord): boolean {
  return !(tc.response as Record<string, unknown>)?.error;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TurnCard({ turn }: { turn: TranscriptTurn }) {
  return (
    <div className="bg-white/60 border border-white/70 rounded-2xl p-4 flex flex-col gap-3">

      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest font-bold text-[#5A5A40] opacity-50">
          Turn {turn.index + 1}
        </span>
        <span className="text-[10px] font-mono text-[#5A5A40] opacity-40">
          {formatTime(turn.timestamp)}
        </span>
      </div>

      {/* Customer speech */}
      {turn.customerText && (
        <div className="flex gap-2 items-start">
          <span className="text-base leading-none mt-0.5">🧑</span>
          <p className="text-sm text-[#3D3D33] bg-[#5A5A40]/8 rounded-xl px-3 py-2 flex-1 leading-relaxed">
            {turn.customerText}
          </p>
        </div>
      )}

      {/* Tool calls */}
      {turn.toolCalls.map((tc, i) => (
        <div key={i} className="flex gap-2 items-center">
          <span className="text-base leading-none">🔧</span>
          <span className="text-xs font-mono text-[#5A5A40] bg-[#A39171]/10 rounded-lg px-2 py-1 flex-1 truncate">
            {toolSummary(tc)}
          </span>
          <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded ${toolSuccess(tc) ? 'text-green-700 bg-green-50' : 'text-red-600 bg-red-50'}`}>
            {toolSuccess(tc) ? '✓' : '✗'}
          </span>
        </div>
      ))}

      {/* AI speech */}
      {turn.aiText && (
        <div className="flex gap-2 items-start">
          <span className="text-base leading-none mt-0.5">🤖</span>
          <p className="text-sm text-[#3D3D33] bg-[#A39171]/10 rounded-xl px-3 py-2 flex-1 leading-relaxed">
            {turn.aiText}
          </p>
        </div>
      )}

      {/* Cost badge */}
      {(turn.promptTokens > 0 || turn.responseTokens > 0) && (
        <div className="flex justify-end">
          <span className="text-[10px] font-mono text-[#5A5A40] opacity-40">
            in: {turn.promptTokens} · out: {turn.responseTokens} · ${turn.costUsd.toFixed(5)}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function TranscriptScreen({
  turns,
  onBack,
}: {
  turns: TranscriptTurn[];
  onBack: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new turns arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns.length]);

  const totalCost = turns.reduce((s, t) => s + t.costUsd, 0);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#F8F7F2] select-none">

      {/* ── Header ── */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[#5A5A40]/10 shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-2 glass-panel rounded-xl text-[#5A5A40] hover:bg-white/80 transition-colors cursor-pointer"
            aria-label="Back"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 5l-7 7 7 7"/>
            </svg>
          </button>
          <div>
            <h1 className="text-base font-serif font-bold text-[#5A5A40] leading-tight">
              CONVERSATION TRANSCRIPT
            </h1>
            <p className="text-[10px] uppercase tracking-widest opacity-40 mt-0.5">
              Current session · {turns.length} turn{turns.length !== 1 ? 's' : ''}
            </p>
          </div>
        </div>

        {turns.length > 0 && (
          <div className="text-right">
            <p className="text-xs font-mono font-semibold text-[#5A5A40]">${totalCost.toFixed(4)}</p>
            <p className="text-[10px] uppercase tracking-widest opacity-40">est. cost</p>
          </div>
        )}
      </div>

      {/* ── Turn list ── */}
      <div className="flex-1 overflow-y-auto min-h-0 px-4 py-5 flex flex-col gap-4">
        {turns.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 opacity-35">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="2" width="6" height="11" rx="3"/>
              <path d="M5 10a7 7 0 0 0 14 0"/>
              <line x1="12" y1="19" x2="12" y2="22"/>
              <line x1="8" y1="22" x2="16" y2="22"/>
            </svg>
            <p className="text-sm text-center leading-relaxed">
              No conversation yet.<br />
              Press the mic on the kiosk to start.
            </p>
          </div>
        ) : (
          <>
            {turns.map(turn => (
              <TurnCard key={turn.index} turn={turn} />
            ))}
            <div ref={bottomRef} />
          </>
        )}
      </div>
    </div>
  );
}
