import { ChatCompletionRequest } from '../types/openai.js';
import { TierLevel } from '../types/router.js';
import { Layer2JudgeConfig } from '../config/types.js';
import { RoutingDecisionCache, type RoutingCacheStats } from './decision-cache.js';
import { proxiedFetch } from '../utils/proxy.js';

export interface Layer2JudgeResult {
  targetTier: TierLevel;
  confidence: number;
  reason: string;
  provider: string;
  model: string;
  rawResponse?: any;
}

/**
 * Layer 2: Specialized Context-Aware Decision Judge Model
 * (TypeSafe Jev / OpenCode / External Decision API)
 * 
 * Non-autoregressive System 1 decision model or zero-shot classifier returning
 * semantic intent classifications with calibrated probabilities and multi-turn awareness.
 */
export class Layer2Judge {
  private static readonly DECISION_QUESTION =
    'Classify the computational task difficulty tier (ATTENTION: NEVER judge difficulty by character length! Short prompts like "P=NP?" or "Prove Fermat\'s Last Theorem" are high-difficulty): ' +
    'lite (trivial QA, simple calculation, basic translation, shallow extraction, casual greetings), ' +
    'plus (system architecture, complex software engineering, refactoring, creative generation, nuanced thinking — the default workhorse), ' +
    'pro (deep mathematical proof, formal symbolic logic, NP-hard algorithmic complexity, hard research), ' +
    'ultra (frontier-tier, hour-long autonomous agent tasks, hardest open-ended thinking).';

  private static readonly CHOICES = ['lite', 'plus', 'pro', 'ultra'];

  // routing decision cache (LRU+TTL over judge results)
  private static decisionCache: RoutingDecisionCache | null = null;

  private static getDecisionCache(config?: Layer2JudgeConfig): RoutingDecisionCache {
    // Orchestrator snapshots config at construction, so runtime config is stable;
    // lazily initialize once with the first-seen config.
    if (!this.decisionCache) {
      this.decisionCache = new RoutingDecisionCache(config?.decisionCache);
    }
    return this.decisionCache;
  }

  public static getDecisionCacheStats(): RoutingCacheStats {
    return (this.decisionCache || new RoutingDecisionCache({ enabled: false })).getStats();
  }

  public static clearDecisionCache(): void {
    this.decisionCache?.clear();
  }

  /**
   * Evaluate request using Layer 2 specialized decision judge model
   */
  public static async evaluate(
    request: ChatCompletionRequest,
    config?: Layer2JudgeConfig
  ): Promise<Layer2JudgeResult | null> {
    if (!config?.enabled) return null;

    const timeoutMs = config.timeoutMs || 2000;
    const provider = config.provider || 'opencode';
    const model = config.model || (provider === 'typesafe' ? 'typesafe/jev' : 'auto');

    // Extract recent conversational context for multi-turn awareness (last 4 turns)
    const messages = request.messages || [];
    const recentMessages = messages.length > 4 ? messages.slice(-4) : messages;
    const userText = recentMessages
      .map(m => {
        const role = m.role || 'user';
        const content = typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map(p => p.text || '').join(' ')
            : '';
        return `${role}: ${content}`;
      })
      .join('\n');

    // reuse a prior identical-context decision before calling out
    const decisionCache = this.getDecisionCache(config);
    const cacheKey = RoutingDecisionCache.buildCacheKey(provider, model, userText);
    const cached = decisionCache.get(cacheKey);
    if (cached) {
      return {
        targetTier: cached.targetTier as TierLevel,
        confidence: cached.confidence,
        reason: `[Decision Cache] ${cached.reason}`,
        provider,
        model,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      if (provider === 'typesafe') {
        // Native TypeSafe Jev API call
        const baseUrl = config.baseUrl || 'https://api.typesafe.ai/v1';
        const apiKey = config.apiKey || process.env.TYPESAFE_API_KEY || '';

        const res = await proxiedFetch(`${baseUrl}/decision/choice`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            state: userText.slice(0, 4000),
            question: this.DECISION_QUESTION,
            choices: this.CHOICES,
          }),
          signal: controller.signal,
        }, { provider, model });

        clearTimeout(timeout);

        if (!res.ok) return null;

        const data = (await res.json()) as any;
        const choice = (data.choice || data.decision || 'plus').toLowerCase();
        const tier: TierLevel = (choice === 'lite' || choice === 'pro' || choice === 'ultra') ? choice : 'plus';
        const confidence = typeof data.confidence === 'number' ? data.confidence : 0.92;
        const reason = `TypeSafe Jev specialized decision model classified as ${tier} (confidence: ${(confidence * 100).toFixed(1)}%)`;

        decisionCache.set(cacheKey, { targetTier: tier, confidence, reason });

        return {
          targetTier: tier,
          confidence,
          reason,
          provider: 'typesafe',
          model,
          rawResponse: data,
        };
      } else {
        // OpenCode v2 or generic OpenAI compatible endpoint
        const baseUrl = config.baseUrl || (provider === 'opencode' ? 'http://127.0.0.1:49374/v1' : 'https://openrouter.ai/api/v1');
        const apiKey = config.apiKey || (provider === 'opencode' ? 'opencode' : (process.env.OPENROUTER_API_KEY || ''));

        const res = await proxiedFetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: provider === 'opencode' ? 'minimax-cn-coding-plan/MiniMax-M3.1-Flash-Preview' : model,
            messages: [
              {
                role: 'system',
                content:
                  'You are a strict task complexity classifier. Analyze the user request and output JSON: {"tier": "lite" | "plus" | "pro" | "ultra", "confidence": number}.\n' +
                  'CRITICAL RULE: DO NOT JUDGE BY TEXT LENGTH. Short prompts can be highly complex (e.g. "P=NP?", "Prove Riemann Hypothesis" are pro; "Red-Black Tree implementation" is plus).\n' +
                  '- lite: trivial arithmetic, basic translation, casual greeting, shallow lookup.\n' +
                  '- plus: system architecture, coding/refactoring, engineering design, creative writing.\n' +
                  '- pro: mathematical proofs, NP-hard theoretical problems, formal symbolic logic, hard research.\n' +
                  '- ultra: frontier thinking, hour-long autonomous agent tasks.',
              },
              { role: 'user', content: userText.slice(0, 3000) },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.0,
            max_tokens: 50,
          }),
          signal: controller.signal,
        }, { provider, model });

        clearTimeout(timeout);

        if (!res.ok) return null;
        const data = (await res.json()) as any;
        const content = data.choices?.[0]?.message?.content || '{}';
        const parsed = JSON.parse(content);
        const tier: TierLevel = (parsed.tier === 'lite' || parsed.tier === 'pro' || parsed.tier === 'ultra') ? parsed.tier : 'plus';
        const reason = `Specialized Layer 2 (${provider}) classified as ${tier}`;

        decisionCache.set(cacheKey, { targetTier: tier, confidence: parsed.confidence || 0.90, reason });

        return {
          targetTier: tier,
          confidence: parsed.confidence || 0.90,
          reason,
          provider,
          model,
          rawResponse: parsed,
        };
      }
    } catch {
      clearTimeout(timeout);
      return null;
    }
  }
}
