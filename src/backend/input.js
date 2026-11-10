import { isNonNullType, isListType, isInputObjectType, isEnumType, valueFromASTUntyped, Kind, typeFromAST } from 'graphql';
import { ContractError } from './sql.js';

const category = value => value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value === 'string' ? 'a string' : typeof value === 'boolean' ? 'a boolean' : Number.isInteger(value) ? 'an integer' : 'a float';
function check(type, value, path, argument = false) {
  if (isNonNullType(type)) {
    if (value == null) throw new ContractError(`unexpected null value for type '${type.ofType}'`, path);
    return check(type.ofType, value, path, argument);
  }
  if (value === null) {
    if (argument || isEnumType(type)) return;
    if (isListType(type)) throw new ContractError('expected a list, but found null', path);
    if (isInputObjectType(type)) throw new ContractError(`expected an object for type '${type}', but found null`, path);
    throw new ContractError(`unexpected null value for type '${type}'`, path);
  }
  if (isListType(type)) {
    const values = Array.isArray(value) ? value : [value];
    values.forEach((item, index) => check(type.ofType, item, `${path}[${index}]`));
  } else if (isInputObjectType(type)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError(`expected an object for type '${type}', but found ${category(value)}`, path);
    const fields = type.getFields();
    for (const [name, item] of Object.entries(value)) {
      if (!fields[name]) throw new ContractError(`field '${name}' not found in type: '${type}'`, `${path}.${name}`);
      check(fields[name].type, item, `${path}.${name}`);
    }
  } else if (isEnumType(type)) {
    if (!type.getValue(value)) throw new ContractError(`expected one of the values [${type.getValues().map(v => `'${v.name}'`).join(', ')}] for type '${type}', but found '${value}'`, path);
  } else if (type.name === 'Int') {
    if (/\.(limit|offset)$/.test(path) && (typeof value !== 'number' || !Number.isInteger(value))) throw new ContractError(`expected a non-negative 32-bit integer for type 'Int', but found ${category(value)}`, path);
    if (typeof value === 'number' && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)) {
      const number = Math.abs(value)>=1e7 ? value.toExponential().replace('e+', 'e') : String(value);
      throw new ContractError(`The value ${number} lies outside the bounds or is not an integer. Maybe it is a float, or is there integer overflow?`, path, 'parse-failed');
    }
    if (typeof value !== 'number' && typeof value !== 'string') throw new ContractError(`parsing Integer expected for input type: PGInteger failed, expected Number, but encountered ${typeof value === 'boolean' ? 'Boolean' : Array.isArray(value) ? 'Array' : 'Object'}`, path, 'parse-failed');
  }
}

export function validateEnvelope(input, path = '$') {
  const kind = value => value === null ? 'Null' : Array.isArray(value) ? 'Array' : typeof value === 'string' ? 'String' : typeof value === 'boolean' ? 'Boolean' : 'Number';
  const fail = (message, at = path) => {throw new ContractError(message,at,'parse-failed');};
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`parsing Hasura.GraphQL.Transport.HTTP.Protocol.GQLReq(GQLReq) failed, expected Object, but encountered ${kind(input)}`);
  if (!Object.hasOwn(input,'query')) fail('parsing Hasura.GraphQL.Transport.HTTP.Protocol.GQLReq(GQLReq) failed, key "query" not found');
  if (typeof input.query !== 'string') fail(`parsing Text failed, expected String, but encountered ${kind(input.query)}`,path+'.query');
  if (input.operationName != null) {
    if (typeof input.operationName !== 'string') fail(`parsing Name failed, expected String, but encountered ${kind(input.operationName)}`,path+'.operationName');
    if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(input.operationName)) fail(`${input.operationName} is not valid GraphQL name`,path+'.operationName');
  }
  if (input.variables != null && (typeof input.variables !== 'object' || Array.isArray(input.variables))) fail(`parsing HashMap failed, expected Object, but encountered ${kind(input.variables)}`,path+'.variables');
}

// Hasura accepts PostgreSQL scalar inputs (including numeric strings in filters),
// but applies stricter pagination, object, enum and non-null validation.
export function validateInputs(schema, operation, document, variables) {
  const fragments = Object.fromEntries(document.definitions.filter(d => d.kind === Kind.FRAGMENT_DEFINITION).map(d => [d.name.value, d]));
  for (const def of operation.variableDefinitions || []) {
    const name = def.variable.name.value;
    if (variables[name] === null && isNonNullType(typeFromAST(schema, def.type))) throw new ContractError(`null value found for non-nullable type: "${typeFromAST(schema, def.type)}"`);
  }
  const walk = (type, set, path, seen = new Set()) => {
    for (const node of set?.selections || []) {
      if (node.kind === Kind.INLINE_FRAGMENT) walk(schema.getType(node.typeCondition?.name.value) || type, node.selectionSet, path, seen);
      else if (node.kind === Kind.FRAGMENT_SPREAD) {
        if (!seen.has(node.name.value) && fragments[node.name.value]) walk(schema.getType(fragments[node.name.value].typeCondition.name.value), fragments[node.name.value].selectionSet, path, new Set([...seen, node.name.value]));
      } else {
        const field = type.getFields()[node.name.value];
        if (!field) continue;
        const fieldPath = `${path}.selectionSet.${node.alias?.value || node.name.value}`;
        for (const arg of node.arguments || []) {
          const definition = field.args.find(a => a.name === arg.name.value);
          if (definition) {
            const value = valueFromASTUntyped(arg.value, variables);
            if (value !== undefined) check(definition.type, value, `${fieldPath}.args.${arg.name.value}`, true);
          }
        }
        let child = field.type;
        while (child.ofType) child = child.ofType;
        if (child.getFields) walk(child, node.selectionSet, fieldPath, seen);
      }
    }
  };
  walk(schema.getQueryType(), operation.selectionSet, '$');
}
