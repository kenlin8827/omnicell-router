import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SchemaAssertion } from '../../src/validator/schema-assertion.js';
import { FallbackContextBuilder } from '../../src/validator/parser.js';
import type { TextConfig } from '../../src/ir/types.js';
import { toIR } from '../helpers/ir.js';

describe('Step 3: Cascading Fallback & Static Schema Assertion', () => {
  it('should cleanly extract and validate JSON wrapped in markdown code fence', () => {
    const raw = '```json\n{\n  "name": "Alice",\n  "age": 28\n}\n```';
    const result = SchemaAssertion.validate(raw);
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.parsed, { name: 'Alice', age: 28 });
  });

  it('should fail with SyntaxError on malformed JSON', () => {
    const malformed = '{\n  "name": "Alice",\n  "age": 28, \n';
    const result = SchemaAssertion.validate(malformed);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes('JSON SyntaxError'));
  });

  it('should validate JSON against required fields and enum values', () => {
    const format: TextConfig['format'] = {
      type: 'json_schema',
      name: 'PersonSchema',
      schema: {
        type: 'object',
        required: ['name', 'status'],
        properties: {
          name: { type: 'string' },
          status: { type: 'string', enum: ['active', 'inactive', 'pending'] },
        },
      },
    };

    // Valid data
    const validRaw = JSON.stringify({ name: 'Bob', status: 'active' });
    const validRes = SchemaAssertion.validate(validRaw, format);
    assert.strictEqual(validRes.valid, true);

    // Missing required field
    const missingRaw = JSON.stringify({ name: 'Bob' });
    const missingRes = SchemaAssertion.validate(missingRaw, format);
    assert.strictEqual(missingRes.valid, false);
    assert.ok(missingRes.error?.includes("Missing required key 'status'"));

    // Invalid enum value
    const invalidEnumRaw = JSON.stringify({ name: 'Bob', status: 'banned' });
    const invalidEnumRes = SchemaAssertion.validate(invalidEnumRaw, format);
    assert.strictEqual(invalidEnumRes.valid, false);
    assert.ok(invalidEnumRes.error?.includes("invalid enum value 'banned'"));
  });

  it('should properly package fallback context with assertion error message', () => {
    const originalReq = toIR({
      model: 'auto',
      messages: [{ role: 'user', content: 'Extract name and status as JSON.' }],
    });

    const escalated = FallbackContextBuilder.buildEscalationRequest(
      originalReq,
      '{"name": "Bob", "status": "unknown"}',
      "Field 'status' has invalid enum value 'unknown'",
      'claude-3-5-sonnet'
    );

    assert.strictEqual(escalated.model, 'claude-3-5-sonnet');
    assert.strictEqual(escalated.input.length, 3);
    assert.strictEqual(escalated.input[1]?.type, 'message');
    assert.strictEqual(escalated.input[1]?.role, 'assistant');
    assert.strictEqual(escalated.input[2]?.type, 'message');
    assert.strictEqual(escalated.input[2]?.role, 'user');
    assert.ok(JSON.stringify(escalated.input[2]).includes('System Assertion Error'));
  });
});
