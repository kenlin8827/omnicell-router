import type { CanonicalRequest, InputItem } from '../ir/types.js';

export class FallbackContextBuilder {
  public static buildEscalationRequest(
    originalRequest: CanonicalRequest,
    failedOutput: string,
    validationError: string,
    targetModel: string,
  ): CanonicalRequest {
    const input: InputItem[] = [
      ...originalRequest.input,
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: failedOutput }] },
      {
        type: 'message', role: 'user', content: [{
          type: 'text',
          text: `[System Assertion Error] The previous output failed structural validation:\n${validationError}\n\nPlease regenerate the response. Ensure strict compliance with the required schema and ensure output is completely valid without syntax or schema violations.`,
        }],
      },
    ];
    return {
      ...originalRequest,
      model: targetModel,
      input,
      generation: { ...originalRequest.generation, temperature: 0.1 },
    };
  }
}
