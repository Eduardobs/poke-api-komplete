import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildClientSchema, parse, validate, execute, getOperationAST, getVariableValues, Kind, visit, specifiedRules, valueFromASTUntyped } from 'graphql';
import { Compiler, ContractError } from './sql.js';
import { LruCache } from './cache.js';
import { installIntrospection } from './introspection.js';
import { validateInputs, validateEnvelope } from './input.js';

const introspection = JSON.parse(readFileSync(new URL('../../contracts/graphql.introspection.json', import.meta.url)));
const catalog = JSON.parse(readFileSync(new URL('../generated/relational.json', import.meta.url)));
export const schema = buildClientSchema(introspection);
installIntrospection(schema, introspection);
// PostgreSQL scalar coercion is part of the Hasura contract. Validate input
// structure and pagination separately; let PostgreSQL report scalar cast errors.
for (const name of ['Int', 'Boolean', 'String']) {
  const scalar = schema.getType(name);
  scalar.parseValue = scalar.coerceInputValue = value => value;
  scalar.parseLiteral = scalar.coerceInputLiteral = node => valueFromASTUntyped(node);
}
const validationRules = specifiedRules.filter(rule => !['ValuesOfCorrectTypeRule', 'NoUnusedVariablesRule', 'NoUnusedFragmentsRule'].includes(rule.name));
const digest = input => createHash('sha256').update(input).digest('hex');
const errorResult = (message, path = '$', code = 'validation-failed') => ({ errors: [{ message, extensions: { path, code } }] });

function fieldPaths(document) {
  const paths = new Map();
  const fragments = Object.fromEntries(document.definitions.filter(d => d.kind === Kind.FRAGMENT_DEFINITION).map(d => [d.name.value, d]));
  const walk = (set, path, seen = new Set()) => {
    for (const node of set?.selections || []) {
      if (node.kind === Kind.FIELD) {
        const fieldPath = path + '.selectionSet.' + (node.alias?.value || node.name.value);
        paths.set(node, fieldPath);
        if (node.selectionSet) paths.set(node.selectionSet, fieldPath);
        for (const directive of node.directives || []) paths.set(directive, path + '.selectionSet');
        for (const arg of node.arguments || []) visit(arg, { enter(n) { paths.set(n, fieldPath + '.args.' + arg.name.value); } });
        walk(node.selectionSet, fieldPath, seen);
      } else if (node.kind === Kind.INLINE_FRAGMENT) walk(node.selectionSet, path, seen);
      else if (!fragments[node.name.value]) { paths.set(node, path + '.selectionSet'); paths.set(node.name, path + '.selectionSet'); }
      else if (!seen.has(node.name.value) && fragments[node.name.value]) walk(fragments[node.name.value].selectionSet, path, new Set([...seen, node.name.value]));
    }
  };
  for (const def of document.definitions) if (def.kind === Kind.OPERATION_DEFINITION) walk(def.selectionSet, '$');
  return paths;
}

function validationError(error, document) {
  const paths = fieldPaths(document);
  const node = error.nodes?.find(n => paths.has(n));
  const path = paths.get(node) || '$';
  let match;
  if ((match = /^Cannot query field "([^"]+)" on type "([^"]+)"/.exec(error.message))) return errorResult(`field '${match[1]}' not found in type: '${match[2]}'`, path);
  if ((match = /^Unknown argument "([^"]+)" on field "[^".]+\.([^"]+)"/.exec(error.message))) return errorResult(`'${match[2]}' has no argument named '${match[1]}'`, path.replace(/\.args\..*$/, ''));
  if ((match = /^Field "([^"]+)" .*must have a selection/.exec(error.message))) return errorResult(`missing selection set for '${match[1]}'`, path + '.selectionSet');
  if (/must not have a selection/.test(error.message)) return errorResult('unexpected subselection set for non-object field', path);
  if ((match = /^Argument "[^.]+\.[^(]+\(([^:]+):\)" .*required/.exec(error.message))) return errorResult(`missing required field '${match[1]}'`, path + '.args.' + match[1]);
  if ((match = /^Unknown directive "@([^"]+)"/.exec(error.message))) return errorResult(`directive '${match[1]}' is not defined in the schema`, path);
  if ((match = /^Unknown fragment "([^"]+)"/.exec(error.message))) return errorResult(`reference to undefined fragment "${match[1]}"`, path);
  if (path.endsWith('.limit')) {
    const kind = node?.kind === Kind.ARGUMENT ? node.value.kind : node?.kind;
    return errorResult("expected a non-negative 32-bit integer for type 'Int', but found " + (kind === Kind.STRING ? 'a string' : kind === Kind.FLOAT ? 'a floating point number' : 'an integer'), path);
  }
  return errorResult(error.message, path);
}

function databaseError(error) {
  if (error instanceof ContractError) return errorResult(error.message, error.path, error.code);
  if (error.code?.startsWith('22')) return errorResult(error.message, '$', 'data-exception');
  // Database credentials, SQL text, and internal topology are never returned publicly.
  return errorResult('database query error', '$', 'unexpected');
}

