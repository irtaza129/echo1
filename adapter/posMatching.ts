import type { TenantConfig } from '../src/lib/tenantConfig.js';
import type { PosMenu, PosDish, PosOptionGroup } from '../src/lib/posRepo.js';

// Voice/text → menu-item matching and menu-markdown rendering.
//
// `normStr` and `fuzzyMatchItem` were lifted verbatim out of server.ts, where
// they backed the inline "local menu" branch. They are moved rather than
// rewritten: the scoring thresholds have been tuned against real Urdu/Roman-Urdu
// kiosk traffic, and changing them silently changes which dish a customer gets.
//
// The only behavioural change is the item type — it now matches PosDish
// (Postgres-backed, with modifiers) instead of the Redis MenuItemRow shape.

// Normalise for fuzzy matching: lowercase, strip punctuation, collapse spaces.
export function normStr(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Priority: exact → substring (either direction) → word-overlap ≥ 35 %.
export function fuzzyMatchItem<T extends { name: string; available?: boolean }>(
  query: string,
  items: T[],
): T | null {
  const q     = normStr(query);
  const avail = items.filter(i => i.available !== false && i.name.trim() !== '');

  // 1. Exact
  let m = avail.find(i => normStr(i.name) === q);
  if (m) return m;

  // 2. Substring either direction
  m = avail.find(i => { const n = normStr(i.name); return n.includes(q) || q.includes(n); });
  if (m) return m;

  // 3. Word-overlap score
  const qw = q.split(' ').filter(w => w.length > 1);
  let best: T | null = null;
  let top = 0;
  for (const item of avail) {
    const iw    = normStr(item.name).split(' ').filter(w => w.length > 1);
    const hits  = qw.filter(w => iw.some(iw2 => iw2 === w || iw2.startsWith(w) || w.startsWith(iw2))).length;
    const score = hits / Math.max(qw.length, iw.length, 1);
    if (score > top) { top = score; best = item; }
  }
  return top >= 0.35 ? best : null;
}

// Match spoken modifier words ("leg", "boxed") against a dish's option groups.
//
// Returns the resolved choices plus any REQUIRED group the customer has not yet
// answered. That second half is what the old local path could not do at all —
// it had no modifier model, so `resolve-item` could never return
// `requires_input` and the kiosk would happily add a pizza with no size.
export interface ModifierMatch {
  choices:      { groupId: number; groupName: string; choiceId: number; choiceName: string; price: number }[];
  missingGroup: PosOptionGroup | null;
}

export function matchModifiers(dish: PosDish, spoken: string[]): ModifierMatch {
  const chosen: ModifierMatch['choices'] = [];
  const used = new Set<string>();

  for (const group of dish.optionGroups) {
    for (const word of spoken) {
      if (used.has(word)) continue;
      const hit = fuzzyMatchItem(word, group.choices.map(c => ({ ...c, available: true })));
      if (hit) {
        chosen.push({
          groupId:    group.id,
          groupName:  group.name,
          choiceId:   hit.id,
          choiceName: hit.name,
          price:      hit.price,
        });
        used.add(word);
        // Single-select groups take the first match only; asking again would
        // let "leg and chest" silently overwrite itself down to one choice.
        if (!group.multiselect) break;
      }
    }
  }

  // The first required group with nothing selected is what we ask about. One
  // question at a time — a voice agent listing four groups at once is unusable.
  const missingGroup = dish.optionGroups.find(g =>
    g.required && !chosen.some(c => c.groupId === g.id)) ?? null;

  return { choices: chosen, missingGroup };
}

// The markdown block injected into Gemini's system prompt.
//
// Moved from server.ts's buildMenuMarkdown, extended to list modifier groups —
// without them the model cannot know that "Pulao" needs a piece choice, and
// will keep guessing instead of asking.
export function buildMenuMarkdown(menu: PosMenu, config: TenantConfig): string {
  const cur = config.businessRules.currencySymbol;
  let   md  = `# ${config.restaurantName} Menu\n\n`;

  const cats = [...menu.categories].sort((a, b) => b.priority - a.priority);
  for (const cat of cats) {
    const dishes = menu.dishes.filter(d => d.categoryId === cat.id && d.available);
    if (dishes.length === 0) continue;

    md += `## ${cat.name}\n`;
    for (const d of dishes) {
      md += `- **${d.name}** — ${cur} ${d.price}`;
      if (d.description) md += `: ${d.description}`;
      md += '\n';

      for (const g of d.optionGroups) {
        const choices = g.choices.map(c =>
          c.price ? `${c.name} (+${cur} ${c.price})` : c.name).join(', ');
        if (!choices) continue;
        md += `    - ${g.name}${g.required ? ' (required)' : ''}: ${choices}\n`;
      }
    }
    md += '\n';
  }

  return md.trim() || `# ${config.restaurantName} Menu\n\n(No items added yet)`;
}
