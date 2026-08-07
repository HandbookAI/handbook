/**
 * Build commander options from the registry.
 *
 * Two things this deliberately does NOT do. It sets no commander default: an
 * eagerly-evaluated default captures the shell value at module load, before the
 * preAction hook applies --env-file, which silently ignores the file (the
 * lesson this file now carries forward from the deleted render-refresh.ts
 * `resolveTitle` helper). And it marks nothing mandatory, because --source and
 * --work can now come from env or the config file; the resolver enforces
 * required-ness after all layers have been consulted.
 *
 * One more thing it works around: commander gives a lone `--no-x` flag an
 * implicit default of `true` even when the user never passed it (see
 * commander's `_prepareForParse`, "special default of lone negated option to
 * true"). Left alone, that implicit value would make the resolver's flag layer
 * see the setting as flag-sourced on every run, permanently masking the env
 * var, the config file and the registry's own default. Registering the
 * positive counterpart (hidden — it is not part of the public interface)
 * suppresses that implicit default, per commander's own "lone negated option"
 * check.
 */
import { Option, type Command } from 'commander';
import { availableLanguages, registerBuiltinAdapters } from '@handbook/analyzer';
import { envName, scopedEnvName, settingsFor, type Setting } from '@handbook/core';

function helpText(command: string, setting: Setting): string {
  const parts = [setting.doc];
  if (setting.type === 'enum') {
    const choices =
      setting.dynamicChoices === 'languages' ? languageChoices() : (setting.choices ?? []).join('|');
    parts.push(`(${choices})`);
  }
  parts.push(`[env: ${setting.scopedOnly ? scopedEnvName(command, setting.key) : envName(setting.key)}]`);
  if (setting.default !== undefined) parts.push(`(default: ${String(setting.default)})`);
  return parts.join(' ');
}

/** `auto|<every registered language>` — derived, because the hand-written list drifted. */
function languageChoices(): string {
  registerBuiltinAdapters();
  return ['auto', ...availableLanguages()].join('|');
}

export function addSettings(cmd: Command, command: string): Command {
  for (const setting of settingsFor(command)) {
    if (!setting.flag) continue;
    if (setting.negated) {
      // See the module comment: this hidden positive flag is what stops
      // commander from defaulting the negated flag to `true` on every run.
      cmd.addOption(new Option(setting.flag.replace(/^--no-/, '--')).hideHelp());
    }
    cmd.option(setting.flag, helpText(command, setting));
  }
  return cmd;
}
