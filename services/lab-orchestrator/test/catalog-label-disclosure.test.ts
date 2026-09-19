/**
 * No check label hands over the answer it grades.
 *
 * A label is shown next to every check on every press of Check Solution, before
 * the student has solved anything. A worksheet or findings answer that appears
 * in a label is therefore free. The networking track has had this rule since it
 * shipped (`networking-labs.test.ts`); this holds every track to it, because a
 * catalog-wide scan found the same leak in CS-010 ("…does not become false").
 *
 * What counts as an answer: the value a worksheet key must equal
 * (`file_key_value`), and the text a file must contain or equal
 * (`file_content`, `file_contains`, `workspace_file_exists`). What is exempt:
 *
 *   - a value the task, summary or story states — the student was told it;
 *   - for *another* check's label, a value printed in a seeded file (the
 *     worksheet's own allowed values, a block it gives);
 *   - values shorter than three characters, which match inside ordinary words.
 *
 * A requirement's own label may never name its answer unless the task states
 * it: that pairs the question with the value.
 */
import { describe, expect, it } from 'vitest';
import { loadSetupFiles, type LoadedLabDefinition } from '../src/index.js';
import { realCatalog } from './real-catalog.js';

/**
 * Deliberate, reviewed exceptions: the label names a literal the check needs
 * that is not an answer the student works out.
 */
const ALLOWED: Record<string, readonly string[]> = {
  // `df`'s column heading, checked to prove real output was captured.
  'LINUX-008': ['Filesystem'],
};

function answersOf(requirement: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(push);
  };
  switch (requirement.type) {
    case 'file_key_value':
      push(requirement.equals);
      break;
    case 'file_content':
      push(requirement.contains);
      push(requirement.equals);
      break;
    case 'file_contains':
    case 'workspace_file_exists':
      push(requirement.contains);
      break;
    default:
      break;
  }
  return out.filter((value) => value.trim().length >= 3);
}

function namedIn(label: string | undefined, value: string): boolean {
  if (!label) return false;
  const escaped = value.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}($|[^A-Za-z0-9_])`).test(label);
}

async function seededText(lab: LoadedLabDefinition): Promise<string> {
  return (await loadSetupFiles(lab)).map((file) => file.content.toString()).join('\n');
}

describe('check labels across the catalog', () => {
  it('never name the answer a check grades', async () => {
    const registry = await realCatalog();
    const leaks: string[] = [];

    for (const lab of registry.all()) {
      const stated = `${lab.task.summary}\n${lab.task.description}\n${lab.story ?? ''}`;
      const seeded = await seededText(lab);
      const allowed = new Set(ALLOWED[lab.id] ?? []);
      const requirements = lab.requirements as ReadonlyArray<Record<string, unknown> & { label?: string }>;

      for (const requirement of requirements) {
        for (const answer of answersOf(requirement)) {
          if (allowed.has(answer) || stated.includes(answer)) continue;
          for (const other of requirements) {
            if (other !== requirement && seeded.includes(answer)) continue;
            if (namedIn(other.label, answer)) {
              leaks.push(`${lab.id}: label '${other.label}' names '${answer}'`);
            }
          }
        }
      }
    }

    expect(leaks).toEqual([]);
  });

  it('would catch a label that states its own answer', async () => {
    const registry = await realCatalog();
    const lab = registry.get('CS-010');
    const requirement = (lab.requirements as ReadonlyArray<Record<string, unknown>>).find(
      (r) => r.type === 'file_key_value' && r.key === 'COUNTRY_BECAME',
    );
    expect(requirement).toBeDefined();
    const answer = answersOf(requirement!)[0]!;
    expect(namedIn('The country is quoted, so it does not become false', answer)).toBe(true);
    expect(namedIn('The leeds country is quoted, so it stays the country code it was meant to be', answer)).toBe(false);
  });
});
