import assert from 'node:assert/strict';
import { conditionMatches, starterQuestionnaire, validateConditions, visibleAnswers, visibleQuestions } from '../lib/questionnaires/model.ts';

const form = starterQuestionnaire('test-service', 'Psicología');
const source = form.questions[0];
const followUp = form.questions.find((question) => question.title === '¿Desde cuándo sentís que esto te afecta?');
assert.ok(followUp);
assert.equal(visibleQuestions(form, {}).some((question) => question.id === followUp.id), false);
assert.equal(visibleQuestions(form, { [source.id]: 'Ansiedad' }).some((question) => question.id === followUp.id), true);
assert.equal(visibleQuestions(form, { [source.id]: 'Otro' }).some((question) => question.id === followUp.id), false);
assert.equal(validateConditions(form), null);
const invalidOrder = { ...form, questions: form.questions.map((question) => question.id === followUp.id ? { ...question, section: 'situation', order: -1 } : question) };
assert.match(validateConditions(invalidOrder), /aparecer antes/);
assert.deepEqual(visibleAnswers(form, { [source.id]: 'Otro', [followUp.id]: 'Hace meses' }), { [source.id]: 'Otro' });

const rule = { id: 'r', questionId: source.id, action: 'hide', operator: 'equals', value: 'Ansiedad' };
const hiddenForm = { ...form, questions: form.questions.map((question) => question.id === followUp.id ? { ...question, conditions: [rule] } : question) };
assert.equal(visibleQuestions(hiddenForm, { [source.id]: 'Ansiedad' }).some((question) => question.id === followUp.id), false);
assert.equal(visibleQuestions(hiddenForm, { [source.id]: 'Otro' }).some((question) => question.id === followUp.id), true);

assert.equal(conditionMatches({ ...rule, operator: 'contains', value: 'ansiedad' }, 'Ansiedad intensa'), true);
assert.equal(conditionMatches({ ...rule, operator: 'includes', value: 'Dolor' }, ['Dolor', 'Control']), true);
assert.equal(conditionMatches({ ...rule, operator: 'greater_than', value: 5 }, 7), true);
assert.equal(conditionMatches({ ...rule, operator: 'less_than', value: 5 }, 3), true);
assert.equal(conditionMatches({ ...rule, operator: 'not_equals', value: 'Ansiedad' }, undefined), false);
console.log('Conditional questionnaire checks passed.');
