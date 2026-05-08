import { loadCSVFile } from "./file";

import { ColumnsIterable } from "./columnIterable";

import type { LocalFile } from "papaparse";

import type { LinkageKeyDefinition } from "./types";
import type { FieldAliases } from './config/metadata'

export async function getLinkageKeys(
  file: LocalFile,
  linkageKeyDefinitions: Array<LinkageKeyDefinition>,
  fieldAliases: FieldAliases,
): Promise<Array<ColumnsIterable>> {
  const input = await loadCSVFile(file);
  const rawData = input.data as Array<Record<string, string>>;
  const keyAliasMap: Record<string, string> = {};

  const keys = Object.keys(rawData[0]);
  const lowerCaseKeys = keys.map((key) => key.toLowerCase());

  Object.entries(fieldAliases).forEach(([key, aliases]) => {
    let i;
    if ((i = lowerCaseKeys.indexOf(key)) >= 0) {
      keyAliasMap[key] = keys[i];
      return;
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
  const data = rawData.map(
    (row): Record<string, string | Date> => ({
      ...row,
      [keyAliasMap["date_of_birth"]]: new Date(
        row[keyAliasMap["date_of_birth"]],
      ),
    }),
  );

  return linkageKeyDefinitions.map((key) => {
    return new ColumnsIterable(
      data,
      ...key.map(({ outputFieldName, inputFieldName, formatter }) => {
        return [outputFieldName, keyAliasMap[inputFieldName], formatter] as [
          string,
          string,
          (x: unknown) => string,
        ];
      }),
    );
  });
}