export function createGraphQL({ pool, responseCacheBytes = 16 * 1024 * 1024, responseTtlMs = 60000 } = {}) {
  const documents = new LruCache({ maxBytes: 8 * 1024 * 1024, maxEntries: 128 });
  const responses = new LruCache({ maxBytes: responseCacheBytes, ttlMs: responseTtlMs });
  const pendingResponses = new Map();
  const metrics = { coalescedRequests: 0, requests: 0, responseCacheHits: 0, documentCacheHits: 0, sqlStatements: 0 };
  async function run(input) {
    metrics.requests++;
    try {
      if (Array.isArray(input)) input.forEach((item,index)=>validateEnvelope(item,`$[${index}]`));
      else validateEnvelope(input);
    } catch (error) { return {status:200,body:databaseError(error)}; }
    if (Array.isArray(input)) {
      const results=[];
      // Sequential execution bounds database concurrency for large batches.
      for (const item of input) results.push(await run(item));
      if (results.every(result=>result.json)) {
        // Each entry is already complete JSON. Avoid allocating and traversing
        // the entire batch again, especially when all entries are cache hits.
        return {status:200,json:'['+results.map(result=>result.json).join(',')+']',cache:results.length && results.every(result=>result.cache==='HIT') ? 'HIT' : 'MISS'};
      }
      return {status:200,body:results.map(result=>result.json ? JSON.parse(result.json) : result.body)};
    }
    const key = digest(JSON.stringify([input.query, input.variables, input.operationName]));
    const cached = responses.get(key);
    if (cached) { metrics.responseCacheHits++; return { status: 200, json: cached, cache: 'HIT' }; }
    const pending = pendingResponses.get(key);
    if (pending) { metrics.coalescedRequests++; return pending; }
    const execution = runOperation(input, key);
    if (responseTtlMs > 0 && responseCacheBytes > 0 && pendingResponses.size < 128) {
      pendingResponses.set(key, execution);
      const clear = () => pendingResponses.delete(key);
      execution.then(clear, clear);
    }
    return execution;
  }
  async function runOperation(input, key) {
    let document = documents.get(input.query);
    if (document) metrics.documentCacheHits++;
    else {
      try { document = parse(input.query); }
      catch { return { status: 200, body: errorResult('not a valid graphql query', '$.query') }; }
      const operation = getOperationAST(document, input.operationName);
      if (operation?.operation === 'mutation') return { status: 200, body: errorResult('no mutations exist') };
      if (operation?.operation === 'subscription') return { status: 200, body: errorResult('subscriptions are not supported over HTTP, use websockets instead', '$', 'unexpected-payload') };
      const errors = validate(schema, document, validationRules);
      if (errors.length) return { status: 200, body: validationError(errors[0], document) };
      documents.set(input.query, document, Buffer.byteLength(input.query) * 32);
    }
    const operation = getOperationAST(document, input.operationName);
    if (!operation) return { status: 200, body: errorResult(input.operationName ? `no such operation found in the document: "${input.operationName}"` : 'exactly one operation has to be present in the document when operationName is not specified', '$', 'validation-failed') };
    if (operation.operation === 'mutation') return { status: 200, body: errorResult('no mutations exist') };
    if (operation.operation === 'subscription') return { status: 200, body: errorResult('subscriptions are not supported over HTTP, use websockets instead', '$', 'unexpected-payload') };
    const declared = new Set((operation.variableDefinitions || []).map(d => d.variable.name.value));
    const extra = Object.keys(input.variables || {}).filter(key => !declared.has(key));
    if (extra.length) return { status: 200, body: errorResult('unexpected variables in variableValues: ' + extra.join(', ')) };
    for (const def of operation.variableDefinitions || []) {
      const name = def.variable.name.value;
      if (def.type.kind === Kind.NON_NULL_TYPE && !Object.hasOwn(input.variables || {}, name) && !def.defaultValue) return { status: 200, body: errorResult(`expecting a value for non-nullable variable: "${name}"`) };
    }
    const defaults = Object.fromEntries((operation.variableDefinitions || []).filter(def => def.defaultValue).map(def => [def.variable.name.value, valueFromASTUntyped(def.defaultValue)]));
    try { validateInputs(schema, operation, document, { ...defaults, ...input.variables }); }
    catch (error) { return { status: 200, body: databaseError(error) }; }
    const variables = getVariableValues(schema, operation.variableDefinitions || [], input.variables || {});
    if (variables.errors) return { status: 200, body: validationError(variables.errors[0], document) };
    const fragments = Object.fromEntries(document.definitions.filter(d => d.kind === Kind.FRAGMENT_DEFINITION).map(d => [d.name.value, d]));
    const variableValues = variables.variableValues || { coerced: variables.coerced };
    const compiler = new Compiler(schema, catalog, variableValues, fragments);
    const batch = [];
    let queued = false, compileError;
    const root = (args, _context, info) => {
      let sql;
      try { sql = compiler.root(info, args); }
      catch (error) { compileError = error; throw error; }
      const promise = new Promise((resolve, reject) => batch.push({ key: 'r' + batch.length, sql, resolve, reject }));
      if (!queued) {
        queued = true;
        queueMicrotask(async () => {
          try {
            if (compileError) throw compileError;
            if (!pool) throw new Error('Database not configured');
            const text = 'SELECT ' + compiler.object(batch.map(item => [item.key, item.sql])) + ' AS data';
            metrics.sqlStatements++;
            const result = await pool.query({ text, values: compiler.values });
            for (const item of batch) item.resolve(result.rows[0].data[item.key]);
          } catch (error) { for (const item of batch) item.reject(error); }
        });
      }
      return promise;
    };
    // The field resolver dispatches by source identity; no per-field map is needed.
    const rootValue = {};
    const result = await execute({ schema, document, rootValue, variableValues: input.variables || {}, operationName: input.operationName,
      fieldResolver(source, args, context, info) {
        if (source === rootValue) return root(args, context, info);
        return source?.[info.path.key];
      },
    });
    if (result.errors) return { status: 200, body: databaseError(result.errors[0].originalError || result.errors[0]) };
    const json = JSON.stringify(result);
    responses.set(key, json, Buffer.byteLength(json));
    return { status: 200, json, cache: 'MISS' };
  }
  return { run, metrics, schema, catalog };
}
