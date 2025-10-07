import { loadCSVFile } from './file'

import type { LocalFile } from 'papaparse';

import type { IndexableIterable } from './link';

interface KeyAliases {
  [key: string]: Array<string>
}

const keyAliases: KeyAliases = {
  'ssn': ['social_security_number', 'social'],
  'first_name': ['firstname', 'fname'],
  'last_name': ['lastname', 'lname'],
  'date_of_birth': ['dateofbirth', 'dob'],
}

const formatters: Record<string, (x: any) => string> = {
  'ssn': (x: string) => x.replaceAll('-', ''),
  'first_name': (x: string) => x.toUpperCase(),
  'last_name': (x: string) => x.toUpperCase(),
  'date_of_birth': (x: Date) => x.toISOString().substring(0, 10)
}

export async function getDataForFixedRuleLink(file: LocalFile, firstToParty: boolean) {
  const input = await loadCSVFile(file);
  const rawData = input.data as Array<Record<string, string>>;
  const keyAliasMap: Record<string, string> = {}

  const keys = Object.keys(rawData[0]);
  const lowerCaseKeys = keys.map((key) => key.toLowerCase());

  Object.entries(keyAliases).forEach(([key, aliases]) => {
    let i;
    if ((i = lowerCaseKeys.indexOf(key)) >= 0) {
      keyAliasMap[key] = keys[i];
      return
    }
    for (const alias of aliases) {
      if ((i = lowerCaseKeys.indexOf(alias)) >= 0) {
        keyAliasMap[key] = keys[i];
        return;
      }
    }
    throw new Error(`missing column ${key}`);
  });


  // turn date-of-birth into Date objects
  const data: Array<Record<string, string | Date>> = rawData.map(row => {
    // @ts-expect-error
    row[keyAliasMap['date_of_birth']] = new Date(row[keyAliasMap['date_of_birth']]);
    return row;
  });

  return [
    // 1
    new ColumnsIterable(
      data,
      ['ssn', keyAliasMap['ssn'], formatters['ssn']],
      ['last_name', keyAliasMap['last_name'], formatters['last_name']],
      ['date_of_birth', keyAliasMap['date_of_birth'], formatters['date_of_birth']]
    ),
    // 2
    new ColumnsIterable(
      data,
      ['ssn', keyAliasMap['ssn'], formatters['ssn']],
      ['last_name', keyAliasMap['last_name'], formatters['last_name']],
      ['first_name_1', keyAliasMap['first_name'], (x: string) => formatters['first_name'](x).substring(0, 1)],
    ),
    // 3
    new ColumnsIterable(
      data,
      ['ssn', keyAliasMap['ssn'], formatters['ssn']],
      ['last_name_3', keyAliasMap['last_name'], (x: string) => formatters['last_name'](x).substring(0, 3)],
      ['first_name_1', keyAliasMap['first_name'], (x: string) => formatters['first_name'](x).substring(0, 1)],
    ),
    // 4
    new ColumnsIterable(
      data,
      ['ssn', keyAliasMap['ssn'], formatters['ssn']],
      ['last_name_4', keyAliasMap['last_name'], (x: string) => formatters['last_name'](x).substring(0, 4)],
      ['date_of_birth', keyAliasMap['date_of_birth'], formatters['date_of_birth']]
    ),
    // 5
    new ColumnsIterable(
      data,
      ['ssn', keyAliasMap['ssn'], formatters['ssn']],
      ['last_name_4', keyAliasMap['last_name'], (x: string) => formatters['last_name'](x).substring(0, 4)],
      ['year_and_month_of_birth', keyAliasMap['date_of_birth'], (x:string) => formatters['date_of_birth'](x).substring(0, 7)],
    ),
    // 6.1
    new ColumnsIterable(
      data,
      ['ssn', keyAliasMap['ssn'], formatters['ssn']],
      ['date_of_birth', keyAliasMap['date_of_birth'], formatters['date_of_birth']],
      ['last_name_3', keyAliasMap['last_name'], (x: string) => formatters['last_name'](x).substring(0, 3)],
    ),
    // 6.2
    new ColumnsIterable(
      data,
      ['ssn', keyAliasMap['ssn'], formatters['ssn']],
      ['date_of_birth', keyAliasMap['date_of_birth'], formatters['date_of_birth']],
      ['first_name_3', keyAliasMap['first_name'], (x: string) => formatters['first_name'](x).substring(0, 3)],
    ),
    // 7
    new ColumnsIterable(
      data,
      ['ssn_4', keyAliasMap['ssn'], (x: string) => formatters['ssn'](x).substring(0, 4)],
      ['last_name', keyAliasMap['last_name'], formatters['last_name']],
      ['date_of_birth', keyAliasMap['date_of_birth'], formatters['date_of_birth']],
    ),
    // 8
    new ColumnsIterable(
      data,
      ['ssn_4', keyAliasMap['ssn'], (x: string) => formatters['ssn'](x).substring(0, 4)],
      ['last_name_4', keyAliasMap['last_name'], (x: string) => formatters['last_name'](x).substring(0, 4)],
      ['year_and_month_of_birth', keyAliasMap['date_of_birth'], (x:string) => formatters['date_of_birth'](x).substring(0, 7)]
    ),
    // 9
    new ColumnsIterable(
      data,
      ['last_name', keyAliasMap['last_name'], formatters['last_name']],
      ['first_name', keyAliasMap['first_name'], formatters['first_name']],
      ['date_of_birth', keyAliasMap['date_of_birth'], formatters['date_of_birth']],
    ),
    // 10
    new ColumnsIterable(
      data,
      firstToParty ?
        ['name_1', keyAliasMap['last_name'], formatters['last_name']] :
        ['name_1', keyAliasMap['first_name'], formatters['first_name']],
      firstToParty ?
        ['name_2', keyAliasMap['first_name'], formatters['first_name']] :
        ['name_2', keyAliasMap['last_name'], formatters['last_name']],
      ['date_of_birth', keyAliasMap['date_of_birth'], formatters['date_of_birth']],
    ),
    // 11
    new ColumnsIterable(
      data,
      ['ssn', keyAliasMap['ssn'], formatters['ssn']],
      ['date_of_birth', keyAliasMap['date_of_birth'], formatters['date_of_birth']],
      ['first_name', keyAliasMap['first_name'], formatters['first_name']],
    ),
    // 12
    new ColumnsIterable(
      data,
      ['ssn', keyAliasMap['ssn'], formatters['ssn']],
      ['year_and_month_of_birth', keyAliasMap['date_of_birth'], (x:string) => formatters['date_of_birth'](x).substring(0, 7)],
      ['first_name_3', keyAliasMap['first_name'], (x: string) => formatters['first_name'](x).substring(0, 3)],
    ),
    // 13 is redundant
    // 14
    new ColumnsIterable(
      data,
      ['ssn', keyAliasMap['ssn'], formatters['ssn']],
      ['first_name', keyAliasMap['first_name'], formatters['first_name']],
      ['year_and_month_of_birth', keyAliasMap['date_of_birth'], (x:string) => formatters['date_of_birth'](x).substring(0, 7)],
    ),
  ]
}

