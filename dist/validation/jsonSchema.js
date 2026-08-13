"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateSchema = validateSchema;
const ajv_1 = __importDefault(require("ajv"));
const ajv_formats_1 = __importDefault(require("ajv-formats"));
const ajv = new ajv_1.default({ allErrors: true, strict: false, allowUnionTypes: true, coerceTypes: false, removeAdditional: false });
(0, ajv_formats_1.default)(ajv);
function validateSchema(schema, value, strict = false, requiredFields) {
    const workingSchema = strict
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
function formatErrors(errors) {
    return errors.map(err => {
        const path = err.instancePath || '(root)';
        return `${path} ${err.message || 'is invalid'}`;
    });
}
