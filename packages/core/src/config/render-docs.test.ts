import { describe, expect, it } from 'vitest';
import { renderConfigDocs, renderConfigExampleYaml, renderEnvExample } from './render-docs.js';
import { SETTINGS, settingsFor } from './registry.js';
import { envName } from './names.js';

/** `## \`command\`` sections, so a row can be checked against the ONE section it
 *  must appear in — a global substring check would pass even if `renderConfigDocs`
 *  dropped a setting's row from its command's table while the key still appeared
 *  in prose elsewhere on the page. */
function sectionsByCommand(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  const matches = [...text.matchAll(/^## `([a-z]+)`$/gm)];
  for (let i = 0; i < matches.length; i += 1) {
    const command = matches[i]![1] as string;
    const start = matches[i]!.index as number;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index as number) : text.length;
    sections.set(command, text.slice(start, end));
  }
  return sections;
}

describe('renderEnvExample', () => {
  const text = renderEnvExample();

  it('documents every non-secret setting that has a flat env name', () => {
    const missing = SETTINGS.filter((s) => !s.scopedOnly && !text.includes(envName(s.key)));
    expect(missing.map((s) => s.key)).toEqual([]);
  });

  it('keeps the vendor alias for the api key, which existing .env files use', () => {
    expect(text).toContain('OPENAI_API_KEY');
  });

  it('leaves every line commented out, including the api key, so copying it is safe', () => {
    // Regression: an uncommented `OPENAI_API_KEY=sk-...` placeholder used to
    // ship here. Copied to `.env`, it satisfies the client's `if (!apiKey)`
    // guard, trading a clear "no API key" error for a raw 401 from the
    // provider — and an uncommented default would also override a shell
    // value the user already set.
    const assignments = text.split('\n').filter((l) => /^[A-Z]/.test(l));
    expect(assignments).toEqual([]);
  });

  it('says which values are secret and where they may live', () => {
    expect(text).toMatch(/never.*config file/i);
  });
});

describe('renderConfigDocs', () => {
  const text = renderConfigDocs();

  it('has a row for every setting, with its flag and env name', () => {
    for (const s of SETTINGS) {
      expect(text, `missing ${s.key}`).toContain(s.key);
      if (s.flag) expect(text).toContain(s.flag.split(/[ ,]/)[0] as string);
    }
  });

  it('has a real table row — not just a substring match — for every setting, in every command section it belongs to', () => {
    // Regression: `toContain(s.key)` passes on ANY substring, including the key
    // appearing only in another setting's `doc` prose. A dropped table row
    // would sail through that check while this one catches it: the generator
    // and the byte-for-byte drift test both derive from the same function, so
    // a row genuinely missing from `renderConfigDocs` would go undetected by
    // the whole suite without this.
    const sections = sectionsByCommand(text);
    const commands = [...new Set(SETTINGS.flatMap((s) => s.commands))];
    expect([...sections.keys()].sort()).toEqual(commands.sort());
    for (const command of commands) {
      const section = sections.get(command) as string;
      for (const setting of settingsFor(command)) {
        expect(section, `${command}: missing row for ${setting.key}`).toContain(`| \`${setting.key}\` |`);
      }
    }
  });

  it('states the precedence order once, unambiguously', () => {
    expect(text).toMatch(/flag.*shell env.*\.env.*handbook\.config\.yaml.*default/s);
  });
});

describe('renderConfigExampleYaml', () => {
  it('nests the llm group and a command section, and omits secrets', () => {
    const text = renderConfigExampleYaml();
    expect(text).toMatch(/^llm:/m);
    expect(text).toMatch(/^ {2}model:/m);
    expect(text).not.toContain('apiKey');
  });
});
