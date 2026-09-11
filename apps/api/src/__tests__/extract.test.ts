import { describe, expect, it } from 'vitest';
import type { ClarifyingField } from '@helpdesk/shared';
import { extractFields } from '../modules/dialog/extract.js';
import catalog from '../../../../data/catalog/tpu.json' with { type: 'json' };

const clarify = (catalog.categories.find((c) => c.id === 'campus')?.clarify ??
  []) as ClarifyingField[];

describe('deterministic field extraction', () => {
  it('reads the dorm number out of a question', () => {
    expect(
      extractFields(clarify, 'Какой адрес у общежития 12 и кто заведующий?').fields.building,
    ).toBe('общежитие №12');
  });

  it('reads the number when it comes before the word', () => {
    expect(extractFields(clarify, 'я живу в 14 общежитии, не работает душ').fields.building).toBe(
      'общежитие №14',
    );
  });

  it('rejects a dorm number that does not exist', () => {
    const res = extractFields(clarify, 'протекает труба в общежитии 4');
    expect(res.fields.building).toBeUndefined();
    expect(res.reject?.fieldId).toBe('building');
    expect(res.reject?.message).toContain('№4');
  });

  it('stays silent when nothing is named', () => {
    expect(extractFields(clarify, 'не работает интернет')).toEqual({
      fields: {},
      reject: undefined,
    });
  });

  it('survives a broken pattern in the catalog', () => {
    const bad: ClarifyingField[] = [
      { id: 'x', question: '?', required: true, extract: { pattern: '([' } },
    ];
    expect(extractFields(bad, 'что угодно').fields).toEqual({});
  });
});
