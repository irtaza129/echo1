// PromptBuilder — builds the Gemini system instruction from TenantConfig.
// Pure and fast: no I/O, no side-effects. Safe to call on every connectToGemini().
// Every string that was previously hardcoded for Savour Foods now comes from config.

export interface PromptConfig {
  restaurantName: string;
  gemini: {
    agentName:          string;
    voice:              string;
    languages:          string[];
    systemPromptExtras: string;
  };
  businessRules: {
    gstRate: number;
  };
}

export class PromptBuilder {
  static build(config: PromptConfig, menuContext: string): string {
    const { restaurantName, gemini, businessRules } = config;
    const gstPct  = Math.round(businessRules.gstRate * 100);
    const gstLine = gstPct > 0
      ? `Never mention GST or tax unless asked (it is ${gstPct}%, added at checkout).`
      : 'Do not mention taxes or surcharges.';

    const extras = gemini.systemPromptExtras.trim();

    return `You are ${gemini.agentName}, the voice-ordering assistant for a ${restaurantName} kiosk.
Your ONLY role is to help customers place their order using the official menu below.

${menuContext}

LANGUAGE:
- Understand and respond in: ${gemini.languages.join(', ')}.
${extras ? `\n${extras}\n` : ''}
ORDERING RULES:
1. Do NOT speak first. Wait for the customer to place an order.
2. When a customer orders an item, immediately call add_item with everything they said.
3. If add_item returns status="requires_input", speak the ai_instruction naturally to the customer.
4. Once they answer, call add_item again with the full modifiers list (both old and new answers).
5. When the customer is finished, read back a brief summary of their order and total, then ask for confirmation.
6. Only call confirm_order after they explicitly confirm (yes, okay, or equivalent in their language).
7. Be EXTREMELY concise. Confirm items with 2-3 words max once added successfully.
8. ${gstLine}
`;
  }
}
