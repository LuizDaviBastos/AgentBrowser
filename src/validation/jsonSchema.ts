import Ajv, { ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import { JsonSchemaObject } from '../types';

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true, coerceTypes: false, removeAdditional: false });
addFormats(ajv);

export interface SchemaValidationResult {
  valid: boolean;
  errors?: string[];
}

export function validateSchema(schema: JsonSchemaObject, value: unknown, strict = false, requiredFields?: string[]): SchemaValidationResult {
  const workingSchema: JsonSchemaObject = strict
    ? {
        ...schema,
        additionalProperties: false,
        ...(requiredFields && requiredFields.length
          ? { required: Array.from(new Set([...(schema.required || []), ...requiredFields])) }
          : {}),
      }
    : {
        ...schema,
        ...(requiredFields && requiredFields.length
          ? { required: Array.from(new Set([...(schema.required || []), ...requiredFields])) }
          : {}),
      };

  const validate = ajv.compile(workingSchema);
  const ok = validate(value);
  return ok
    ? { valid: true }
    : { valid: false, errors: formatErrors(validate.errors || []) };
}

function formatErrors(errors: ErrorObject[]): string[] {
  return errors.map(err => {
    const path = err.instancePath || '(root)';
    return `${path} ${err.message || 'is invalid'}`;
  });
}

