// Preserve the reference engine's introspection, including legacy scalar descriptions
// and its published introspection field ordering. Runtime query execution stays ours.
export function installIntrospection(schema, reference) {
  const types = new Map(reference.__schema.types.map(type => [type.name, type]));
  for (const [name, type] of Object.entries(schema.getTypeMap())) {
    if (!types.has(name)) { delete schema.getTypeMap()[name]; continue; }
    if (!name.startsWith('__')) continue;
    const fields = type.getFields?.();
    if (!fields) continue;
    const allowed = new Set((types.get(name).fields || []).map(field => field.name));
    for (const [fieldName, field] of Object.entries(fields)) {
      if (!allowed.has(fieldName)) { delete fields[fieldName]; continue; }
      field.resolve = (source, args) => {
        const raw = source === schema ? reference.__schema : source?.astNode || source?.getFields || source?.toConfig ? types.get(source.name) || source : source;
        let value = raw?.[fieldName];
        if (value === undefined && raw?.name) value = types.get(raw.name)?.[fieldName];
        if (Array.isArray(value) && ['fields', 'enumValues', 'inputFields', 'args'].includes(fieldName) && !args.includeDeprecated) value = value.filter(item => !item.isDeprecated);
        return value ?? null;
      };
    }
  }
}
