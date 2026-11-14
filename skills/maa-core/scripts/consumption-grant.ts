/**
 * The one decision about what a grant may open (ticket 27). Input: the grant a request declares and the final settings of
 * the target tasks; output: allowed or a static reason, plus the consumption state classified for every target. The writer's
 * field whitelist (and its doctor-restore variant), indirect-consumption and quantity checks, pending-record validation, doctor
 * recovery, the read summary and the eval grader all call `decideConsumption`; tests/consumption-grant.test.ts enumerates
 * every call site.
 *
 * MAA facts (pinned v6.21.4, see docs/daily-verification.md): FightTask.cs holds `UseMedicine`/`MedicineCount`,
 * `UseStone`/`StoneCount`, `UseStoneAllowSave` (reading a configuration resets `UseStone` when it is not true),
 * `UseExpiringMedicine`/`MedicineExpireDays` and `UseExpireMedicineForActivity`; the GUI passes medicine and stone only when
 * the switch is not false, so a null switch consumes.
 */

/**
 * Every caller, by role. A new call site needs a new label here and a row in the conformance test. `doctor-restore` is the
 * writer's changed-field decision on doctor's restore-config path, the only consumer whose targets may carry `restore`.
 */
export const consumptionConsumers = ['writer-whitelist', 'doctor-restore', 'indirect-consumption', 'quantity-budget', 'pending-record', 'doctor-recovery', 'read-summary', 'eval-grader'] as const;
export type ConsumptionConsumer = typeof consumptionConsumers[number];

/** Static reasons; none carries configuration content. */
export const consumptionRefusals = [
  'consumption-grant-invalid', 'conflicting-authorizations', 'current-request-required',
  'medicine-grant-required', 'medicine-settings-invalid', 'medicine-quantity-exceeded',
  'stone-grant-required', 'stone-settings-invalid', 'stone-quantity-exceeded',
  'expiring-grant-required', 'expiring-days-mismatch', 'expiring-activity-not-approved',
  'recurring-quantity-not-authorized', 'training-expiring-grant-required', 'training-stone-enabled', 'forbidden-setting',
] as const;
export type ConsumptionRefusal = typeof consumptionRefusals[number];

type Kind = 'medicine' | 'stone' | 'expiring' | 'activity';
/** The Fight fields this decision owns, by what they consume. */
export const consumptionFields: Readonly<Record<string, Kind>> = {
  UseMedicine: 'medicine', MedicineCount: 'medicine',
  UseStone: 'stone', StoneCount: 'stone', UseStoneAllowSave: 'stone',
  UseExpiringMedicine: 'expiring', MedicineExpireDays: 'expiring',
  UseExpireMedicineForActivity: 'activity',
};
/**
 * Every task field this decision reads (ticket 30): the identity it recognizes Fight and Award tasks by, the Fight fields
 * above, and the Award settings no grant opens. tests/config-projection.test.ts traces the predicate's reads against this
 * table and requires each field to be in the approval projection.
 */
export const consumptionDecisionFields = { identity: ['$type', 'TaskType'], fight: Object.keys(consumptionFields), award: ['FreeGacha', 'SpecialAccess'] } as const;
const kinds: Kind[] = ['medicine', 'stone', 'expiring', 'activity'];
const quantityKinds: Kind[] = ['medicine', 'stone'];
/**
 * The only values a request may write without the class's grant: a switch set to false or a quantity set to 0. Every other
 * value (a switch set to true or null, a non-zero quantity, any expiring-days value) needs the class's current grant.
 */
const closingValue = (field: string, value: unknown) =>
  field === 'MedicineCount' || field === 'StoneCount' ? value === 0 : field !== 'MedicineExpireDays' && value === false;
/**
 * How a request changes one kind: not at all, only with closing values, also with values equal to the doctor-restore backup
 * task's (`restoring`), or otherwise. Listed in rising order: a kind takes the highest of its changed fields.
 */
const kindChanges = ['none', 'closing', 'restoring', 'other'] as const;
type KindChange = typeof kindChanges[number];
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export type ExpiringMedicineGrant = { days: number; forActivity: boolean };
/** The consumption part of a request's authorization; other authorization keys are ignored here. */
export type ConsumptionGrant = { source: unknown; medicineCount?: unknown; stoneCount?: unknown; expiringMedicine?: unknown };
/**
 * `before`: the task before this request, given when the request changes it (a changed kind needs a current request even to
 * close, and its own grant for any value other than a switch set to false or a quantity set to 0).
 * `activated`: the request makes the task run (enable, reorder of an enabled task, timer). `counted`: an enabled task whose
 * medicine and stone count against the grant. `runs`: scheduled single runs (an explicit allocation counts at least once).
 * `recurring`: reached by a daily-repeating timer.
 * `restore`: the same task in the interrupted transaction's backup, given only by the `doctor-restore` consumer (any other
 * consumer refuses a target carrying it). A kind that ends closed may take back the backup task's values with only a current
 * request: they were in the configuration before that transaction, so restoring them presets no new consumption. A kind that
 * ends open still needs the repair's own current grant.
 */
