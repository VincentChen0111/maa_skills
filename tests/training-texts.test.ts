// Ticket 32 follow-on OB-6/OB-5 (recurrence rule): one training-text predicate. Every training-room skill in the pinned
// building table must give its assistant a usable estimate — the verified parts as a lower bound, unverified extras listed
// as pending — so no unverified condition can disqualify an assistant and block preparation again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTraining } from '../skills/maa-core/scripts/training-time.ts';
import { trainingFixture } from './fixtures/training-data.ts';
import { pinnedTrainingTexts } from './fixtures/training-texts.ts';

type Fixture = ReturnType<typeof trainingFixture>;
const branches = { artsprotector: '驭法铁卫', fastshot: '速射手', fighter: '斗士', lord: '领主', siegesniper: '攻城手', wandermedic: '行医',
  chainhealer: '链愈师', supportiveranger: '游击手', primguard: '本源近卫', primcaster: '本源术师' };
/** The only available assistant carries exactly this one training skill; the trainee is a 近卫 of the given branch. */
function only(text: string, branch: string | null = 'lord', withTable = true) {
  const f: Fixture = trainingFixture();
  Object.assign(f.tables.building.buffs, { pinned: { buffName: '固定训练技能', roomType: 'TRAINING', description: text } });
  f.tables.building.chars.char_helper.buffChar = [{ buffData: [{ buffId: 'pinned', cond: { phase: 'PHASE_0', level: 1 } }] }];
  if (branch) f.tables.characters.char_synthetic.subProfessionId = branch;
  if (withTable) Object.assign(f.tables.modules, { subProfDict: Object.fromEntries(Object.entries(branches).map(([id, name]) => [id, { subProfessionId: id, subProfessionName: name }])) });
  f.request.facts.availableAssistants = ['char_helper'];
  return f;
}
const helper = (f: Fixture, target = 3) => {
  const result = calculateTraining(f.tables, f.snapshot, { ...f.request, target });
  return { result, rows: result.stages.map(stage => stage.assistants.find(row => row.id === 'char_helper')!) };
};

test('32 OB-6: every pinned training text leaves its assistant usable with a lower-bound estimate and every stage preparable', () => {
  assert.equal(pinnedTrainingTexts.length, 110);
  const lowerBound: string[] = [];
  for (const [buffId, text] of pinnedTrainingTexts) {
    const { result, rows } = helper(only(text));
    for (const [index, row] of rows.entries()) {
      assert.ok(row.speedBonus !== null && row.speedBonus >= 0.05, `${buffId} M${index + 1}: ${JSON.stringify(row)}`);
      assert.ok(row.estimatedSeconds !== null, buffId);
      assert.equal(result.stages[index]!.recommendedAssistant, 'char_helper', buffId);
    }
    assert.ok(!result.issues.some(issue => /^training:stage-\d-pending$/.test(issue)), `${buffId}: ${result.issues.join(',')}`);
    if (rows.some(row => row.lowerBound)) lowerBound.push(buffId);
  }
  // Of the 22 texts that used to disqualify their assistant, with the trainee's branch from the tables only those whose extra
  // the tool cannot verify stay lower bounds: 2 five-hour reductions and 11 faction counts, 人间烟火 and 武道. The 8 branch
  // texts and 塔露拉's are exact.
  assert.equal(lowerBound.length, 13, lowerBound.join(','));
});

test('32 OB-6: an unverified extra is listed as pending on the assistant and never lowers the verified part', () => {
  const faction = '进驻训练室协助位时，基建内（不包含副手及活动室使用者）每名萨米干员为当前干员的专精技能训练速度+10%（最多生效3名）';
  const [row] = helper(only(faction), 1).rows;
  assert.deepEqual([row!.speedBonus, row!.lowerBound], [0.05, true]);
  assert.ok(row!.issues.some(issue => issue.startsWith('assistant:condition-unverified:')), JSON.stringify(row));
  // The estimate is an upper bound on the duration: base seconds / (1 + verified bonus).
  assert.equal(row!.estimatedSeconds, Math.ceil(3600 / 1.05));
});

test('32 OB-5: the trainee branch comes from the pinned tables, not from a user fact', () => {
  const qiubai = '进驻训练室协助位时，近卫干员的专精技能训练速度+30%，如果训练位干员分支为领主，则训练速度额外+45%';
  assert.deepEqual(helper(only(qiubai, 'lord'), 1).rows.map(row => [row.speedBonus, row.lowerBound]), [[0.8, false]]);
  assert.deepEqual(helper(only(qiubai, 'fighter'), 1).rows.map(row => [row.speedBonus, row.lowerBound]), [[0.35, false]]);
  // A user-stated branch does not override the table.
  const stated = only(qiubai, 'fighter'); Object.assign(stated.request.facts, { branchName: '领主' });
  assert.equal(helper(stated, 1).rows[0]!.speedBonus, 0.35);
  // No branch table: the class part is a lower bound and the branch extra stays pending; the assistant is still usable.
  const [unknown] = helper(only(qiubai, 'lord', false), 1).rows;
  assert.deepEqual([unknown!.speedBonus, unknown!.lowerBound], [0.35, true]);
  assert.ok(unknown!.issues.some(issue => issue.startsWith('assistant:branch-unverified:')));
  // 塔露拉: either of two branches, and no class part.
  const talulah = '进驻训练室协助位时，如果训练位干员分支为本源近卫或本源术师，则专精技能训练速度额外+45%';
  assert.equal(helper(only(talulah, 'primguard'), 1).rows[0]!.speedBonus, 0.5);
  assert.deepEqual(helper(only(talulah, 'lord'), 1).rows.map(row => [row.speedBonus, row.lowerBound]), [[0.05, false]]);
});
