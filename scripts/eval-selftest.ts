import { grade } from './evaluation.ts';
import { samplePolicy, ruleSamples } from '../eval/rule-samples.ts';

const failures = ruleSamples.filter((sample) => {
  const result = grade(sample.policy ?? samplePolicy, sample.evidence);
  return result.status !== sample.expected || (sample.expected === 'fail' && !result.failed.includes(sample.rule));
});
console.log(JSON.stringify({ ok: failures.length === 0, rules: new Set(ruleSamples.map((sample) => sample.rule)).size, samples: ruleSamples.length }));
if (failures.length) process.exitCode = 1;
