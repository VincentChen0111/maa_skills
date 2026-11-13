/**
 * The shared check library used by setup and doctor. A check row names its state with a reason code;
 * the message and the repair (its executor, and for a skill repair the existing channel that performs
 * it) come from the tables below, so setup and doctor cannot drift apart. Messages hold no value,
 * path, address or identifier.
 */
export type CheckStatus = 'normal' | 'warning' | 'error';
export type Repair = { id: string; executor: 'skill' | 'user'; description: string; channel?: string };
export type CheckResult = { id: string; status: CheckStatus; reason: string; repair: Repair };
export type LibraryCheck = CheckResult & { message: string; details?: string[] };

/** The eight doctor check groups (spec 「检查与修法」); MAA-internal problems are referred, not checked. */
export const checkGroups = ['installation', 'connection', 'configuration', 'write-lock', 'credentials', 'private-files', 'skill-version', 'skill-links'] as const;
export type CheckGroup = typeof checkGroups[number];
const groupOfCheck: Record<string, CheckGroup> = {
  platform: 'installation', maa: 'installation', server: 'installation', node: 'installation', settings: 'installation', 'private-directory': 'installation', version: 'installation',
  connection: 'connection',
  configuration: 'configuration', 'configuration-fields': 'configuration', 'remote-control': 'configuration',
  'write-lock': 'write-lock',
  'credential-nga': 'credentials', 'credential-skland': 'credentials', 'credential-bilibili': 'credentials',
  'private-files': 'private-files',
  'skill-version': 'skill-version',
  'skill-links': 'skill-links',
};
export function groupOf(id: string): CheckGroup {
  const group = groupOfCheck[id];
  if (!group) throw new Error('check-group-unknown');
  return group;
}
/** Every check id the shared checks produce; a new id must be added here and classified in `purposeRules`. */
export const knownCheckIds: readonly string[] = Object.freeze(Object.keys(groupOfCheck));

/**
 * The consumers of check results, each deciding through `blockingChecks`. Only an error ever blocks. An `every-error`
 * purpose counts every error. Otherwise every check id is classified as blocking or not relevant, and an id in neither
 * list (a new or unknown check) blocks until it is classified: fail closed. Reasons: spec 「默认值及其来源」, 2026-11-14.
 */
export const checkPurposes = ['doctor-exit', 'setup-exit', 'credentials-exit', 'stage-retry'] as const;
export type CheckPurpose = typeof checkPurposes[number];
export type PurposeRule = 'every-error' | { blocks: readonly string[]; notRelevant: readonly string[] };
export const purposeRules: Readonly<Record<CheckPurpose, PurposeRule>> = Object.freeze({
  // Exit codes: 1 means "there is an error" (spec 「检查与修法」), so every error counts.
  'doctor-exit': 'every-error',
  'setup-exit': 'every-error',
  'credentials-exit': 'every-error',
  // Retrying or switching a stage run after an environment failure (ticket 16): what MAA needs to run the approved list
  // again under the approval, on top of the verification's own process, list and job-file checks.
  'stage-retry': Object.freeze({
    blocks: Object.freeze([
      'maa', 'server', // the MAA installation and current profile the batch was prepared in, on the CN client it was approved for
      'settings', 'private-directory', // where the MAA directory, the run records and the approved job files are found
      'connection', // adb lists the device offline or unauthorized, or the configured adb is missing
      'configuration', 'configuration-fields', 'remote-control', // MAA's configuration, its task, medicine and timer fields, remote tasks
      'write-lock', // a configuration write whose result is not reconciled
    ]),
    notRelevant: Object.freeze([
      'platform', // only Windows can show MAA running, which the verification already requires
      'node', // runs only this project's scripts; MAA does not use it
      'version', // MAA version reminders only warn (spec 「检查与修法」)
      'credential-nga', 'credential-skland', 'credential-bilibili', // used only by research and the account snapshot
      'private-files', // other records; the batch's own preparation and job files are verified directly
      'skill-version', 'skill-links', // the host's copies of these skills; MAA runs without them
    ]),
  }),
});

/**
 * The one predicate for "which check results block this purpose": ids of the error checks that block it, and of the
 * errors that do not (still reported to the user). Warnings and normal results never block.
 */
