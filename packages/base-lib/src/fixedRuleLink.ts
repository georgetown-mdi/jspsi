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
};

const formatters: Record<string, (x: any) => string> = {
  'ssn': (x: string | undefined) => x ? x.replaceAll('-', '') : '',
  'first_name': (x: string | undefined) => x ? x.toUpperCase() : '',
  'last_name': (x: string | undefined) => x ? x.toUpperCase() : '',
  'date_of_birth': (x: Date) =>  isNaN(x.getDate()) ? '' : x.toISOString().substring(0, 10)
};

type Formatter = (x: string) => string;

interface LinkageKey {
  outputFieldName: string,
  inputFieldName: string | ((firstToParty: boolean) => string),
  formatter: Formatter | ((firstToParty: boolean) => Formatter)
}

export const linkageKeys: Array<Array<LinkageKey>> = [
  [
    {outputFieldName: 'ssn', inputFieldName: 'ssn', formatter: formatters['ssn']},
    {outputFieldName: 'last_name', inputFieldName: 'last_name', formatter: formatters['last_name']},
    {outputFieldName: 'date_of_birth', inputFieldName: 'date_of_birth', formatter: formatters['date_of_birth']}
  ],
  [
    {outputFieldName: 'ssn', inputFieldName: 'ssn', formatter: formatters['ssn']},
    {outputFieldName: 'last_name', inputFieldName: 'last_name', formatter: formatters['last_name']},
    {outputFieldName: 'first_name_1', inputFieldName: 'first_name', formatter: (x: string) => formatters['first_name'](x).substring(0, 1)}
  ],
  [
    {outputFieldName: 'ssn', inputFieldName: 'ssn', formatter: formatters['ssn']},
    {outputFieldName: 'last_name_3', inputFieldName: 'last_name', formatter:(x: string) => formatters['last_name'](x).substring(0, 3)},
    {outputFieldName: 'first_name_1', inputFieldName: 'first_name', formatter: (x: string) => formatters['first_name'](x).substring(0, 1)}
  ],
  [
    {outputFieldName: 'ssn', inputFieldName: 'ssn', formatter: formatters['ssn']},
    {outputFieldName: 'last_name_4', inputFieldName: 'last_name', formatter: (x: string) => formatters['last_name'](x).substring(0, 4)},
    {outputFieldName: 'date_of_birth', inputFieldName: 'date_of_birth', formatter: formatters['date_of_birth']}
  ],
  [
    {outputFieldName: 'ssn', inputFieldName: 'ssn', formatter: formatters['ssn']},
    {outputFieldName: 'last_name_4', inputFieldName: 'last_name', formatter: (x: string) => formatters['last_name'](x).substring(0, 4)},
    {outputFieldName: 'year_and_month_of_birth', inputFieldName: 'date_of_birth', formatter: (x:string) => formatters['date_of_birth'](x).substring(0, 7)}
  ],
  [
    {outputFieldName: 'ssn', inputFieldName: 'ssn', formatter: formatters['ssn']},
    {outputFieldName: 'date_of_birth', inputFieldName: 'date_of_birth', formatter: formatters['date_of_birth']},
    {outputFieldName: 'last_name_3', inputFieldName: 'last_name', formatter: (x: string) => formatters['last_name'](x).substring(0, 3)}
  ],
  [
    {outputFieldName: 'ssn', inputFieldName: 'ssn', formatter: formatters['ssn']},
    {outputFieldName: 'date_of_birth', inputFieldName: 'date_of_birth', formatter: formatters['date_of_birth']},
    {outputFieldName: 'first_name_3', inputFieldName: 'first_name', formatter: (x: string) => formatters['first_name'](x).substring(0, 3)}
  ],
  [
    {outputFieldName: 'ssn_4', inputFieldName: 'ssn', formatter: (x: string) => formatters['ssn'](x).substring(0, 4)},
    {outputFieldName: 'last_name', inputFieldName: 'last_name', formatter: formatters['last_name']},
    {outputFieldName: 'date_of_birth', inputFieldName: 'date_of_birth', formatter: formatters['date_of_birth']}
  ],
  [
    {outputFieldName: 'ssn_4', inputFieldName: 'ssn', formatter: (x: string) => formatters['ssn'](x).substring(0, 4)},
    {outputFieldName: 'last_name_4', inputFieldName: 'last_name', formatter: (x: string) => formatters['last_name'](x).substring(0, 4)},
    {outputFieldName: 'year_and_month_of_birth', inputFieldName: 'date_of_birth', formatter: (x:string) => formatters['date_of_birth'](x).substring(0, 7)}
  ],
  [
    {outputFieldName: 'last_name', inputFieldName: 'last_name', formatter: formatters['last_name']},
    {outputFieldName: 'first_name', inputFieldName: 'first_name', formatter: formatters['first_name']},
    {outputFieldName: 'date_of_birth', inputFieldName: 'date_of_birth', formatter: formatters['date_of_birth']}
  ],
  [
    {
      outputFieldName: 'name_1',
      inputFieldName: (firstToParty: boolean) => firstToParty ? 'last_name' : 'first_name',
      formatter: (firstToParty: boolean) => firstToParty ? formatters['last_name'] : formatters['first_name']
    },
    {
      outputFieldName: 'name_2',
      inputFieldName: (firstToParty: boolean) => firstToParty ? 'first_name' : 'last_name',
      formatter: (firstToParty: boolean) => firstToParty ? formatters['first_name'] : formatters['last_name']
    },
    {outputFieldName: 'date_of_birth', inputFieldName: 'date_of_birth', formatter: formatters['date_of_birth']}
  ],
  [
    {outputFieldName: 'ssn', inputFieldName: 'ssn', formatter: formatters['ssn']},
    {outputFieldName: 'date_of_birth', inputFieldName: 'date_of_birth', formatter: formatters['date_of_birth']},
    {outputFieldName: 'first_name', inputFieldName: 'first_name', formatter: formatters['first_name']}
  ],
  [
    {outputFieldName: 'ssn', inputFieldName: 'ssn', formatter: formatters['ssn']},
    {outputFieldName: 'year_and_month_of_birth', inputFieldName: 'date_of_birth', formatter: (x: string) => formatters['date_of_birth'](x).substring(0, 7)},
    {outputFieldName: 'first_name_3', inputFieldName: 'first_name', formatter: (x: string) => formatters['first_name'](x).substring(0, 3)}
  ],
  [
    {outputFieldName: 'ssn', inputFieldName: 'ssn', formatter: formatters['ssn']},
    {outputFieldName: 'first_name', inputFieldName: 'first_name', formatter: formatters['first_name']},
    {outputFieldName: 'year_and_month_of_birth', inputFieldName: 'date_of_birth', formatter: (x:string) => formatters['date_of_birth'](x).substring(0, 7)}
  ]
];

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
  const data: Array<Record<string, string | Date | undefined>> = rawData.map(row => {
    // @ts-expect-error
    row[keyAliasMap['date_of_birth']] = new Date(row[keyAliasMap['date_of_birth']]);
    return row;
  });

  return linkageKeys.map((key) => {
    return new ColumnsIterable(
      data,
      ...key.map(
        ({outputFieldName, inputFieldName, formatter}) => {
          if (typeof inputFieldName === 'function') {
            inputFieldName = inputFieldName(firstToParty);
            formatter = (formatter as (x: boolean) => Formatter)(firstToParty);
          } else {
            formatter = formatter as Formatter;
          }

          const result: [string, string, (x: string) => string] = [outputFieldName, keyAliasMap[inputFieldName], formatter];
          return result;
        }
      )
    );
  });
}

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

  private readonly data: readonly Record<string, string | Date | undefined>[];
  private readonly fields: Array<FieldSpec>;

  constructor(data: readonly Record<string, string | Date | undefined>[], ...fields: Array<FieldSpec>) {
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
      yield this.fields.map(([field, alias, func]) =>
        field + ':' + func(row[alias])
      )
      .join(';');
    }
  }

  at(index: number): string | undefined {
    if (index < 0 || index >= this.data.length) return undefined;
    return this.fields.map(([field, alias, func]) =>
      field + ':' + func(this.data[index]?.[alias])
    )
    .join(';');
  }

  get length(): number {
    return this.data.length;
  }
}
