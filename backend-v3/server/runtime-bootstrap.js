import { realpath } from 'node:fs/promises';
import { isAbsolute, parse } from 'node:path';
import { pathToFileURL } from 'node:url';

const ALLOWED_RUNTIME_OPTION_KEYS = Object.freeze(
  new Set([
    'adapters',
    'rules',
    'ruleRegistry',
    'verifiedLocationMappings',
    'runtimeStatus',
    'soilContract',
    'knowledgePassages',
    'knowledgeImages',
  ]),
);

export function validateRuntimeOptions(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError('trusted runtime factory must return a plain object');
  }
  const unknownKeys = Object.keys(value).filter(
    (key) => !ALLOWED_RUNTIME_OPTION_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    throw new TypeError(
      `trusted runtime factory returned unsupported options: ${unknownKeys.join(', ')}`,
    );
  }
  return value;
}

/**
 * Loads operator-owned composition only when an absolute local module path is
 * explicitly configured. The module is trusted application code, not request
 * data. This gives the documented npm start path a way to supply reviewed
 * rules, mappings, climate snapshots, and ASOS adapters without weakening the
 * default HOLD state or guessing an unverified provider contract.
 */
export async function loadRuntimeOptions({
  env = process.env,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) {
  const configuredPath =
    typeof env.TRUSTED_BACKEND_RUNTIME_MODULE === 'string'
      ? env.TRUSTED_BACKEND_RUNTIME_MODULE.trim()
      : '';
  if (!configuredPath) return {};
  if (!isAbsolute(configuredPath)) {
    throw new TypeError(
      'TRUSTED_BACKEND_RUNTIME_MODULE must be an absolute local path',
    );
  }
  const extension = parse(configuredPath).ext.toLowerCase();
  if (!['.js', '.mjs'].includes(extension)) {
    throw new TypeError(
      'TRUSTED_BACKEND_RUNTIME_MODULE must point to a .js or .mjs file',
    );
  }

  const canonicalPath = await realpath(configuredPath);
  const runtimeModule = await import(pathToFileURL(canonicalPath).href);
  if (typeof runtimeModule.createRuntimeOptions !== 'function') {
    throw new TypeError(
      'trusted runtime module must export createRuntimeOptions',
    );
  }
  const options = await runtimeModule.createRuntimeOptions({
    env,
    fetchImpl,
    clock,
  });
  return validateRuntimeOptions(options);
}
