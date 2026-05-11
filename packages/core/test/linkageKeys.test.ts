import { Readable } from "node:stream";

import { expect, test } from "vitest";

import { getMetadataAndLinkageKeys } from "../src/linkageKeys";

import type { LinkageKeyDefinition } from "../src/types";

const formatters = {
  ssn: (x: unknown) =>
    typeof x === "string" && x ? x.replaceAll("-", "") : "",
  first_name: (x: unknown) =>
    typeof x === "string" && x ? x.toUpperCase() : "",
  last_name: (x: unknown) =>
    typeof x === "string" && x ? x.toUpperCase() : "",
  date_of_birth: (x: unknown) =>
    x instanceof Date && !isNaN(x.getDate())
      ? x.toISOString().substring(0, 10)
      : "",
};

const linkageKeyDefinitions: Array<LinkageKeyDefinition> = [
  [
    {
      outputFieldName: "ssn",
      inputFieldName: "ssn",
      formatter: formatters["ssn"],
    },
    {
      outputFieldName: "last_name",
      inputFieldName: "lastName",
      formatter: formatters["last_name"],
    },
    {
      outputFieldName: "date_of_birth",
      inputFieldName: "dateOfBirth",
      formatter: formatters["date_of_birth"],
    },
  ],
];

const extraLinkageKeyDefinitions: Array<LinkageKeyDefinition> = [
  [
    {
      outputFieldName: "ssn",
      inputFieldName: "ssn",
      formatter: formatters["ssn"],
    },
    {
      outputFieldName: "last_name",
      inputFieldName: "lastName",
      formatter: formatters["last_name"],
    },
    {
      outputFieldName: "first_name_1",
      inputFieldName: "firstName",
      formatter: (x) => formatters["first_name"](x).substring(0, 1),
    },
  ],
];

test("handles trailing newline", async () => {
  const inputData = [
    ["id,first_name,last_name,ssn,date_of_birth\n"],
    ["159859483,James,Heard,559-81-1301,7/16/1975\n"],
  ];
  const { metadata: _metadata, linkageKeys} = await getMetadataAndLinkageKeys(
    Readable.from(inputData),
    linkageKeyDefinitions
  );

  expect(linkageKeys.length).toBe(linkageKeyDefinitions.length);
  expect(linkageKeys[0].length).toBe(1);
});

test("handles no trailing newline", async () => {
  const inputData = [
    ["id,first_name,last_name,ssn,date_of_birth\n"],
    ["159859483,James,Heard,559-81-1301,7/16/1975"],
  ];
  const { metadata: _metadata, linkageKeys } = await getMetadataAndLinkageKeys(
    Readable.from(inputData),
    linkageKeyDefinitions
  );

  expect(linkageKeys.length).toBe(linkageKeyDefinitions.length);
  expect(linkageKeys[0].length).toBe(1);
});

test("handles valid input", async () => {
  const inputData = [
    ["id,first_name,last_name,ssn,date_of_birth\n"],
    ["159859483,James,Heard,559-81-1301,7/16/1975\n"],
    ["165562801,Albert,Iorio,322-84-2281,8/17/1975"],
  ];
  const { metadata: _metadata, linkageKeys } = await getMetadataAndLinkageKeys(
    Readable.from(inputData),
    [...linkageKeyDefinitions, ...extraLinkageKeyDefinitions],
  );

  expect(linkageKeys.length).toBe(
    linkageKeyDefinitions.length + extraLinkageKeyDefinitions.length,
  );
  expect(linkageKeys[0].length).toBe(2);
  expect(linkageKeys[0][0]).toBe(
    "ssn:559811301;last_name:HEARD;date_of_birth:1975-07-16",
  );
  expect(linkageKeys[0][1]).toBe(
    "ssn:322842281;last_name:IORIO;date_of_birth:1975-08-17",
  );
  expect(linkageKeys[1][0]).toBe("ssn:559811301;last_name:HEARD;first_name_1:J");
  expect(linkageKeys[1][1]).toBe("ssn:322842281;last_name:IORIO;first_name_1:A");
});

test("handles empty inputs", async () => {
  const inputData = [
    ["id,first_name,last_name,ssn,date_of_birth\n"],
    ["159859483,James,Heard,559-81-1301,7/16/1975\n"],
    [],
  ];
  const { metadata: _metadata, linkageKeys } = await getMetadataAndLinkageKeys(
    Readable.from(inputData),
    linkageKeyDefinitions
  );

  expect(linkageKeys.length).toBe(linkageKeyDefinitions.length);
  expect(linkageKeys[0].length).toBe(1);
});

test("handles invalid dates", async () => {
  const inputData = [
    ["id,first_name,last_name,ssn,date_of_birth\n"],
    ["159859483,James,Heard,559-81-1301,12/32/1975"],
  ];
  const { metadata: _metadata, linkageKeys } = await getMetadataAndLinkageKeys(
    Readable.from(inputData),
    linkageKeyDefinitions
  );

  expect(linkageKeys.length).toBe(linkageKeyDefinitions.length);
  expect(linkageKeys[0].length).toBe(1);
  expect(linkageKeys[0][0]).toBe("ssn:559811301;last_name:HEARD;date_of_birth:");
});

test("handles empty fields", async () => {
  const inputData = [
    ["id,first_name,last_name,ssn,date_of_birth\n"],
    ["159859483,,,,"],
  ];
  const { metadata: _metadata, linkageKeys } = await getMetadataAndLinkageKeys(
    Readable.from(inputData),
    linkageKeyDefinitions
  );

  expect(linkageKeys.length).toBe(linkageKeyDefinitions.length);
  expect(linkageKeys[0].length).toBe(1);
  expect(linkageKeys[0][0]).toBe("ssn:;last_name:;date_of_birth:");
});

test("can return undefined", async () => {
  const inputData = [
    ["id,first_name,last_name,ssn,date_of_birth\n"],
    ["159859483,James,Heard,,12/32/1975"],
  ];
  const { metadata: _metadata, linkageKeys } = await getMetadataAndLinkageKeys(
    Readable.from(inputData),
    [
      [
        {
          outputFieldName: "ssn",
          inputFieldName: "ssn",
          formatter: (x) => {
            return !x || typeof x !== "string"
              ? undefined
              : x.replaceAll("-", "");
          },
        },
      ],
    ]
  );

  expect(linkageKeys.length).toBe(1);
  expect(linkageKeys[0].length).toBe(1);
  expect(linkageKeys[0][0]).toBeUndefined();
});
