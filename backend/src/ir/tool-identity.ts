import crypto from 'node:crypto';

/**
 * The ONE namespace for a tool correlation id the gateway itself has to supply.
 *
 * Why this lives in the IR layer instead of an adapter: every upstream READER can meet a
 * tool call that arrived with no id — a lenient OpenAI-compatible server returns
 * `tool_calls[]` without one, a Responses server can omit both `id` and `call_id`, Gemini
 * has no correlation field at all, and a markup-recovered call has no native id either.
 * Each reader used to patch that differently (`call_<16hex>`, `call_<candidate>_<index>`,
 * or nothing at all, which left `''`), and the three spellings were three drift twins of
 * one idea — one of them positional, which collides with the SAME position of the PREVIOUS
 * turn inside one replayed history.
 *
 * The id is minted in CANONICAL state, at the moment the upstream response is read, not at
 * wire-render time. That placement is the point: canonical state is what the session store
 * records for a `store: true` chain, what capture archives, and what every outbound carrier
 * renders from, so the client, the operator's record and the next turn's replay all speak ONE
 * name for one call. A render-time mint would leave the stored turn with an empty id, and the
 * next turn would then fail on the gateway's own history (`400 tool_call_id`) or orphan the
 * client's real tool result.
 *
 * 24 hex chars (12 bytes, 96 bits) keeps the id inside every carrier's field budget — the
 * Responses correlation budget is `RESPONSES_CALL_ID_MAX_LEN` = 64 — and inside the charset
 * `[A-Za-z0-9_-]` both Responses id fields share, so a minted id never needs the outbound
 * projection and never truncates.
 */
export const CALL_ID_PREFIX = 'call_';

/** A fresh, carrier-legal correlation id for an upstream call that arrived unnamed. */
export function mintToolCallId(): string {
  return `${CALL_ID_PREFIX}${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * The id an upstream tool call carries, or a minted one when it carries none. An EMPTY
 * string counts as none: a field the vendor sent as `""` names nothing, which is exactly
 * the case this exists for. Callers assign the RESULT to both `id` and `callId` so the two
 * slots of one call never disagree.
 */
export function upstreamToolCallId(id: string | undefined | null): string {
  return id || mintToolCallId();
}
