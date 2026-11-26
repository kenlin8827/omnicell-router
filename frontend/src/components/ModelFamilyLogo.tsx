/**
 * Model-family badge for local (GGUF) model rows.
 *
 * NOT a provider logo: a Qwen checkpoint is not "Alibaba", a Gemma file is
 * not "Google" — mapping a model family onto its parent company's brand mark
 * mislabels the row. So the badge is honest instead: it extracts the family
 * NAME from the row's identity (filename first, then repo, then the GGUF
 * header name/arch) and shows that name's initial on the same light plate
 * the provider chips use. Unrecognised names fall back to the filename's
 * first letter — still the row's own identity, never a borrowed brand.
 *
 * The family list is a display hint only; a miss costs nothing (the letter
 * is the same one the row already shows in its label).
 */
import React from 'react';

/** Ordered (pattern → display family) table; first match wins. */
const FAMILY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bdeepseek|\bdsv\b/i, 'DeepSeek'],
  [/\bqwen|qwq\b/i, 'Qwen'],
  [/\bllama/i, 'Llama'],
  [/\bgemma/i, 'Gemma'],
  [/\bchatglm|\bglm\b/i, 'GLM'],
  [/\bkimi|\bmoonshot/i, 'Kimi'],
  [/\bmistral|mixtral|magistral|codestral|devstral/i, 'Mistral'],
  [/\bminimax/i, 'MiniMax'],
  [/\bgpt[-_.]?oss/i, 'GPT-OSS'],
  [/\bgpt[-_.]?4/i, 'GPT'],
  [/\bgrok/i, 'Grok'],
  [/\bcommand|\bc4ai/i, 'Command'],
  [/\bphi[-_.]?\d|phimoe/i, 'Phi'],
  [/\binternlm/i, 'InternLM'],
  [/\bernie/i, 'ERNIE'],
  [/\bhunyuan/i, 'Hunyuan'],
  [/\bdoubao/i, 'Doubao'],
  [/\bnemotron/i, 'Nemotron'],
  [/\bolmo/i, 'OLMo'],
  [/\bfalcon/i, 'Falcon'],
  [/\bgranite/i, 'Granite'],
  [/\bexaone/i, 'EXAONE'],
  [/\bnova\b/i, 'Nova'],
];

/** GGUF `general.architecture` → family display name. */
const ARCH_FAMILY: Readonly<Record<string, string>> = {
  qwen2: 'Qwen',
  qwen3: 'Qwen',
  qwen3moe: 'Qwen',
  qwen2moe: 'Qwen',
  llama: 'Llama',
  llama4: 'Llama',
  gemma: 'Gemma',
  gemma2: 'Gemma',
  gemma3: 'Gemma',
  gemma3n: 'Gemma',
  deepseek: 'DeepSeek',
  deepseek2: 'DeepSeek',
  chatglm: 'GLM',
  glm4: 'GLM',
  glm4moe: 'GLM',
  kimi: 'Kimi',
  kimilk: 'Kimi',
  mistral: 'Mistral',
  mixtral: 'Mistral',
  cohere: 'Command',
};

/**
 * Display family for one row: name patterns first (the filename is the
 * strongest signal), GGUF arch as fallback, then null — the caller initials
 * the filename instead.
 */
export function modelFamily(parts: {
  repo?: string;
  filename?: string;
  metaName?: string;
  metaArch?: string;
}): string | null {
  const haystack = [parts.filename, parts.repo, parts.metaName].filter(Boolean).join(' ');
  for (const [pattern, family] of FAMILY_PATTERNS) {
    if (pattern.test(haystack)) return family;
  }
  if (parts.metaArch) {
    const family = ARCH_FAMILY[parts.metaArch.toLowerCase()];
    if (family) return family;
  }
  return null;
}

interface ModelFamilyLogoProps {
  repo?: string;
  filename?: string;
  metaName?: string;
  metaArch?: string;
  size?: number;
}

/** Letter plate — the family's own initial, not a parent-company brand. */
export const ModelFamilyLogo: React.FC<ModelFamilyLogoProps> = ({ repo, filename, metaName, metaArch, size = 24 }) => {
  const family = modelFamily({ repo, filename, metaName, metaArch });
  const letter = (family || (filename || repo || 'M').replace(/^local-import\//i, '')).charAt(0).toUpperCase();
  const title = family ?? (filename || repo || '');
  return (
    <span
      aria-label={title}
      title={title}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(6, Math.round(size * 0.28)),
        background: 'var(--logo-plate-bg)',
        border: '1px solid var(--card-border)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        fontSize: Math.round(size * 0.55),
        fontWeight: 'var(--font-bold)',
        color: 'var(--logo-plate-ink)',
        lineHeight: 'var(--leading-none)',
        userSelect: 'none',
      }}
    >
      {letter}
    </span>
  );
};