export type ConsumptionTarget = { task: unknown; before?: unknown; restore?: unknown; activated?: boolean; counted?: boolean; runs?: number; recurring?: boolean };
/**
 * `plan`: the approved plan the request writes. A job or training plan may carry only the expiring-medicine grant; a base plan
 * (ticket 23) never touches consumption fields and carries none (design default, 2026-11-14, merge of 27 with 23).
 */
export type ConsumptionContext = { consumer: ConsumptionConsumer; plan?: 'job' | 'training' | 'base' };
/** `on`: true or false as configured; null when the switch is not a boolean, which MAA (and this decision) treats as on. */
export type TaskConsumption = {
  medicine: { on: boolean | null; count: number | null };
  stone: { on: boolean | null; count: number | null; allowSave: boolean | null };
  expiring: { on: boolean | null; days: number | null; activity: boolean | null };
};
export type ConsumptionDecision = { allowed: boolean; reason: ConsumptionRefusal | null; tasks: (TaskConsumption | null)[] };

const maxInt32 = 2147483647;
type Settings = Record<string, unknown>;
const record = (value: unknown): Settings | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Settings : null;
const typed = (value: unknown, type: string): Settings | null => {
  const task = record(value);
  return task && task.$type === `${type}Task` && task.TaskType === type ? task : null;
};
const flag = (value: unknown) => typeof value === 'boolean' ? value : null;
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maxInt32 ? Number(value) : null;

function classify(task: Settings): TaskConsumption {
  return {
    medicine: { on: flag(task.UseMedicine), count: integer(task.MedicineCount) },
    stone: { on: flag(task.UseStone), count: integer(task.StoneCount), allowSave: flag(task.UseStoneAllowSave) },
    expiring: { on: flag(task.UseExpiringMedicine), days: integer(task.MedicineExpireDays), activity: flag(task.UseExpireMedicineForActivity) },
  };
}
const consumes = (state: TaskConsumption, kind: Kind) =>
  (kind === 'activity' ? state.expiring.activity : kind === 'expiring' ? state.expiring.on : state[kind].on) !== false;

type Grant = { current: boolean; medicine?: number; stone?: number; expiring?: ExpiringMedicineGrant };
function readGrant(value: unknown, plan: ConsumptionContext['plan']): Grant | ConsumptionRefusal {
  const grant = record(value);
  if (!grant) return 'consumption-grant-invalid';
  const quantity = (amount: unknown) => amount === undefined || Number.isInteger(amount) && Number(amount) >= 0 && Number(amount) <= maxInt32;
  if (!quantity(grant.medicineCount) || !quantity(grant.stoneCount)) return 'consumption-grant-invalid';
  const expiring = grant.expiringMedicine === undefined ? undefined : record(grant.expiringMedicine);
  if (grant.expiringMedicine !== undefined && (!expiring || Object.keys(expiring).length !== 2 || !Number.isInteger(expiring.days)
    || Number(expiring.days) < 1 || Number(expiring.days) > 30 || typeof expiring.forActivity !== 'boolean')) return 'consumption-grant-invalid';
  const granted = [grant.medicineCount, grant.stoneCount, grant.expiringMedicine].some(item => item !== undefined);
  if (plan === 'base' && granted) return 'conflicting-authorizations';
  const current = grant.source === 'current-request';
  if (!current && granted) return 'current-request-required';
  if (plan && (grant.medicineCount !== undefined || grant.stoneCount !== undefined)) return 'conflicting-authorizations';
  return { current, medicine: grant.medicineCount as number | undefined, stone: grant.stoneCount as number | undefined,
    expiring: expiring ? { days: Number(expiring.days), forActivity: expiring.forActivity as boolean } : undefined };
}

