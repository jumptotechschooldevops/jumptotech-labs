/**
 * A deliberately small Dockerfile reader.
 *
 * This is **not** a builder and **not** an evaluator. It answers exactly two
 * questions a lab needs to ask about a file the student wrote:
 *
 *   - which instructions are present?
 *   - what does `FROM` name?
 *
 * It does not expand `ARG`, resolve build stages, execute `RUN`, or interpret
 * anything. That matters: the platform must never be the thing that runs a
 * student's file. The student's own `docker build` proves the Dockerfile works,
 * and `docker_image_exists` / `docker_image_config` grade the result — this
 * parser only confirms the file is a Dockerfile that says what the lab asked
 * for, so a student who has not written one yet gets a clear answer instead of
 * a confusing "image not found".
 *
 * Reference: the official Dockerfile reference (docs.docker.com).
 */

/** Instruction keywords the parser recognises. */
export const DOCKERFILE_INSTRUCTIONS = [
  'FROM',
  'RUN',
  'CMD',
  'LABEL',
  'MAINTAINER',
  'EXPOSE',
  'ENV',
  'ADD',
  'COPY',
  'ENTRYPOINT',
  'VOLUME',
  'USER',
  'WORKDIR',
  'ARG',
  'ONBUILD',
  'STOPSIGNAL',
  'HEALTHCHECK',
  'SHELL',
] as const;

export type DockerfileInstruction = (typeof DOCKERFILE_INSTRUCTIONS)[number];

export interface DockerfileLine {
  instruction: DockerfileInstruction;
  /** Everything after the keyword, with continuations joined. */
  argument: string;
}

export interface ParsedDockerfile {
  lines: DockerfileLine[];
  /** Instruction keywords present, in first-appearance order. */
  instructions: DockerfileInstruction[];
  /** Base images named by `FROM`, with any `AS stage` alias stripped. */
  baseImages: string[];
  /** Lines that are not blank, not a comment, and not a known instruction. */
  unknownLines: string[];
}

const INSTRUCTIONS = new Set<string>(DOCKERFILE_INSTRUCTIONS);

/**
 * Parse a Dockerfile into instructions.
 *
 * Handles the two pieces of syntax that would otherwise produce wrong answers:
 * `#` comments (including the parser-directive form at the top) and backslash
 * line continuations, which is how almost every real `RUN` is written.
 */
export function parseDockerfile(text: string): ParsedDockerfile {
  const lines: DockerfileLine[] = [];
  const unknownLines: string[] = [];

  // Join continuations first, so a multi-line RUN is one logical instruction.
  const logical: string[] = [];
  let buffer = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const withoutComment = /^\s*#/.test(line) ? '' : line;
    if (withoutComment.trim().length === 0 && buffer.length === 0) continue;

    if (/\\$/.test(withoutComment)) {
      buffer += `${withoutComment.replace(/\\$/, '')} `;
      continue;
    }
    logical.push((buffer + withoutComment).trim());
    buffer = '';
  }
  if (buffer.trim().length > 0) logical.push(buffer.trim());

  for (const line of logical) {
    if (line.length === 0) continue;
    const match = /^([A-Za-z][A-Za-z0-9_]*)\s+([\s\S]*)$/.exec(line);
    const keyword = match?.[1]?.toUpperCase();
    if (!match || !keyword || !INSTRUCTIONS.has(keyword)) {
      unknownLines.push(line);
      continue;
    }
    lines.push({
      instruction: keyword as DockerfileInstruction,
      argument: (match[2] ?? '').trim(),
    });
  }

  const instructions: DockerfileInstruction[] = [];
  for (const line of lines) {
    if (!instructions.includes(line.instruction)) instructions.push(line.instruction);
  }

  const baseImages = lines
    .filter((line) => line.instruction === 'FROM')
    // `FROM alpine:3.20 AS build` names `alpine:3.20`; `--platform=` is a flag.
    .map(
      (line) =>
        line.argument.split(/\s+/).filter((token) => !token.startsWith('--'))[0] ?? '',
    )
    .filter(Boolean);

  return { lines, instructions, baseImages, unknownLines };
}

/** Does this text look like a Dockerfile at all? */
export function looksLikeDockerfile(parsed: ParsedDockerfile): boolean {
  return parsed.lines.length > 0 && parsed.instructions.includes('FROM');
}
