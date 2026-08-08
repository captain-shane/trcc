// Central runtime configuration. Everything comes from the environment with
// local-first defaults. No secrets live here — local model servers are
// unauthenticated and the app itself has no auth (the network is the
// boundary; never expose it directly to the internet).

export const config = {
  port: Number(process.env.PORT ?? 3000),

  // SQLite database file. In Docker this lives on the named volume.
  dbPath: process.env.DB_PATH ?? 'data/trr.db',

  // The ONLY external endpoint this server ever talks to: a local model
  // server — Ollama, LM Studio, llama.cpp, vLLM, or any OpenAI-compatible
  // endpoint. AI_URL preferred; OLLAMA_URL kept as a legacy alias.
  aiUrl: process.env.AI_URL ?? process.env.OLLAMA_URL ?? 'http://localhost:11434',

  // Fast model for per-note exec summaries; quality model for digests.
  // Both overridable at runtime via settings.
  defaultModel: process.env.AI_MODEL ?? 'gemma4-16k:latest',
  defaultDigestModel: process.env.AI_DIGEST_MODEL ?? 'gemma4:26b',
  defaultEmbedModel: process.env.AI_EMBED_MODEL ?? 'nomic-embed-text',
} as const;

// Single source of truth for the build identity: package.json. /healthz used to
// carry a hardcoded '2.0.0' string that went stale the moment the version moved,
// which is precisely the failure this is meant to prevent.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const _pkgDir = dirname(fileURLToPath(import.meta.url));
export const APP_VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(join(_pkgDir, '..', 'package.json'), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();
