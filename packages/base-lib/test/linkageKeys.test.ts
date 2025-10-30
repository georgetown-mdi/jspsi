import { Readable } from 'node:stream'

import { expect, test } from 'vitest'

import { getLinkageKeys } from '../src/linkageKeys'

import type { KeyAliases, LinkageKeyDefinition } from '../src/types'

const formatters: Record<string, (x: any) => string> = {
  'ssn': (x: string | undefined) => x ? x.replaceAll('-', '') : '',
  'first_name': (x: string | undefined) => x ? x.toUpperCase() : '',
  'last_name': (x: string | undefined) => x ? x.toUpperCase() : '',
  'date_of_birth': (x: Date) =>  isNaN(x.getDate()) ? '' : x.toISOString().substring(0, 10)
};

const keyAliases: KeyAliases = {
  'ssn': ['social_security_number', 'social'],
  'first_name': ['firstname', 'fname'],
  'last_name': ['lastname', 'lname'],
  'date_of_birth': ['dateofbirth', 'dob'],
};

const linkageKeyDefinitions: Array<LinkageKeyDefinition> = [
  [
    {outputFieldName: 'ssn', inputFieldName: 'ssn', formatter: formatters['ssn']},
    {outputFieldName: 'last_name', inputFieldName: 'last_name', formatter: formatters['last_name']},
    {outputFieldName: 'date_of_birth', inputFieldName: 'date_of_birth', formatter: formatters['date_of_birth']}
  ]
];

const extraLinkageKeyDefinitions: Array<LinkageKeyDefinition> = [
  [
    {outputFieldName: 'ssn', inputFieldName: 'ssn', formatter: formatters['ssn']},
    {outputFieldName: 'last_name', inputFieldName: 'last_name', formatter: formatters['last_name']},
    {outputFieldName: 'first_name_1', inputFieldName: 'first_name', formatter: (x: string) => formatters['first_name'](x).substring(0, 1)}
  ],
];

test('handles trailing newline', async () => {
  const inputData = [
    ['id,first_name,last_name,ssn,date_of_birth\n'],
    ['159859483,James,Heard,559-81-1301,7/16/1975\n'],
  ];
  const linkData = await getLinkageKeys(
    Readable.from(inputData),
    linkageKeyDefinitions,
    keyAliases
  );

  expect(linkData.length).toBe(linkageKeyDefinitions.length);
  expect(linkData[0].length).toBe(1);
});

test('handles no trailing newline', async () => {
  const inputData = [
    ['id,first_name,last_name,ssn,date_of_birth\n'],
    ['159859483,James,Heard,559-81-1301,7/16/1975'],
  ];
  const linkData = await getLinkageKeys(
    Readable.from(inputData),
    linkageKeyDefinitions,
    keyAliases
  );

  expect(linkData.length).toBe(linkageKeyDefinitions.length);
  expect(linkData[0].length).toBe(1);
});

test('handles valid input', async () => {
  const inputData = [
    ['id,first_name,last_name,ssn,date_of_birth\n'],
    ['159859483,James,Heard,559-81-1301,7/16/1975\n'],
    ['165562801,Albert,Iorio,322-84-2281,8/17/1975']
  ];
  const linkData = await getLinkageKeys(
    Readable.from(inputData),
    [...linkageKeyDefinitions, ...extraLinkageKeyDefinitions],
    keyAliases
  );

  expect(linkData.length).toBe(linkageKeyDefinitions.length + extraLinkageKeyDefinitions.length);
  expect(linkData[0].length).toBe(2);
  expect(linkData[0][0]).toBe('ssn:559811301;last_name:HEARD;date_of_birth:1975-07-16');
  expect(linkData[0][1]).toBe('ssn:322842281;last_name:IORIO;date_of_birth:1975-08-17');
  expect(linkData[1][0]).toBe('ssn:559811301;last_name:HEARD;first_name_1:J');
  expect(linkData[1][1]).toBe('ssn:322842281;last_name:IORIO;first_name_1:A');
});

test('handles empty inputs', async () => {
  const inputData = [
    ['id,first_name,last_name,ssn,date_of_birth\n'],
    ['159859483,James,Heard,559-81-1301,7/16/1975\n'],
    []
  ];
  const linkData = await getLinkageKeys(
    Readable.from(inputData),
    linkageKeyDefinitions,
    keyAliases
  );

  expect(linkData.length).toBe(linkageKeyDefinitions.length);
  expect(linkData[0].length).toBe(1);
});

test('handles invalid dates', async () => {
  const inputData = [
    ['id,first_name,last_name,ssn,date_of_birth\n'],
    ['159859483,James,Heard,559-81-1301,12/32/1975'],
  ];
  const linkData = await getLinkageKeys(
    Readable.from(inputData),
    linkageKeyDefinitions,
    keyAliases
  );

  expect(linkData.length).toBe(linkageKeyDefinitions.length);
  expect(linkData[0].length).toBe(1);
  expect(linkData[0][0]).toBe('ssn:559811301;last_name:HEARD;date_of_birth:');
});

test('handles empty fields', async () => {
  const inputData = [
    ['id,first_name,last_name,ssn,date_of_birth\n'],
    ['159859483,,,,'],
  ];
  const linkData = await getLinkageKeys(
    Readable.from(inputData),
    linkageKeyDefinitions,
    keyAliases
  );

  expect(linkData.length).toBe(linkageKeyDefinitions.length);
  expect(linkData[0].length).toBe(1);
  expect(linkData[0][0]).toBe('ssn:;last_name:;date_of_birth:');
});

test('can return undefined', async () => {
  const inputData = [
    ['id,first_name,last_name,ssn,date_of_birth\n'],
    ['159859483,James,Heard,,12/32/1975'],
  ];
  const linkData = await getLinkageKeys(
    Readable.from(inputData),
    [
      [
        {outputFieldName: 'ssn', inputFieldName: 'ssn', formatter: (x: any) => {
          return !x ? undefined : x.replaceAll('-', '')
        }}
      ]
    ],
    keyAliases
  );

  expect(linkData.length).toBe(1);
  expect(linkData[0].length).toBe(1);
  expect(linkData[0][0]).toBeUndefined();
});