/** One kind of one Fight task. `change`: how this request changes the kind's fields. */
function checkKind(kind: Kind, task: Settings, state: TaskConsumption, grant: Grant, change: KindChange, plan: ConsumptionContext['plan']): ConsumptionRefusal | null {
  if (!consumes(state, kind)) {
    // A kind that ends closed: closing values need only an ordinary current request, for medicine as for stone and expiring
    // medicine, and a remaining quantity is not compared; so do a doctor restore's backup values. Any other value written to
    // it, even while it stays closed, needs the kind's own current grant: a quantity within it, expiring days equal to it.
    if (change === 'none') return null;
    if (!grant.current) return 'current-request-required';
    if (change === 'closing' || change === 'restoring') return null;
    if (kind === 'medicine') {
      if (grant.medicine === undefined) return 'medicine-grant-required';
      if (state.medicine.count === null) return 'medicine-settings-invalid';
      return state.medicine.count > grant.medicine ? 'medicine-quantity-exceeded' : null;
    }
    if (kind === 'stone') {
      if (grant.stone === undefined) return 'stone-grant-required';
      if (state.stone.count === null) return 'stone-settings-invalid';
      return state.stone.count > grant.stone ? 'stone-quantity-exceeded' : null;
    }
    if (!grant.expiring) return 'expiring-grant-required';
    return kind === 'expiring' && task.MedicineExpireDays !== grant.expiring.days ? 'expiring-days-mismatch' : null;
  }
  if (plan === 'training' && kind === 'stone') return 'training-stone-enabled';
  if (plan === 'training' && (kind === 'expiring' || kind === 'activity') && !grant.expiring) return 'training-expiring-grant-required';
  if (!grant.current) return 'current-request-required';
  if (kind === 'medicine') {
    if (grant.medicine === undefined) return 'medicine-grant-required';
    if (task.UseMedicine !== true || !state.medicine.count) return 'medicine-settings-invalid';
    return state.medicine.count > grant.medicine ? 'medicine-quantity-exceeded' : null;
  }
  if (kind === 'stone') {
    if (grant.stone === undefined) return 'stone-grant-required';
    // MAA resets UseStone on reading unless UseStoneAllowSave is true, so both are opened (and read back) together.
    if (task.UseStone !== true || task.UseStoneAllowSave !== true || !state.stone.count) return 'stone-settings-invalid';
    return state.stone.count > grant.stone ? 'stone-quantity-exceeded' : null;
  }
  if (!grant.expiring) return 'expiring-grant-required';
  if (kind === 'expiring') return task.UseExpiringMedicine === true && task.MedicineExpireDays === grant.expiring.days ? null : 'expiring-days-mismatch';
  return task.UseExpireMedicineForActivity === true && grant.expiring.forActivity ? null : 'expiring-activity-not-approved';
}

/** The predicate. Pure: no files, no process; the same inputs always give the same decision. */
export function decideConsumption(grantValue: ConsumptionGrant, targets: ConsumptionTarget[], context: ConsumptionContext): ConsumptionDecision {
  const tasks = targets.map(target => { const task = typed(target.task, 'Fight'); return task ? classify(task) : null; });
  const refuse = (reason: ConsumptionRefusal): ConsumptionDecision => ({ allowed: false, reason, tasks });
  if (!consumptionConsumers.includes(context?.consumer)) return refuse('consumption-grant-invalid');
  // Only doctor's restore path may name a backup task; an ordinary write never gets the restore allowance.
  if (context.consumer !== 'doctor-restore' && targets.some(target => target.restore !== undefined)) return refuse('consumption-grant-invalid');
  const grant = readGrant(grantValue, context.plan);
  if (typeof grant === 'string') return refuse(grant);
  const totals = { medicine: 0, stone: 0 };
  for (const [index, target] of targets.entries()) {
    const award = typed(target.task, 'Award');
    if (award) {
      // Gacha and special packs stay closed under every grant: never activated, counted or newly opened.
      const open = (task: Settings | null) => !!task && (task.FreeGacha !== false || task.SpecialAccess === true);
      const before = record(target.before);
      const openedBefore = !!before && (before.FreeGacha === true || before.SpecialAccess === true);
      if (open(award) && (target.activated || target.counted || before && !openedBefore)) return refuse('forbidden-setting');
      continue;
    }
    const task = typed(target.task, 'Fight'); const state = tasks[index];
    if (!task || !state) continue;
    const before = target.before === undefined ? undefined : record(target.before) ?? {};
    const restore = context.consumer === 'doctor-restore' ? typed(target.restore, 'Fight') : null;
    const changed = new Map<Kind, KindChange>();
    if (before) for (const [field, owner] of Object.entries(consumptionFields)) {
      if (same(before[field], task[field])) continue;
      const change = closingValue(field, task[field]) ? 'closing' : restore && same(restore[field], task[field]) ? 'restoring' : 'other';
      if (kindChanges.indexOf(change) > kindChanges.indexOf(changed.get(owner) ?? 'none')) changed.set(owner, change);
    }
    const evaluated = new Set<Kind>(changed.keys());
    if (target.activated) for (const kind of kinds) evaluated.add(kind);
    if (target.counted) for (const kind of quantityKinds) evaluated.add(kind);
    for (const kind of kinds) {
      if (!evaluated.has(kind)) continue;
      const reason = checkKind(kind, task, state, grant, changed.get(kind) ?? 'none', context.plan);
      if (reason) return refuse(reason);
    }
    const runs = Math.max(1, Number.isSafeInteger(target.runs) ? Number(target.runs) : 0);
    for (const kind of quantityKinds) {
      if (!evaluated.has(kind) || !consumes(state, kind)) continue;
      const amount = kind === 'medicine' ? state.medicine.count! : state.stone.count!;
      // A finite quantity cannot be consumed by a daily-repeating timer.
      if (target.recurring && amount > 0) return refuse('recurring-quantity-not-authorized');
      totals[kind as 'medicine' | 'stone'] += amount * runs;
    }
  }
  if (totals.medicine > (grant.medicine ?? 0)) return refuse('medicine-quantity-exceeded');
  if (totals.stone > (grant.stone ?? 0)) return refuse('stone-quantity-exceeded');
  return { allowed: true, reason: null, tasks };
}
