import { createHash } from 'node:crypto';
import { Ajv, type AnySchema, type Options } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';

type Validation = { valid: true } | { valid: false; error: string };
type CompiledSchema = { valid: true; sha256: string; validate: (value: unknown) => Validation } | { valid: false; error: string };
const cache = new Map<string, CompiledSchema>();
const options: Options = {
  strictSchema: true, strictNumbers: true, strictTypes: false, strictTuples: false,
  strictRequired: false, allowUnionTypes: true, allowMatchingProperties: true,
  ownProperties: true, allErrors: false, coerceTypes: false, useDefaults: false,
  removeAdditional: false, addUsedSchema: false, logger: false,
};

// JSON-only data also excludes non-finite numbers hidden behind unconstrained schemas.
// These bounds protect normal application schemas; schemas remain trusted application code.
function boundedJson(value: unknown, maxBytes: number, maxDepth: number, maxNodes: number): string | null {
  const ancestors = new Set<object>();
  let nodes = 0, bytes = 0;
  function visit(item: unknown, depth: number): boolean {
    if (++nodes > maxNodes || depth > maxDepth) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') return (bytes += Buffer.byteLength(item)) <= maxBytes;
    if (typeof item !== 'object' || ancestors.has(item)) return false;
    const array = Array.isArray(item), proto = Object.getPrototypeOf(item);
    if (!array && proto !== Object.prototype && proto !== null) return false;
    if (Object.getOwnPropertySymbols(item).length) return false;
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (array && Object.keys(descriptors).length !== item.length + 1) return false;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) return false;
      if (!descriptor.enumerable || !('value' in descriptor) ||
          (bytes += Buffer.byteLength(key)) > maxBytes || !visit(descriptor.value, depth + 1)) return false;
    }
    ancestors.delete(item);
    return true;
  }
  try {
    if (!visit(value, 0)) return null;
    const text = JSON.stringify(value);
    return Buffer.byteLength(text) <= maxBytes ? text : null;
  } catch { return null; }
}

export function compileGatewaySchema(schema: unknown): CompiledSchema {
  const serialized = boundedJson(schema, 128 * 1024, 64, 10_000);
  if (serialized === null || (typeof schema !== 'boolean' && (schema === null || typeof schema !== 'object' || Array.isArray(schema)))) {
    return { valid: false, error: 'A bounded JSON Schema object or boolean is required.' };
  }
  const key = createHash('sha256').update(serialized).digest('hex');
  const cached = cache.get(key);
  if (cached) return cached;
  let result: CompiledSchema;
  try {
    // Compile a private JSON snapshot; no external schema resolver or cross-request registry.
    const frozen: AnySchema = JSON.parse(serialized);
    const dialect = typeof frozen === 'object' ? frozen.$schema : undefined;
    const ajv = dialect === 'https://json-schema.org/draft/2020-12/schema' ? new Ajv2020(options)
      : dialect === 'https://json-schema.org/draft/2019-09/schema' ? new Ajv2019(options)
        : new Ajv(options);
    for (const [name, format] of Object.entries(fullFormats)) ajv.addFormat(name, format);
    const validate = ajv.compile(frozen);
    if ('$async' in validate && validate.$async) throw new Error('Asynchronous schemas are not admitted.');
    result = { valid: true, sha256: key, validate(value: unknown): Validation {
      if (boundedJson(value, 8 * 1024 * 1024, 128, 100_000) === null) {
        return { valid: false, error: 'Output must be bounded, finite JSON data.' };
      }
      try {
        if (validate(value)) return { valid: true };
        // Neither provider data, property names, nor application schema content enters diagnostics.
        return { valid: false, error: 'Output does not match the requested JSON Schema.' };
      } catch { return { valid: false, error: 'Output could not be validated.' }; }
    } };
  } catch {
    result = { valid: false, error: 'The response schema is invalid or unsupported.' };
  }
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}

export function validateJsonSchema(value: unknown, schema: unknown): Validation {
  const compiled = compileGatewaySchema(schema);
  return compiled.valid ? compiled.validate(value) : compiled;
}
