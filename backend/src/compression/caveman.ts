import type { CanonicalRequest, MessageItem } from '../ir/types.js';
import { CAVEMAN_PROMPTS, isCavemanLevel } from './caveman-prompts.js';

const SEP = '\n\n';

function containsSegment(haystack: string | undefined, segment: string): boolean {
  return Boolean(haystack && (haystack === segment || haystack.split(SEP).includes(segment)));
}

function messageText(message: MessageItem): string {
  return message.content.map((part) => part.type === 'text' ? part.text : '').join(SEP);
}

export function injectCaveman(request: CanonicalRequest, level?: string): boolean {
  if (!request || !Array.isArray(request.input) || !isCavemanLevel(level)) return false;
  const prompt = CAVEMAN_PROMPTS[level];
  try {
    const systemIndex = request.input.findIndex((item): item is MessageItem =>
      item.type === 'message' && (item.role === 'system' || item.role === 'developer'));
    if (systemIndex >= 0) {
      const system = request.input[systemIndex] as MessageItem;
      if (containsSegment(messageText(system), prompt)) return false;
      const nextInput = [...request.input];
      nextInput[systemIndex] = {
        ...system,
        content: [...system.content, { type: 'text', text: prompt }],
      };
      request.input = nextInput;
      return true;
    }
    if (request.instructions !== undefined) {
      if (containsSegment(request.instructions, prompt)) return false;
      request.instructions = [request.instructions, prompt].filter(Boolean).join(SEP);
      return true;
    }
    request.input = [
      { type: 'message', role: 'system', content: [{ type: 'text', text: prompt }] },
      ...request.input,
    ];
    return true;
  } catch {
    return false;
  }
}
