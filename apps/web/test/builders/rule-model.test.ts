import { describe, expect, it } from 'vitest';

import {
  ROUTING_RULE_CONFIG,
  emptyRuleForm,
  fieldIssue,
  formToRoutingInput,
  isRuleFormEqual,
  priorityLabel,
  routingRuleToForm,
  ruleIssueMessage,
  summarizeActions,
  summarizeConditions,
  toNameMap,
  validateRuleForm,
} from '../../src/components/builders/rule-model';
import { makeRoutingRule } from '../admin/routing-fixtures';

describe('rule form converters', () => {
  it('starts empty with every field present', () => {
    const form = emptyRuleForm(ROUTING_RULE_CONFIG);
    expect(form).toEqual({
      name: '',
      enabled: true,
      conditions: { messageContainsAny: [], messageContainsAll: [], customerTagIds: [], emailDomains: [] },
      actions: { groupId: [], priority: [], tagIds: [] },
    });
  });

  it('turns a rule into a form and back, dropping empty lists', () => {
    const rule = makeRoutingRule({ conditions: { emailDomains: ['a.com'] }, actions: { groupId: 'g1' } });
    const form = routingRuleToForm(rule);
    expect(form.actions).toEqual({ groupId: ['g1'], priority: [], tagIds: [] });
    expect(formToRoutingInput(form)).toEqual({ name: rule.name, enabled: true, conditions: { emailDomains: ['a.com'] }, actions: { groupId: 'g1' } });
  });

  it('round-trips a full rule and trims the name', () => {
    const rule = makeRoutingRule({ conditions: { messageContainsAny: ['x'], messageContainsAll: ['y'], customerTagIds: ['t'], emailDomains: ['d.com'] } });
    const input = formToRoutingInput({ ...routingRuleToForm(rule), name: `  ${rule.name}  ` });
    expect(input).toEqual({ name: rule.name, enabled: rule.enabled, conditions: rule.conditions, actions: rule.actions });
  });

  it('compares forms by value', () => {
    const a = emptyRuleForm(ROUTING_RULE_CONFIG);
    expect(isRuleFormEqual(a, emptyRuleForm(ROUTING_RULE_CONFIG))).toBe(true);
    expect(isRuleFormEqual(a, { ...a, name: 'x' })).toBe(false);
  });
});

describe('validateRuleForm', () => {
  it('requires a name, one condition and a group', () => {
    expect(validateRuleForm(ROUTING_RULE_CONFIG, emptyRuleForm(ROUTING_RULE_CONFIG))).toEqual({
      name: 'Enter a name for the routing rule.',
      conditions: 'Fill in at least one condition.',
      'actions.groupId': 'Choose the group that gets these tickets.',
    });
  });

  it('passes a complete form', () => {
    expect(validateRuleForm(ROUTING_RULE_CONFIG, routingRuleToForm(makeRoutingRule()))).toEqual({});
  });

  it('treats a blank name as missing', () => {
    const form = { ...routingRuleToForm(makeRoutingRule()), name: '   ' };
    expect(Object.keys(validateRuleForm(ROUTING_RULE_CONFIG, form))).toEqual(['name']);
  });
});

describe('issues', () => {
  it('maps known and unknown codes to sentences', () => {
    expect(ruleIssueMessage('too_big')).toBe('There are too many entries.');
    expect(ruleIssueMessage('group_inactive')).toBe('Group inactive.');
  });

  it('finds a field issue by its own or an indexed path', () => {
    expect(fieldIssue(undefined, 'actions', 'tagIds')).toBeUndefined();
    expect(fieldIssue({ 'actions.groupId': 'bad' }, 'actions', 'groupId')).toBe('bad');
    expect(fieldIssue({ 'actions.tagIds.2': 'nope' }, 'actions', 'tagIds')).toBe('nope');
    expect(fieldIssue({ 'actions.tagIds.2': 'nope' }, 'actions', 'groupId')).toBeUndefined();
  });
});

describe('summaries', () => {
  const tags = toNameMap([{ id: 't1', name: 'vip' }]);
  const groups = toNameMap([{ id: 'g1', name: 'Billing' }]);

  it('summarizes conditions', () => {
    expect(summarizeConditions({}, tags)).toBe('No conditions');
    expect(
      summarizeConditions({ messageContainsAny: ['a', 'b'], messageContainsAll: ['c'], customerTagIds: ['t1', 'gone'], emailDomains: ['x.com', 'y.com'] }, tags),
    ).toBe('Message contains any of "a", "b"; message contains all of "c"; customer has any of the tags vip, unknown tag; customer email domain is x.com or y.com');
  });

  it('summarizes actions, naming unknown groups and tags', () => {
    expect(summarizeActions({ groupId: 'g1', priority: 'urgent', tagIds: ['t1', 'zz'] }, groups, tags)).toBe('Assign to Billing, priority Urgent, tags vip, unknown tag');
    expect(summarizeActions({ groupId: 'nope' }, groups, tags)).toBe('Assign to an unknown group');
    expect(priorityLabel('weird')).toBe('weird');
  });

  it('normalizes phrase and domain entries', () => {
    const fields = ROUTING_RULE_CONFIG.conditions.fields;
    expect(fields[0]?.normalize?.('  Hello ')).toBe('Hello');
    expect(fields[3]?.normalize?.(' @Example.COM ')).toBe('example.com');
  });
});
