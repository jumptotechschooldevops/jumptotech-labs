/**
 * The commands a lab tells the student to type work in the shell they get.
 *
 * A container lab's terminal is `docker exec --user student … bash --norc
 * --noprofile` (services/terminal/src/spawn-plan.ts): uid 1001, no effective
 * capabilities, passwordless sudo, and no startup files read. The 2026-09-20
 * certification pass found four labs whose instructions assumed otherwise,
 * each measured in the lab-linux image:
 *
 *   - `sv restart …` / `sv status …` without sudo — runit's supervise
 *     directories are root's (NET-006, NET-007);
 *   - `tcpdump -i …` without sudo — the sandbox's NET_RAW is in the bounding
 *     set only, and tcpdump carries no file capability (NET-008);
 *   - `ping` in a lab that grants no NET_RAW — ping's file capability then
 *     cannot be used and exec fails (NET-003);
 *   - a seed that configures ~/.bashrc, with a task that never has the
 *     student read it (LINUX-014).
 *
 * This scans every container lab's student-facing text — task, hints and the
 * seeded text files — so the next lab written the same way fails here rather
 * than in front of a student.
 */
import { describe, expect, it } from 'vitest';
import { loadSeedScripts, loadSetupFiles, type LoadedLabDefinition } from '../src/index.js';
import { realCatalog } from './real-catalog.js';

/** Providers whose student shell is a `docker exec --user student` into the sandbox. */
const STUDENT_SHELL_PROVIDERS = new Set(['linux', 'terraform', 'cicd']);

async function studentText(lab: LoadedLabDefinition): Promise<string> {
  const parts = [lab.task.summary, lab.task.description, ...lab.hints.map((h) => h.text)];
  for (const file of await loadSetupFiles(lab)) {
    if (/\.(txt|md)$/.test(file.path)) parts.push(file.content.toString());
  }
  return parts.join('\n');
}

/** Each match of `pattern` not directly preceded by `sudo `. */
function withoutSudo(text: string, pattern: RegExp): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(Math.max(0, match.index! - 5), match.index!);
    if (!/sudo\s$/.test(before)) found.push(match[0].trim());
  }
  return found;
}

describe('container labs tell the student what the shell needs', () => {
  it('uses sudo for the runit supervisor and for packet capture, and ping only where it can run', async () => {
    const registry = await realCatalog();
    const problems: string[] = [];
    for (const summary of registry.all()) {
      const lab = registry.get(summary.id);
      if (!STUDENT_SHELL_PROVIDERS.has(lab.environment.provider)) continue;
      const text = await studentText(lab);

      for (const found of withoutSudo(text, /\bsv\s+(?:restart|status|up|down|stop|start|once|term|kill)\b/g)) {
        problems.push(`${lab.id}: \`${found}\` needs sudo — runit's supervise directories belong to root`);
      }
      for (const found of withoutSudo(text, /\btcpdump\b[^`\n]*/g)) {
        // Reading a saved capture needs no privilege; capturing does.
        if (/\s-r\s/.test(` ${found} `) || !/\s-(?:i|w)\b/.test(` ${found}`)) continue;
        problems.push(`${lab.id}: \`${found}\` needs sudo — the student shell has no effective capabilities`);
      }
      if (!lab.environment.sandbox_capabilities.includes('NET_RAW') && /`ping\s+[-\w]/.test(text)) {
        problems.push(`${lab.id}: tells the student to run ping, which cannot run without NET_RAW`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('has the student read any startup file its seed configures', async () => {
    const registry = await realCatalog();
    const problems: string[] = [];
    for (const summary of registry.all()) {
      const lab = registry.get(summary.id);
      if (!STUDENT_SHELL_PROVIDERS.has(lab.environment.provider)) continue;
      for (const seed of await loadSeedScripts(lab)) {
        const configures = /(?:>>?|tee(?:\s+-a)?)\s+\/home\/student\/\.(bashrc|profile|bash_profile)\b/.exec(seed.content);
        if (!configures) continue;
        const file = `~/.${configures[1]}`;
        const told = new RegExp(`(?:source|\\.)\\s+${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(lab.task.description);
        if (!told) {
          problems.push(`${lab.id}: the seed writes ${file}, which the terminal (bash --norc --noprofile) never reads, and the task does not say to source it`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('worksheets graded by key ask each question once', () => {
  it('never repeats a graded key in the template the lab seeds', async () => {
    // NET-002's plan.txt repeated `broadcast = ` in four blocks, so its
    // answers could only be substring-matched and were swappable between
    // blocks. A key a check reads must appear once in the seeded template.
    const registry = await realCatalog();
    const problems: string[] = [];
    for (const summary of registry.all()) {
      const lab = registry.get(summary.id);
      const seeded = new Map<string, string>();
      for (const file of await loadSetupFiles(lab)) {
        seeded.set(file.path, file.content.toString());
        seeded.set(file.path.replace(/^\/home\/student\//, ''), file.content.toString());
      }
      for (const requirement of lab.requirements) {
        const graded: Array<{ path: string; key: string; separator: string }> = [];
        if (requirement.type === 'file_key_value') {
          graded.push({ path: requirement.path, key: requirement.key, separator: requirement.separator });
        }
        if (requirement.type === 'workspace_file_exists' && requirement.key_values) {
          for (const key of Object.keys(requirement.key_values)) {
            graded.push({ path: requirement.path, key, separator: requirement.separator ?? '=' });
          }
        }
        for (const { path, key, separator } of graded) {
          const template = seeded.get(path) ?? seeded.get(path.replace(/^\/home\/student\//, ''));
          if (template === undefined) continue;
          const lines = template.split('\n').filter((raw) => {
            const line = raw.trim();
            if (line.startsWith('#')) return false;
            const at = line.indexOf(separator);
            return at > 0 && line.slice(0, at).trim().replace(/^export\s+/, '') === key;
          });
          if (lines.length > 1) problems.push(`${lab.id}: ${path} asks for '${key}' ${lines.length} times`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
