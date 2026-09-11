import { describe, expect, it } from 'vitest';
import type { ClarifyingField } from '@helpdesk/shared';
import { extractFields, isRequired, validateFields } from '../modules/dialog/extract.js';
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

  it('reads dorm and room together', () => {
    const r = extractFields(clarify, 'в общежитии 12, комната 305, не работает розетка').fields;
    expect(r).toEqual({ building: 'общежитие №12', room: 'комната 305' });
  });

  it('reads a building number and the main building', () => {
    expect(extractFields(clarify, 'в 8 корпусе, ауд. 214, сломан проектор').fields).toEqual({
      building: 'корпус №8',
      room: 'ауд. 214',
    });
    expect(extractFields(clarify, 'в главном корпусе холодно').fields.building).toBe(
      'Главный корпус',
    );
  });

  it('reads the place in a dorm: room, or floor and shared room, as written', () => {
    const where = (t: string) => extractFields(clarify, t).fields.room;
    expect(where('комната 305')).toBe('комната 305');
    expect(where('на кухне 3 этажа нет воды')).toBe('кухне 3 этажа');
    expect(where('3 этаж, душевая')).toBe('3 этаж, душевая');
    expect(where('в прачечной сломалась машинка')).toBe('прачечной');
    expect(where('на 5 этаже нет света')).toBe('5 этаже');
    expect(where('не работает интернет')).toBeUndefined();
  });

  it('rejects a building that does not exist in TPU', () => {
    for (const text of ['в корпусе 14 нет света', 'корпус №40, кабинет 5', 'в 23 корпусе']) {
      const res = extractFields(clarify, text);
      expect(res.fields.building).toBeUndefined();
      expect(res.reject?.fieldId).toBe('building');
      expect(res.reject?.message).toMatch(/корпуса №(14|40|23) в ТПУ нет/);
    }
  });

  it('applies the same whitelist to values the model extracted', () => {
    const r = validateFields(clarify, { building: 'корпус 40', room: '12' });
    expect(r.fields).toEqual({ room: '12' });
    expect(r.reject?.fieldId).toBe('building');
    // a recognised value is normalised, an unknown-looking one is kept as is
    expect(validateFields(clarify, { building: 'общ. 12' }).fields.building).toBe('общежитие №12');
    expect(validateFields(clarify, { building: 'ул. Вершинина, 37' }).fields.building).toBe(
      'ул. Вершинина, 37',
    );
  });

  it('requires the room for a dorm but not for a building', () => {
    const room = clarify.find((f) => f.id === 'room')!;
    expect(isRequired(room, { building: 'общежитие №12' })).toBe(true);
    expect(isRequired(room, { building: 'корпус №8' })).toBe(false);
    expect(isRequired(room, {})).toBe(false);
  });

  it('stays silent when nothing is named', () => {
    expect(extractFields(clarify, 'не работает интернет')).toEqual({
      fields: {},
      reject: undefined,
    });
  });

  it('fills an option field when exactly one option is named in the text', () => {
    const fields: ClarifyingField[] = [
      {
        id: 'location',
        question: '?',
        required: true,
        options: ['Из корпуса', 'Из общежития', 'Из дома / удалённо'],
      },
    ];
    expect(extractFields(fields, 'не работает VPN из дома').fields).toEqual({
      location: 'Из дома / удалённо',
    });
    // two options mentioned - ambiguous, ask
    expect(extractFields(fields, 'в общежитии работает, из дома нет').fields).toEqual({});
  });

  it('survives a broken pattern in the catalog', () => {
    const bad: ClarifyingField[] = [
      { id: 'x', question: '?', required: true, extract: { pattern: '([' } },
    ];
    expect(extractFields(bad, 'что угодно').fields).toEqual({});
  });
});
