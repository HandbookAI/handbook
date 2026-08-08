import { describe, expect, it } from 'vitest';
import { SETTINGS, settingsFor, settingByKey } from './registry.js';
import { envName, scopedEnvName } from './names.js';
import { PIPELINE_DEFAULTS } from './defaults.js';
import { LOG_LEVELS } from '../logger.js';

describe('registry integrity', () => {
  // Each of these is a declaration mistake that would otherwise surface as a
  // confusing runtime failure or a silently unreachable setting.
  it('has no duplicate keys', () => {
    const keys = SETTINGS.map((s) => s.key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it('gives every int a min and every enum its choices', () => {
    expect(SETTINGS.filter((s) => s.type === 'int' && s.min === undefined).map((s) => s.key)).toEqual([]);
    // `dynamicChoices` entries carry only a fallback `choices` (e.g. `lang`'s
    // `['auto']`); their real choices come from a runtime registry, so they are
    // exempt from this check.
    expect(
      SETTINGS.filter((s) => s.type === 'enum' && !s.dynamicChoices && !s.choices?.length).map((s) => s.key),
    ).toEqual([]);
  });

  it('keeps an enum default inside its own choices', () => {
    const bad = SETTINGS.filter(
      (s) => s.type === 'enum' && s.default !== undefined && !s.choices?.includes(String(s.default)),
    );
    expect(bad.map((s) => s.key)).toEqual([]);
  });

  it('never puts a secret on the command line', () => {
    // A flag would put the key in shell history and in `ps` output.
    expect(SETTINGS.filter((s) => s.secret && s.flag).map((s) => s.key)).toEqual([]);
  });

  it('declares at least one command per setting', () => {
    expect(SETTINGS.filter((s) => s.commands.length === 0).map((s) => s.key)).toEqual([]);
  });

  it('has no flag collision within any one command', () => {
    for (const command of [...new Set(SETTINGS.flatMap((s) => s.commands))]) {
      const flags = settingsFor(command)
        .map((s) => s.flag?.split(/[ ,]/)[0])
        .filter((f): f is string => Boolean(f));
      expect(
        flags.filter((f, i) => flags.indexOf(f) !== i),
        `command ${command}`,
      ).toEqual([]);
    }
  });

  it('has no env-name collision across the whole table', () => {
    const names = SETTINGS.flatMap((s) => [
      ...(s.scopedOnly ? [] : [envName(s.key)]),
      ...s.commands.map((c) => scopedEnvName(c, s.key)),
      ...(s.envAliases ?? []),
    ]);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });

  it('exposes the vendor env aliases the toolchain already documented', () => {
    // These are load-bearing: existing .env files and both READMEs use them.
    expect(settingByKey('llmApiKey')?.envAliases).toContain('OPENAI_API_KEY');
    expect(settingByKey('llmModel')?.envAliases).toContain('OPENAI_MODEL');
    expect(settingByKey('llmBaseUrl')?.envAliases).toContain('OPENAI_BASE_URL');
  });

  it('never derives a doubled scoped env name', () => {
    // `rollbackSource` on the rollback command produced
    // HANDBOOK_ROLLBACK_ROLLBACK_SOURCE. When a key already carries its
    // command, the scoped name repeats it.
    const doubled = SETTINGS.flatMap((s) =>
      s.commands
        .filter((c) => s.key.toLowerCase().startsWith(c.toLowerCase()))
        .map((c) => `${s.key} on ${c}`),
    );
    expect(doubled).toEqual([]);
  });

  it('accepts every level the logger implements, not a narrower hand-picked set', () => {
    // Regression: `choices` used to be a hand-typed `['debug','info','error']`,
    // so HANDBOOK_LOG_LEVEL=warn — a level `createLogger` has always handled —
    // was rejected by the resolver for no reason but an incomplete list here.
    // Declared by reference now, so this test would only fail if the registry
    // stopped pointing at `LOG_LEVELS` — not a duplicate list of its own.
    expect(settingByKey('logLevel')?.choices).toBe(LOG_LEVELS);
  });
});

describe('registry agrees with the pipeline defaults', () => {
  // If these drifted, the generated docs would promise a number the pipeline
  // does not use.
  it('declares the tuning defaults by reference, not by copy', () => {
    expect(settingByKey('readWorkers')?.default).toBe(PIPELINE_DEFAULTS.readWorkers);
    expect(settingByKey('assignBatchSize')?.default).toBe(PIPELINE_DEFAULTS.assignBatchSize);
    expect(settingByKey('assignWorkers')?.default).toBe(PIPELINE_DEFAULTS.assignWorkers);
    expect(settingByKey('organizeWorkers')?.default).toBe(PIPELINE_DEFAULTS.organizeWorkers);
    expect(settingByKey('narrateWorkers')?.default).toBe(PIPELINE_DEFAULTS.narrateWorkers);
    expect(settingByKey('maxDoctorRounds')?.default).toBe(PIPELINE_DEFAULTS.maxDoctorRounds);
    expect(settingByKey('maxCharsPerFile')?.default).toBe(PIPELINE_DEFAULTS.maxCharsPerFile);
    expect(settingByKey('detail')?.default).toBe(PIPELINE_DEFAULTS.detail);
    expect(settingByKey('narrateLang')?.default).toBe(PIPELINE_DEFAULTS.narrateLang);
    expect(settingByKey('synthMode')?.default).toBe(PIPELINE_DEFAULTS.synthMode);
  });

  it('leaves readBatchSize a pass-through, because its default depends on --detail', () => {
    expect(settingByKey('readBatchSize')?.default).toBeUndefined();
  });

  it('leaves resync prose language and card detail as pass-throughs', () => {
    // A default here would silently narrate a Chinese handbook in English:
    // resync falls back to the language recorded in the existing handbook.
    expect(settingByKey('proseLang')?.default).toBeUndefined();
    expect(settingByKey('cardDetail')?.default).toBeUndefined();
    expect(settingByKey('narrateLang')?.commands).toEqual(['generate']);
  });

  it("pins resync's scoped-only env names, which the design spec once stated differently", () => {
    // The design doc originally promised HANDBOOK_RESYNC_DETAIL — but `detail`
    // already belongs to generate with a different default semantics
    // (registry default vs. "match the existing handbook"), so resync got its
    // own keys instead (see the spec's amendment). Pinned here so neither can
    // drift again without the spec and this test being updated together.
    expect(settingByKey('cardDetail')?.scopedOnly).toBe(true);
    expect(scopedEnvName('resync', settingByKey('cardDetail')!.key)).toBe('HANDBOOK_RESYNC_CARD_DETAIL');
    expect(settingByKey('proseLang')?.scopedOnly).toBe(true);
    expect(scopedEnvName('resync', settingByKey('proseLang')!.key)).toBe('HANDBOOK_RESYNC_PROSE_LANG');
  });
});

describe('every command the CLI ships is represented', () => {
  it('covers all eleven subcommands plus config', () => {
    const commands = new Set(SETTINGS.flatMap((s) => s.commands));
    for (const c of [
      'analyze',
      'generate',
      'render',
      'skill',
      'validate',
      'plan',
      'apply',
      'rollback',
      'resync',
      'studio',
      'config',
    ]) {
      expect([...commands], `missing ${c}`).toContain(c);
    }
  });
});

describe('studio host setting', () => {
  it('defaults studio to loopback, and keeps it configurable', () => {
    // Containers need 0.0.0.0; everyone else must stay on loopback by default.
    const host = settingByKey('host');
    expect(host?.default).toBe('127.0.0.1');
    expect(host?.commands).toEqual(['studio']);
    expect(host?.flag).toBe('--host <addr>');
  });
});

describe('settingsFor', () => {
  it('returns only the settings that declare the command', () => {
    expect(settingsFor('generate').every((s) => s.commands.includes('generate'))).toBe(true);
  });

  it('is empty for an unknown command rather than throwing', () => {
    expect(settingsFor('nope')).toEqual([]);
  });
});