export function blockingChecks(checks: readonly Pick<CheckResult, 'id' | 'status'>[], purpose: CheckPurpose): { blocking: string[]; notBlocking: string[] } {
  const rule = Object.hasOwn(purposeRules, purpose) ? purposeRules[purpose] : undefined;
  if (!rule) throw new Error('check-purpose-unknown');
  const errors = checks.filter(check => check.status === 'error').map(check => check.id);
  const blocks = (id: string) => rule === 'every-error' || !rule.notRelevant.includes(id);
  return { blocking: errors.filter(blocks), notBlocking: errors.filter(id => !blocks(id)) };
}

export const checkMessages: Record<string, string> = {
  windows: 'The host is Windows.', 'windows-required': 'This workflow requires Windows.',
  'maa-gui-missing': 'The selected MAA GUI executable is missing.', 'maa-configuration-unreadable': 'The current MAA GUI configuration could not be read.', 'maa-gui-present': 'The MAA GUI executable and current configuration are present.',
  'cn-client': 'The current MAA profile selects a CN client.', 'client-unverified': 'The current client has not been verified.', 'unsupported-client': 'The current client is outside the CN scope.',
  'node-24': 'Node 24 is running.', 'node-24-required': 'This workflow requires Node 24.',
  'settings-readable': 'Existing settings were read.', 'settings-missing': 'Initial settings have not been saved.',
  'settings-unreadable': 'Existing settings could not be read or validated; their original contents were preserved.',
  'private-directory-unverified': 'The private directory cannot be determined until settings are repaired.',
  'private-directory-present': 'The selected private directory exists.', 'private-directory-missing': 'The selected private directory is absent or not a directory.',
  'verification-record-unavailable': 'The packaged verification record could not be read.',
  'verification-record-empty': 'The packaged verification record lists no verified MAA version yet, so no installed version can be confirmed; setup and doctor still continue.',
  'maa-version-unknown': 'The installed MAA version could not be identified.',
  'maa-version-not-fully-verified': 'This MAA version is not fully verified by this repository; setup may continue.',
  'maa-upgrade-available': 'A newer stable MAA release has passed this repository\'s source check; the installed version keeps working and upgrading is your choice.', 'maa-version-verified': 'This MAA version has source and device verification records.',
  // Connection states and their messages have one owner: `connectionStates` in setup-connection.ts.
  'managed-fields-valid': 'The task, medicine and timer fields this project writes have valid types and ranges.',
  'managed-fields-invalid': 'Some task, medicine or timer fields this project writes have invalid types or ranges; details name the field kinds only.',
  'timer-profile-missing': 'A timer refers to a configuration that does not exist.',
  'managed-fields-unknown': 'The configuration could not be read, so its fields were not checked.',
  'remote-control-unconfigured': 'MAA remote control is not configured.',
  'remote-control-configured': 'MAA remote control is configured: a remote service can make MAA run tasks, including gacha, without passing through this project\'s writer.',
  'remote-control-unknown': 'The configuration could not be read, so remote control was not checked.',
  'private-files-readable': 'The records this project keeps in the private directory are readable.',
  'private-files-damaged': 'Some records this project keeps in the private directory cannot be read or parsed.',
  'private-files-temporary': 'Temporary files from interrupted writes remain in the private directory.',
  'private-files-unverified': 'The private directory is unknown or absent, so its records were not checked.',
  'skill-update-not-checked': 'The newest published release was not looked up; that needs network access and was not requested.',
  'skill-up-to-date': 'No newer published release than the installed skill version was found.',
  'skill-release-none': 'No published release was found; the installed version is a development build.',
  'skill-update-available': 'A newer published release of these skills is available.',
  'skill-update-unknown': 'The newest published release could not be looked up.',
  'skill-version-unknown': 'The installed skill version could not be read.',
  'skill-links-intact': 'Every installed maa_skills directory, including directory links, resolves and has its SKILL.md.',
  'skill-link-broken': 'An installed maa_skills directory link points to a missing target.',
  'skill-entry-missing': 'An installed maa_skills directory has no SKILL.md.',
  'skill-root-unknown': 'The skill installation directory could not be determined.',
};

