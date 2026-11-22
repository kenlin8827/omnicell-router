import type { TextConfig } from '../ir/types.js';

export interface ValidationResult {
  valid: boolean;
  error?: string;
  parsed?: any;
}

export class SchemaAssertion {
  /**
   * Cleans model output, stripping markdown code fences like ```json ... ```
   */
  public static extractJsonString(raw: string): string {
    const trimmed = raw.trim();
    // 1. Look for ```json ... ```
    const jsonBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (jsonBlockMatch && jsonBlockMatch[1]) {
      return jsonBlockMatch[1].trim();
    }

    // 2. Look for outermost { ... } or [ ... ]
    const firstBrace = trimmed.indexOf('{');
    const firstBracket = trimmed.indexOf('[');
    
    let startIdx = -1;
    let endIdx = -1;

    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
      startIdx = firstBrace;
      endIdx = trimmed.lastIndexOf('}');
    } else if (firstBracket !== -1) {
      startIdx = firstBracket;
      endIdx = trimmed.lastIndexOf(']');
    }

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      return trimmed.slice(startIdx, endIdx + 1);
    }

    return trimmed;
  }

  /**
   * Fast static schema & syntax assertion
   */
  public static validate(rawText: string, format?: TextConfig['format']): ValidationResult {
    if (!rawText || rawText.trim().length === 0) {
      return { valid: false, error: 'Empty output received from model' };
    }

    const jsonStr = this.extractJsonString(rawText);

    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (err: any) {
      return {
        valid: false,
        error: `JSON SyntaxError: ${err.message}. Output was not valid JSON.`,
      };
    }

    if (format?.type !== 'json_schema') {
      if (typeof parsed !== 'object' || parsed === null) {
        return {
          valid: false,
          error: `Expected JSON object/array but got ${typeof parsed}`,
        };
      }
      return { valid: true, parsed };
    }

    const schemaErr = this.checkSchemaCompliance(parsed, format.schema);
    if (schemaErr) {
      return { valid: false, error: schemaErr, parsed };
    }

    return { valid: true, parsed };
  }

  private static schemaAllowsNull(schema: Record<string, any> | undefined): boolean {
    if (!schema || typeof schema !== 'object') return false;
    if (schema.type === 'null') return true;
    if (Array.isArray(schema.type) && schema.type.includes('null')) return true;
    if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true;
    if (Array.isArray(schema.anyOf) && schema.anyOf.some((sub: any) => this.schemaAllowsNull(sub))) return true;
    if (Array.isArray(schema.oneOf) && schema.oneOf.some((sub: any) => this.schemaAllowsNull(sub))) return true;
    return false;
  }

  /**
   * Lightweight validator for JSON Schema properties, required fields, and enums
   */
  private static checkSchemaCompliance(data: any, schema: Record<string, any>, path = ''): string | null {
    if (!schema || typeof schema !== 'object') return null;

    if (Array.isArray(schema.anyOf)) {
      const branches = schema.anyOf.filter((b: any) => b && typeof b === 'object');
      if (branches.length > 0 && !branches.some((b: any) => this.checkSchemaCompliance(data, b, path) === null)) {
        return `Field '${path || 'root'}' did not match anyOf schema branches`;
      }
    }
    if (Array.isArray(schema.oneOf)) {
      const branches = schema.oneOf.filter((b: any) => b && typeof b === 'object');
      if (branches.length > 0 && !branches.some((b: any) => this.checkSchemaCompliance(data, b, path) === null)) {
        return `Field '${path || 'root'}' did not match oneOf schema branches`;
      }
    }

    if (Array.isArray(schema.type)) {
      if (data === null && schema.type.includes('null')) return null;
      const nonNullTypes = schema.type.filter((t: unknown) => typeof t === 'string' && t !== 'null');
      if (nonNullTypes.length > 0) {
        const matched = nonNullTypes.some(
          (t: string) => this.checkSchemaCompliance(data, { ...schema, type: t }, path) === null,
        );
        if (!matched) {
          return `Field '${path || 'root'}' must match one of [${schema.type.join(', ')}]`;
        }
      }
      return null;
    }

    if (schema.type === 'null') {
      if (data !== null) {
        return `Field '${path || 'root'}' must be null`;
      }
      return null;
    }

    if (schema.type === 'object') {
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return `Field '${path || 'root'}' must be an object`;
      }

      // Check required fields
      if (Array.isArray(schema.required)) {
        for (const reqKey of schema.required) {
          const propSchema = schema.properties?.[reqKey];
          const nullAllowed = this.schemaAllowsNull(propSchema);
          if (!(reqKey in data) || data[reqKey] === undefined || (data[reqKey] === null && !nullAllowed)) {
            return `Missing required key '${path ? `${path}.${reqKey}` : reqKey}'`;
          }
        }
      }

      // Check properties recursively
      if (schema.properties && typeof schema.properties === 'object') {
        for (const [propKey, propSchema] of Object.entries<any>(schema.properties)) {
          if (propKey in data) {
            const err = this.checkSchemaCompliance(data[propKey], propSchema, path ? `${path}.${propKey}` : propKey);
            if (err) return err;
          }
        }
      }
    } else if (schema.type === 'array') {
      if (!Array.isArray(data)) {
        return `Field '${path || 'root'}' must be an array`;
      }
      if (schema.items) {
        for (let i = 0; i < data.length; i++) {
          const err = this.checkSchemaCompliance(data[i], schema.items, `${path}[${i}]`);
          if (err) return err;
        }
      }
    } else if (schema.type === 'string') {
      if (typeof data !== 'string') {
        return `Field '${path}' must be a string, got ${typeof data}`;
      }
      if (Array.isArray(schema.enum) && !schema.enum.includes(data)) {
        return `Field '${path}' has invalid enum value '${data}'. Allowed: [${schema.enum.join(', ')}]`;
      }
    } else if (schema.type === 'number' || schema.type === 'integer') {
      if (typeof data !== 'number' || Number.isNaN(data)) {
        return `Field '${path}' must be a number, got ${typeof data}`;
      }
      if (schema.type === 'integer' && !Number.isInteger(data)) {
        return `Field '${path}' must be an integer`;
      }
    } else if (schema.type === 'boolean') {
      if (typeof data !== 'boolean') {
        return `Field '${path}' must be a boolean, got ${typeof data}`;
      }
    }

    return null;
  }
}
