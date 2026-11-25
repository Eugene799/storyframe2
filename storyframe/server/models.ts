import type { AiModelInfo } from "../shared/ai-contract";

export const CATALOG_CHECKED_ON = "2026-11-24";
const REQUEST_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,120}$/i;

interface ModelDefinition {
  id: string;
  label: string;
  family: string;
  envVar: string;
  defaultRequestId: string | null;
  catalogStatus: AiModelInfo["catalogStatus"];
  reason?: string;
}

/**
 * Server-side allowlist. Identifiers were verified against the public direct
 * request catalog at https://ollama.com/api/tags on 2026-11-24.
 * The browser can only pick one of these family keys; it can never supply a
 * model id or an upstream URL.
 */
export const MODEL_DEFINITIONS: readonly ModelDefinition[] = [
  {
    id: "deepseek",
    label: "DeepSeek V4.1 Flash",
    family: "deepseek-v4.1-flash",
    envVar: "OLLAMA_MODEL_DEEPSEEK",
    defaultRequestId: "deepseek-v4.1-flash",
    catalogStatus: "listed",
  },
  {
    id: "gemma",
    label: "Gemma 4 31B",
    family: "gemma4",
    envVar: "OLLAMA_MODEL_GEMMA",
    defaultRequestId: "gemma4:31b",
    catalogStatus: "listed",
  },
  {
    id: "glm",
    label: "GLM 5.3 Flash",
    family: "glm-5.3-flash",
    envVar: "OLLAMA_MODEL_GLM",
    defaultRequestId: "glm-5.3-flash",
    catalogStatus: "listed",
  },
  {
    id: "gpt-oss",
    label: "GPT-OSS 20B",
    family: "gpt-oss",
    envVar: "OLLAMA_MODEL_GPT_OSS",
    defaultRequestId: "gpt-oss:20b",
    catalogStatus: "listed",
  },
  {
    id: "minimax",
    label: "MiniMax M3.1 Flash",
    family: "minimax-m3.1-flash",
    envVar: "OLLAMA_MODEL_MINIMAX",
    defaultRequestId: "minimax-m3.1-flash",
    catalogStatus: "listed",
  },
  {
    id: "nemotron",
    label: "Nemotron 3 Nano",
    family: "nemotron-3-nano",
    envVar: "OLLAMA_MODEL_NEMOTRON",
    defaultRequestId: null,
    catalogStatus: "not-listed",
    reason:
      "Not present in the public direct-request catalog (/api/tags) on 2026-11-24. The library advertises nemotron-3-nano:30b-cloud only for a signed-in local Ollama server. Disabled until account-level access is verified; no substitute is configured.",
  },
];

export type ResolvedModel = AiModelInfo;

export function resolveModels(env: NodeJS.ProcessEnv): ResolvedModel[] {
  return MODEL_DEFINITIONS.map((definition) => {
    const base = {
      id: definition.id,
      label: definition.label,
      family: definition.family,
      catalogStatus: definition.catalogStatus,
    };

    if (!definition.defaultRequestId) {
      return {
        ...base,
        requestId: null,
        available: false,
        reason: definition.reason ?? "This model has no verified direct-request identifier.",
      };
    }

    const requestId = env[definition.envVar]?.trim() || definition.defaultRequestId;
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      return {
        ...base,
        requestId: null,
        available: false,
        reason: `${definition.envVar} is not a valid model identifier.`,
      };
    }

    return { ...base, requestId, available: true, reason: null };
  });
}

export function findModel(models: readonly ResolvedModel[], id: string): ResolvedModel | undefined {
  return models.find((model) => model.id === id);
}
