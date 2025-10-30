import type { KeyAliases, LinkageKeyDefinition } from "./types";

const formatters: Record<string, (x: any) => string> = {
  'ssn': (x: string | undefined) => x ? x.replaceAll('-', '') : '',
  'first_name': (x: string | undefined) => x ? x.toUpperCase() : '',
  'last_name': (x: string | undefined) => x ? x.toUpperCase() : '',
  'date_of_birth': (x: Date) =>  isNaN(x.getDate()) ? '' : x.toISOString().substring(0, 10)
};

export const keyAliases: KeyAliases = {
  'ssn': ['social_security_number', 'social'],
  'first_name': ['firstname', 'fname'],
  'last_name': ['lastname', 'lname'],
  'date_of_birth': ['dateofbirth', 'dob'],
};

export const firstToPartyLinkageKeyDefinitions: Array<LinkageKeyDefinition> = [
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
    {outputFieldName: 'name_1', inputFieldName: 'last_name', formatter: formatters['last_name']},
    {outputFieldName: 'name_2', inputFieldName: 'first_name', formatter: formatters['first_name']},
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

export const secondToPartyLinkageKeyDefinitions: Array<LinkageKeyDefinition> = [
  ...firstToPartyLinkageKeyDefinitions.slice(0, 10),
  [
    {outputFieldName: 'name_1', inputFieldName: 'first_name', formatter: formatters['first_name']},
    {outputFieldName: 'name_2', inputFieldName: 'last_name', formatter: formatters['last_name']},
    {outputFieldName: 'date_of_birth', inputFieldName: 'date_of_birth', formatter: formatters['date_of_birth']}
  ],
  ...firstToPartyLinkageKeyDefinitions.slice(11)
];