/* class CsvColumnsIterable implements IndexableIterable<string> {
  [index: number]: string | undefined;

  private readonly data: readonly Record<string, string | Date>[];
  private readonly fields: Array<[string, string]>;

  constructor(data: readonly Record<string, string | Date>[], ...fields: Array<[string, string]>) {
    this.data = data;
    this.fields = fields;

    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (prop === Symbol.iterator) return target[Symbol.iterator].bind(target);
        if (prop === "length") return target.length;
        if (typeof prop === "string" && /^[0-9]+$/.test(prop)) {
          return target.at(Number(prop));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  *[Symbol.iterator](): Iterator<string> {
    for (const row of this.data) {
      yield this.fields.map(([field, alias]) => field + ':' + row[alias]).join(';');
    }
  }

  at(index: number): string | undefined {
    if (index < 0 || index >= this.data.length) return undefined;
    return this.fields.map(([field, alias]) => {
      const value = formatters[field](this.data[index]?.[alias]);
      return field + ':' + value
    })
    .join(';');
  }

  get length(): number {
    return this.data.length;
  }
} */

type Key = string;
type Alias = string;
type Transformation = (x: any) => string;
type FieldSpec = [
  key: Key,
  alias: Alias,
  func: Transformation
];


class ColumnsIterable implements IndexableIterable<string> {
  [index: number]: string | undefined;

  private readonly data: readonly Record<string, string | Date>[];
  private readonly fields: Array<FieldSpec>;

  constructor(data: readonly Record<string, string | Date>[], ...fields: Array<FieldSpec>) {
    this.data = data;
    this.fields = fields;

    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (prop === Symbol.iterator) return target[Symbol.iterator].bind(target);
        if (prop === "length") return target.length;
        if (typeof prop === "string" && /^[0-9]+$/.test(prop)) {
          return target.at(Number(prop));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  *[Symbol.iterator](): Iterator<string> {
    for (const row of this.data) {
      yield this.fields.map(([field, alias, func]) => field + ':' + func(row[alias])).join(';');
    }
  }

  at(index: number): string | undefined {
    if (index < 0 || index >= this.data.length) return undefined;
    return this.fields.map(([field, alias, func]) => {
      return field + ':' + func(this.data[index]?.[alias]);
    })
    .join(';');
  }

  get length(): number {
    return this.data.length;
  }
}
