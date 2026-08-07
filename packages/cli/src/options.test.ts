import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { resolveConfig, settingsFor } from '@handbook/core';
import { addSettings } from './options.js';

describe('addSettings', () => {
  it('adds one commander option per flag-bearing setting', () => {
    const cmd = addSettings(new Command('generate'), 'generate');
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain('--read-workers');
    expect(flags).toContain('--model'); // did not exist before
    expect(flags).toContain('--assign-workers'); // reachable from nothing before
  });

  it('never adds a flag for a secret', () => {
    const cmd = addSettings(new Command('generate'), 'generate');
    expect(cmd.options.map((o) => o.long)).not.toContain('--api-key');
  });

  it('sets no commander default, so the resolver owns every default', () => {
    // Regression (render-refresh.ts:19): an eager default captures the shell
    // value at module load, before --env-file is applied, silently ignoring it.
    const cmd = addSettings(new Command('generate'), 'generate');
    for (const option of cmd.options) {
      expect(option.defaultValue, `${option.long} carries a commander default`).toBeUndefined();
    }
  });

  it('marks nothing required, because env and the config file can supply it', () => {
    const cmd = addSettings(new Command('analyze'), 'analyze');
    expect(cmd.options.filter((o) => o.required && o.mandatory).map((o) => o.long)).toEqual([]);
  });

  it('puts the setting doc into the help text', () => {
    const cmd = addSettings(new Command('generate'), 'generate');
    const workers = cmd.options.find((o) => o.long === '--read-workers');
    expect(workers?.description).toContain('concurrent card batches');
    expect(workers?.description).toContain('HANDBOOK_READ_WORKERS');
  });

  it('resolves --lang choices from the adapter registry, not a hand-written list', () => {
    // The hand-written help string had drifted five languages behind.
    const cmd = addSettings(new Command('analyze'), 'analyze');
    const lang = cmd.options.find((o) => o.long === '--lang');
    expect(lang?.description).toContain('auto');
    expect(lang?.description).toContain('python');
    expect(lang?.description).toContain('solidity');
  });

  it('covers every flag the registry declares for the command', () => {
    const cmd = addSettings(new Command('resync'), 'resync');
    const declared = settingsFor('resync')
      .filter((s) => s.flag)
      .map((s) => s.flag?.split(/[ ,]/)[0]);
    for (const flag of declared) expect(cmd.options.map((o) => o.long)).toContain(flag);
  });

  describe('negated flags (--no-llm, --no-render)', () => {
    // THE TRAP: commander gives a lone `--no-x` an implicit default of `true`
    // even when the user never passed the flag (see command.js's
    // `_prepareForParse`, "Do the special default of lone negated option to
    // true"). That implicit value would make the resolver's flag layer see
    // `useLlm` as flag-sourced on every single run, permanently masking the
    // env var, the config file, and the registry's own default. Registering
    // the positive counterpart (`--llm`, hidden) is what suppresses that
    // implicit default — commander skips it once a `--foo` option exists
    // alongside `--no-foo`.
    it('does not carry the implicit commander default on the Option itself', () => {
      const cmd = addSettings(new Command('resync'), 'resync');
      const noLlm = cmd.options.find((o) => o.long === '--no-llm');
      expect(noLlm?.defaultValue).toBeUndefined();
    });

    it('resolves from the registry default (not the flag layer) when no flag is passed', () => {
      const cmd = addSettings(new Command('resync'), 'resync');
      cmd.parse(['--case', '/c', '--work', '/w'], { from: 'user' });
      const result = resolveConfig({ command: 'resync', flags: cmd.opts(), env: {} });
      expect(result.values.useLlm).toBe(true);
      expect(result.sources.useLlm).toEqual({ kind: 'default' });
    });

    it('resolves false from the flag layer when --no-llm is passed', () => {
      const cmd = addSettings(new Command('resync'), 'resync');
      cmd.parse(['--case', '/c', '--work', '/w', '--no-llm'], { from: 'user' });
      const result = resolveConfig({ command: 'resync', flags: cmd.opts(), env: {} });
      expect(result.values.useLlm).toBe(false);
      expect(result.sources.useLlm).toEqual({ kind: 'flag', name: '--no-llm' });
    });

    it('lets HANDBOOK_RESYNC_USE_LLM win when no flag is passed', () => {
      const cmd = addSettings(new Command('resync'), 'resync');
      cmd.parse(['--case', '/c', '--work', '/w'], { from: 'user' });
      const result = resolveConfig({
        command: 'resync',
        flags: cmd.opts(),
        env: { HANDBOOK_RESYNC_USE_LLM: 'false' },
      });
      expect(result.values.useLlm).toBe(false);
      expect(result.sources.useLlm).toEqual({ kind: 'env', name: 'HANDBOOK_RESYNC_USE_LLM' });
    });
  });
});
