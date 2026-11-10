import { getArgumentValues, getDirectiveValues, GraphQLIncludeDirective, GraphQLSkipDirective, getNamedType } from 'graphql';

export class ContractError extends Error {
  constructor(message, path = '$', code = 'validation-failed') { super(message); this.path = path; this.code = code; }
}
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const comparisons = { _eq: '=', _neq: '<>', _gt: '>', _gte: '>=', _lt: '<', _lte: '<=', _like: 'LIKE', _nlike: 'NOT LIKE', _ilike: 'ILIKE', _nilike: 'NOT ILIKE', _regex: '~', _nregex: '!~', _iregex: '~*', _niregex: '!~*', _similar: 'SIMILAR TO', _nsimilar: 'NOT SIMILAR TO', _contains: '@>', _contained_in: '<@', _has_key: '?', _has_keys_any: '?|', _has_keys_all: '?&', _jsonb_path_exists: '@?', _jsonb_path_match: '@@' };
const aggregates = new Set(['avg', 'max', 'min', 'sum', 'stddev', 'stddev_pop', 'stddev_samp', 'var_pop', 'var_samp', 'variance', 'bool_and', 'bool_or']);

export class Compiler {
  constructor(schema, catalog, variables, fragments) {
    Object.assign(this, { schema, catalog, variables, fragments });
    this.values = []; this.sequence = 0;
  }
  alias() { return 't' + this.sequence++; }
  param(value, type) {
    this.values.push(type === 'jsonb' ? JSON.stringify(value) : value);
    return '$' + this.values.length + (type ? '::' + type : '');
  }
  column(table, alias, name) {
    if (!Object.hasOwn(this.catalog[table].columns, name)) throw new Error('Unknown SQL column');
    return quote(alias) + '.' + quote(name);
  }
  object(pairs) {
    if (!pairs.length) return "'{}'::jsonb";
    const chunks = [];
    for (let i = 0; i < pairs.length; i += 40) chunks.push('jsonb_build_object(' + pairs.slice(i, i + 40).map(([key, expr]) => literal(key) + ',' + expr).join(',') + ')');
    return '(' + chunks.join(' || ') + ')';
  }
  fields(nodes) {
    const fields = new Map();
    const seen = new Set();
    const walk = selections => {
      for (const node of selections || []) {
        if (getDirectiveValues(GraphQLSkipDirective, node, this.variables)?.if === true || getDirectiveValues(GraphQLIncludeDirective, node, this.variables)?.if === false) continue;
        if (node.kind === 'Field') {
          const key = node.alias?.value || node.name.value;
          if (!fields.has(key)) fields.set(key, []);
          fields.get(key).push(node);
        } else if (node.kind === 'InlineFragment') walk(node.selectionSet.selections);
        else if (node.kind === 'FragmentSpread' && !seen.has(node.name.value)) {
          seen.add(node.name.value); walk(this.fragments[node.name.value].selectionSet.selections);
        }
      }
    };
    for (const node of nodes) walk(node.selectionSet?.selections);
    return [...fields].map(([key, group]) => ({ key, name: group[0].name.value, nodes: group }));
  }
  args(type, field) { return getArgumentValues(type.getFields()[field.name], field.nodes[0], this.variables); }
  selection(type, nodes, handler) {
    return this.object(this.fields(nodes).map(field => [field.key, field.name === '__typename' ? literal(type.name) : handler(field, this.args(type, field), getNamedType(type.getFields()[field.name].type))]));
  }
  comparison(expr, input, type, path) {
    const clauses = [];
    for (const [op, value] of Object.entries(input || {})) {
      if (value === null) {
        const scalar = op === '_is_null' ? 'Boolean' : type === 'integer' ? 'Int' : type === 'text' ? 'String' : type === 'boolean' ? 'Boolean' : type;
        throw new ContractError(`unexpected null value for type '${scalar}'`, path + '.' + op);
      }
      if (op === '_is_null') clauses.push(expr + (value ? ' IS NULL' : ' IS NOT NULL'));
      else if (op === '_in' || op === '_nin') clauses.push(value.length ? expr + (op === '_in' ? ' IN (' : ' NOT IN (') + value.map(v => this.param(v, type)).join(',') + ')' : op === '_in' ? 'FALSE' : 'TRUE');
      else if (op === '_cast') clauses.push(this.comparison('(' + expr + ')::text', value.String, 'text', path + '._cast.String'));
      else if (comparisons[op]) {
        const cast = op.startsWith('_has_keys_') ? 'text[]' : op === '_has_key' ? 'text' : op.startsWith('_jsonb_path_') ? 'jsonpath' : type;
        clauses.push(expr + ' ' + comparisons[op] + ' ' + this.param(value, cast));
      } else throw new Error('Unimplemented comparison ' + op);
    }
    return clauses.length ? '(' + clauses.join(' AND ') + ')' : 'TRUE';
  }
  join(relation, parentAlias, targetAlias) { return this.column(relation.table, targetAlias, relation.remote) + ' = ' + quote(parentAlias) + '.' + quote(relation.local); }
  aggregateValue(table, alias, fn, input = {}) {
    if (fn === 'count') {
      const columns = input.columns || input.arguments || [];
      if (!columns.length) return 'count(*)';
      const expressions = columns.map(c => this.column(table, alias, c));
      const argument = expressions.length === 1 ? expressions[0] : '(' + expressions.join(',') + ')';
      // Hasura uses PostgreSQL composite-row semantics for multiple columns:
      // a row containing a null member still contributes to COUNT(row).
      return 'count(' + (input.distinct ? 'DISTINCT ' : '') + argument + ')';
    }
    if (!aggregates.has(fn)) throw new Error('Unimplemented aggregation ' + fn);
    const column = typeof input.arguments === 'string' ? input.arguments : input.column;
    return fn + '(' + (input.distinct ? 'DISTINCT ' : '') + this.column(table, alias, column) + ')';
  }
  where(table, alias, input, path) {
    const clauses = [];
    for (const [key, value] of Object.entries(input || {})) {
      if (key === '_and' || key === '_or') {
        const parts = (value || []).map(v => this.where(table, alias, v, path + '.' + key));
        clauses.push(parts.length ? '(' + parts.join(key === '_and' ? ' AND ' : ' OR ') + ')' : key === '_and' ? 'TRUE' : 'FALSE');
      } else if (key === '_not') clauses.push('NOT (' + this.where(table, alias, value, path + '._not') + ')');
      else if (Object.hasOwn(this.catalog[table].columns, key)) clauses.push(this.comparison(this.column(table, alias, key), value, this.catalog[table].columns[key], path + '.' + key));
      else {
        const aggregate = key.endsWith('_aggregate');
        const relation = this.catalog[table].relations[aggregate ? key.slice(0, -10) : key];
        if (!relation) throw new Error('Unknown relation ' + key);
        const child = this.alias();
        const from = quote(this.catalog[relation.table].sql) + ' ' + quote(child);
        const join = this.join(relation, alias, child);
        if (!aggregate) clauses.push('EXISTS(SELECT 1 FROM ' + from + ' WHERE ' + join + ' AND ' + this.where(relation.table, child, value, path + '.' + key) + ')');
        else for (const [fn, filter] of Object.entries(value || {})) {
          const expr = '(SELECT ' + this.aggregateValue(relation.table, child, fn, filter) + ' FROM ' + from + ' WHERE ' + join + ' AND ' + this.where(relation.table, child, filter.filter, path + '.' + key + '.' + fn + '.filter') + ')';
          clauses.push(this.comparison(expr, filter.predicate, fn === 'count' ? 'integer' : 'boolean', path + '.' + key + '.' + fn + '.predicate'));
        }
      }
    }
    return clauses.length ? '(' + clauses.join(' AND ') + ')' : 'TRUE';
  }
  order(table, alias, items) {
    const parts = [];
    const walk = (target, current, item, wrap = expr => expr) => {
      for (const [field, direction] of Object.entries(item || {})) {
        if (direction == null) continue;
        if (Object.hasOwn(this.catalog[target].columns, field)) {
          const directions = { asc: 'ASC', desc: 'DESC', asc_nulls_first: 'ASC NULLS FIRST', asc_nulls_last: 'ASC NULLS LAST', desc_nulls_first: 'DESC NULLS FIRST', desc_nulls_last: 'DESC NULLS LAST' };
          parts.push({ column: field, simple: target === table && current === alias, sql: wrap(this.column(target, current, field)) + ' ' + directions[direction] });
        } else {
          const aggregate = field.endsWith('_aggregate');
          const relation = this.catalog[target].relations[aggregate ? field.slice(0, -10) : field];
          if (!relation) throw new Error('Unknown order relation ' + field);
          const child = this.alias();
          const subquery = expr => wrap('(SELECT ' + expr + ' FROM ' + quote(this.catalog[relation.table].sql) + ' ' + quote(child) + ' WHERE ' + this.join(relation, current, child) + (aggregate ? '' : ' LIMIT 1') + ')');
          if (!aggregate) walk(relation.table, child, direction, subquery);
          else for (const [fn, columns] of Object.entries(direction)) {
            const add = (expr, dir) => {
              const [order, , nullOrder] = dir.split('_');
              parts.push({ simple: false, sql: subquery(expr) + ' ' + order.toUpperCase() + (nullOrder ? ' NULLS ' + nullOrder.toUpperCase() : '') });
            };
            if (fn === 'count') add('count(*)', columns);
            else for (const [column, dir] of Object.entries(columns || {})) if (dir) add(this.aggregateValue(relation.table, child, fn, { column }), dir);
          }
        }
      }
    };
    for (const item of items || []) walk(table, alias, item);
    return parts;
  }
  rows(table, alias, args, path, join, cap = true) {
    if (args.limit != null && args.limit < 0) throw new ContractError("expected a non-negative 32-bit integer for type 'Int', but found an integer", path + '.limit');
    const orders = this.order(table, alias, args.order_by);
    const distinct = args.distinct_on || [];
    if (distinct.length && orders.length && (orders.slice(0, distinct.length).some(o => !o.simple || !distinct.includes(o.column)) || new Set(orders.slice(0, distinct.length).map(o => o.column)).size !== distinct.length)) throw new ContractError('"distinct_on" columns must match initial "order_by" columns', path);
    const limit = cap ? Math.min(args.limit ?? this.catalog[table].limit, this.catalog[table].limit) : args.limit;
    return 'SELECT ' + (distinct.length ? 'DISTINCT ON (' + distinct.map(c => this.column(table, alias, c)).join(',') + ') ' : '') + quote(alias) + '.* FROM ' + quote(this.catalog[table].sql) + ' ' + quote(alias) + ' WHERE ' + (join ? join + ' AND ' : '') + this.where(table, alias, args.where, path + '.where') + (orders.length ? ' ORDER BY ' + orders.map(o => o.sql).join(',') : '') + (limit != null ? ' LIMIT ' + this.param(limit, 'integer') : '') + (args.offset != null ? ' OFFSET ' + this.param(args.offset, 'integer') : '');
  }
  jsonPath(expr, path, errorPath) {
    if (path == null) return expr;
    const tokens = [];
    let rest = path.replace(/^\$\.?/, '');
    while (rest.length) {
      const match = /^(?:\.?([\w-]+)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\])/.exec(rest);
      if (!match) throw new ContractError(`parse json path error: ${path}. Accept letters, digits, underscore (_) or hyphen (-) only. Use quotes enclosed in bracket (["..."]) if there is any special character`, errorPath);
      tokens.push(match[1] ?? match[2] ?? JSON.parse('"' + match[3] + '"'));
      rest = rest.slice(match[0].length);
    }
    return tokens.length ? '(' + expr + ' #> ' + this.param(tokens, 'text[]') + ')' : expr;
  }
  rowObject(table, alias, type, nodes, path) {
    return this.selection(type, nodes, (field, args, childType) => {
      if (Object.hasOwn(this.catalog[table].columns, field.name)) return this.jsonPath(this.column(table, alias, field.name), args.path, path + '.selectionSet.' + field.key + '.args');
      const aggregate = field.name.endsWith('_aggregate');
      const relation = this.catalog[table].relations[aggregate ? field.name.slice(0, -10) : field.name];
      if (!relation) throw new Error('Unknown selected relation ' + field.name);
      return this.select(relation.table, args, childType, field.nodes, path + '.selectionSet.' + field.key, aggregate, relation.many, relation, alias);
    });
  }
  aggregateObject(table, alias, type, nodes) {
    return this.selection(type, nodes, (field, args, childType) => {
      if (field.name === 'count') return this.aggregateValue(table, alias, 'count', args);
      if (!aggregates.has(field.name)) throw new Error('Unknown aggregate ' + field.name);
      return this.selection(childType, field.nodes, nested => this.aggregateValue(table, alias, field.name, { column: nested.name }));
    });
  }
  select(table, args, type, nodes, path, aggregate = false, many = true, relation, parentAlias) {
    const alias = this.alias();
    const join = relation ? this.join(relation, parentAlias, alias) : null;
    if (aggregate) {
      const rowset = this.alias();
      const selected = this.rows(table, alias, args, path + '.args', join, false);
      return '(WITH ' + quote(rowset) + ' AS MATERIALIZED (' + selected + ') SELECT ' + this.selection(type, nodes, (field, _args, childType) => {
        const item = this.alias();
        if (field.name === 'aggregate') return '(SELECT ' + this.aggregateObject(table, item, childType, field.nodes) + ' FROM ' + quote(rowset) + ' ' + quote(item) + ')';
        if (field.name === 'nodes') {
          const body = this.rowObject(table, item, childType, field.nodes, path + '.selectionSet.' + field.key);
          return "(SELECT coalesce(jsonb_agg(" + body + "),'[]'::jsonb) FROM (SELECT * FROM " + quote(rowset) + ' LIMIT ' + this.catalog[table].limit + ') ' + quote(item) + ')';
        }
        throw new Error('Unknown aggregate field');
      }) + ')';
    }
    const selected = this.rows(table, alias, many ? args : { ...args, limit: 1 }, path + '.args', join);
    const rowAlias = this.alias();
    const body = this.rowObject(table, rowAlias, type, nodes, path);
    return many ? "(SELECT coalesce(jsonb_agg(" + body + "),'[]'::jsonb) FROM (" + selected + ') ' + quote(rowAlias) + ')' : '(SELECT ' + body + ' FROM (' + selected + ') ' + quote(rowAlias) + ')';
  }
  root(info, args) {
    const name = info.fieldName;
    const aggregate = name.endsWith('_aggregate');
    const byPk = name.endsWith('_by_pk');
    const table = aggregate ? name.slice(0, -10) : byPk ? name.slice(0, -6) : name;
    if (!Object.hasOwn(this.catalog, table)) throw new Error('Root table is not public');
    if (byPk) args = { where: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, { _eq: v }])) };
    return this.select(table, args, getNamedType(info.returnType), info.fieldNodes, '$.selectionSet.' + info.path.key, aggregate, !byPk);
  }
}