const repairTable: Record<string, Omit<Repair, 'id'>> = {
  'use-windows-gui': { executor: 'user', description: 'Use an existing Windows MAA GUI installation.' },
  'official-maa-installation': { executor: 'user', description: 'Choose an existing MAA GUI directory or use the official installation instructions; no download is performed.' },
  'inspect-maa-configuration': { executor: 'user', description: 'Inspect or initialize the current configuration in the MAA GUI.' },
  'select-cn-client-in-maa': { executor: 'user', description: 'Check the selected client in the MAA GUI; use a CN profile.' },
  'official-node-24-installation': { executor: 'user', description: 'Use the official Node download page and select version 24.x.' },
  'set-preferences': { executor: 'skill', description: 'Save the first-run choices using the shared preferences script.', channel: 'preferences.ts set' },
  'inspect-settings': { executor: 'user', description: 'Preserve config.json in the selected settings home, then restore a known-good copy or repair its JSON, schema and access permissions; rerun check before saving preferences or creating directories.' },
  'prepare-private-directory': { executor: 'skill', description: 'Run setup prepare after saving the selected private directory.', channel: 'setup.ts prepare' },
  'read-version-verification': { executor: 'user', description: 'Read the packaged version record and retain the unverified warning; no upgrade is required.' },
  'upgrade-maa-yourself': { executor: 'user', description: 'If you choose to upgrade, use MAA\'s own update setting or the official release page; the skills never upgrade MAA, and the current version keeps working.' },
  'inspect-connection-in-maa': { executor: 'user', description: 'No action is needed; if MAA still fails to connect, compare the connection settings shown in MAA.' },
  'restart-emulator-and-adb': { executor: 'user', description: 'Restart the emulator, and adb if needed, then check again; doctor does not restart either.' },
  'authorize-adb': { executor: 'user', description: 'Accept the debugging authorization in the emulator or device, then check again.' },
  'test-connection-through-setup': { executor: 'skill', description: 'If the emulator is off, the user starts it. If it is on, test the connection through the maa-setup flow (discover, test) after the user\'s named approval, or let MAA connect when it runs; doctor itself never connects.', channel: 'setup.ts discover|test' },
  'connect-through-setup': { executor: 'skill', description: 'With the user\'s named approval, use the maa-setup connection flow (discover, test, apply) to select and test a local connection.', channel: 'setup.ts discover|test|apply' },
  'inspect-configuration-fields': { executor: 'user', description: 'Correct the named field kinds in the MAA GUI, or rewrite them through the skill that owns them; doctor does not edit them.' },
  'no-field-repair-needed': { executor: 'user', description: 'No action is needed.' },
  'review-remote-control-in-maa': { executor: 'user', description: 'Decide in the MAA settings whether to keep remote control; doctor offers no automatic repair because the writer does not manage it.' },
  'no-remote-control-action': { executor: 'user', description: 'No action is needed.' },
  'inspect-private-files': { executor: 'user', description: 'Keep the damaged or temporary files as evidence; restore them from your own backup or remove them yourself after reading them. The skill does not edit private records.' },
  'no-private-file-action': { executor: 'user', description: 'No action is needed.' },
  'check-skill-update': { executor: 'skill', description: 'Look up the newest published release (read-only network access).', channel: 'doctor.ts check --online' },
  'no-update-needed': { executor: 'user', description: 'No action is needed.' },
  'update-skill-through-host': { executor: 'user', description: 'Update through the host\'s own installer or plugin update, installing maa-core together with the other skills of the same version.' },
  'repair-skill-link': { executor: 'user', description: 'Recreate the named directory link to the clone, or reinstall the named skills through the host; doctor does not modify host skill directories.' },
  'no-link-repair-needed': { executor: 'user', description: 'No action is needed.' },
};

export function repairOf(id: string): Repair {
  const entry = repairTable[id];
  if (!entry) throw new Error('repair-unknown');
  return { id, ...entry };
}

/** Builds one library check row; unknown reason or repair codes are programming errors, never output. */
export function libraryCheck(id: string, status: CheckStatus, reason: string, repair: string, details?: string[]): LibraryCheck {
  const message = checkMessages[reason];
  if (!message) throw new Error('check-reason-unknown');
  return { id, status, reason, message, repair: repairOf(repair), ...(details?.length ? { details } : {}) };
}

/** Every skill-executed repair with the channel that performs it; doctor itself executes only `doctor.ts repair`. */
export function skillRepairChannels(): Record<string, string> {
  return Object.fromEntries(Object.entries(repairTable).filter(([, value]) => value.executor === 'skill').map(([id, value]) => [id, value.channel!]));
}
