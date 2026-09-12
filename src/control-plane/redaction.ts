import {
  CONFIG_SCHEMA,
  type ConfigSchemaGroup,
  type ConfigSchemaNode,
  isConfigSchemaField,
} from "../config/schema.js";

function redactNode(value: unknown, schema: ConfigSchemaNode): unknown {
  if (isConfigSchemaField(schema)) {
    return schema.sensitive ? "[redacted]" : value;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    const childSchema = schema[key];
    result[key] = childSchema
      ? redactNode(item, childSchema)
      : redactUnknown(item);
  }
  return result;
}

function redactUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      redactUnknown(item),
    ]),
  );
}

/**
 * Produces a copy suitable for diagnostics. Every sensitive field declared in
 * the schema is replaced before clients can render or serialize the object.
 */
export function redactWithConfigSchema(
  value: unknown,
  schema: ConfigSchemaGroup = CONFIG_SCHEMA,
): unknown {
  return redactNode(value, schema);
}

export function redactConfigForDiagnostics<T>(value: T): T {
  return redactWithConfigSchema(value) as T;
}
