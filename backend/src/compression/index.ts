import type { CanonicalRequest } from '../ir/types.js';
import type { CompressionConfig } from '../config/types.js';
import type { ChatMessage } from '../types/openai.js';
import { compressToolOutputs, formatCompressionLog, CompressionStats } from './tool-output.js';
import { compressWithHeadroom, formatHeadroomLog, HeadroomResult } from './headroom.js';
import { injectCaveman } from './caveman.js';
import { chatRequestToIR, irToChatRequest } from '../ir/adapters/openai-chat.js';

/** Text of the system message `irToChatRequest` built from `instructions`. */
function instructionText(message: ChatMessage): string | undefined {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return content.map((part) => (part.type === 'text' ? part.text ?? '' : '')).filter(Boolean).join('\n\n');
}

export interface CompressionOutcome {
  rtk: CompressionStats | null;
  headroom: HeadroomResult | null;
  /** Diagnostic when the optional Chat sidecar cannot be projected or written back. */
  headroomSkippedReason?: string;
  cavemanInjected: boolean;
}

export async function applyCompression(
  request: CanonicalRequest,
  config: CompressionConfig | undefined,
  sessionId?: string,
): Promise<CompressionOutcome> {
  const outcome: CompressionOutcome = { rtk: null, headroom: null, cavemanInjected: false };
  if (!config) return outcome;
  outcome.rtk = compressToolOutputs(request, config.rtk?.enabled);
  const rtkLog = formatCompressionLog(outcome.rtk);
  if (rtkLog) console.log(rtkLog);

  if (config.headroom?.enabled && config.headroom.url) {
    // Headroom's documented /v1/compress contract is Chat. The projection is
    // confined to this OPTIONAL external-service boundary, never execution IR.
    try {
      const projected = irToChatRequest(request, request.model);
      const result = await compressWithHeadroom(projected.messages, request.model, config.headroom, sessionId);
      if (result) {
        // `irToChatRequest` folds `instructions` + input system/developer text
        // into ONE leading system message. Only the instructions-owned slot may
        // be rewritten: `request.input` is the canonical payload and must stay
        // untouched, otherwise its system/developer items (and cache breakpoints)
        // vanish from every downstream adapter while the response stays 200.
        if (!request.instructions) {
          // No instructions slot: preserve original input-owned system/developer
          // items (including per-part cache breakpoints) if the leading system
          // message was not rewritten by the sidecar, while still applying
          // compressed conversation history.
          const origSystemItems = request.input.filter(
            (item) => item.type === 'message' && (item.role === 'system' || item.role === 'developer'),
          );
          const folded = projected.messages[0];
          const compressedFirst = result.messages[0];
          const systemUnchanged =
            origSystemItems.length > 0 &&
            folded?.role === 'system' &&
            compressedFirst?.role === 'system' &&
            instructionText(folded) === instructionText(compressedFirst);
          if (systemUnchanged) {
            const restoredBody = chatRequestToIR({ ...projected, messages: result.messages.slice(1) });
            request.input = [...origSystemItems, ...restoredBody.input];
          } else {
            const restored = chatRequestToIR({ ...projected, messages: result.messages });
            request.input = restored.input;
          }
        } else {
          const folded = projected.messages[0];
          const foldedText = folded && folded.role === 'system' ? instructionText(folded) : undefined;
          const prefix = `${request.instructions}\n\n`;
          const inputSuffix = foldedText?.startsWith(prefix) ? foldedText.slice(prefix.length) : '';
          const compressed = result.messages[0];
          const compressedText = compressed && compressed.role === 'system' ? instructionText(compressed) : undefined;
          if (compressedText === undefined) {
            // The sidecar changed the leading system's shape. Splitting it back
            // into instructions vs input would silently drop prompt text.
            throw new Error('headroom returned a non-system leading message');
          }
          const origSystemItems = request.input.filter(
            (item) => item.type === 'message' && (item.role === 'system' || item.role === 'developer'),
          );
          const suffix = inputSuffix ? `\n\n${inputSuffix}` : '';
          const keptInputSuffix = Boolean(suffix && compressedText.endsWith(suffix));
          const nextInstructions = keptInputSuffix
            ? compressedText.slice(0, -suffix.length)
            : compressedText;
          // Apply the compressed conversation history (messages after the folded
          // leading system message) while always preserving input-owned
          // system/developer items verbatim. Restore before mutating `request` so
          // a conversion failure fails open without partial writes.
          const restoredBody = chatRequestToIR({ ...projected, messages: result.messages.slice(1) });
          request.instructions = nextInstructions;
          request.input = [...origSystemItems, ...restoredBody.input];
        }
        outcome.headroom = result;
        const log = formatHeadroomLog(result);
        if (log) console.log(log);
      }
    } catch (err) {
      // Any failure on this optional boundary fails open to the original input.
      outcome.headroomSkippedReason = err instanceof Error ? err.message : String(err);
      console.warn(`[compression:headroom] projection/write-back failed (${outcome.headroomSkippedReason}) — passthrough`);
    }
  }
  if (config.caveman?.enabled) {
    const level = config.caveman.level ?? 'full';
    outcome.cavemanInjected = injectCaveman(request, level);
    if (outcome.cavemanInjected) console.log(`[compression:caveman] injected level=${level}`);
  }
  return outcome;
}

export type { CompressionStats } from './tool-output.js';
export type { HeadroomResult } from './headroom.js';
export { CAVEMAN_LEVELS } from './caveman-prompts.js';
export type { CavemanLevel } from './caveman-prompts.js';
