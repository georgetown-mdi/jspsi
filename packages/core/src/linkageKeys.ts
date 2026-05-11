/**
 * NOTE: we want to move away from what is in this file in favor of the
 * linkage keys in src/config. Once data transformations have been implemented
 * we will hopefully be able to do so.
 */

import type { LocalFile } from "papaparse";

import { ColumnsIterable } from "./columnIterable";
import { loadCSVFile } from "./file";

import {
  type ColumnMetadata,
  inferMetadata,
  type ColumnType,
} from "./config/metadata";
import type { LinkageKeyDefinition } from "./types";

export interface LinkageKeysResult {
  metadata: Array<ColumnMetadata>;
  linkageKeys: Array<ColumnsIterable>;
}

export async function getMetadataAndLinkageKeys(
  file: LocalFile,
  linkageKeyDefinitions: Array<LinkageKeyDefinition>,
): Promise<LinkageKeysResult> {
  const input = await loadCSVFile(file);
  const metadata = inferMetadata(input.meta.fields!);
  const rawData = input.data as Array<Record<string, string>>;

  const typeNameMap = metadata.reduce(
    (acc, m) => {
      return {
        ...acc,
        [m.type]: m.name,
      };
    },
    {} as Record<ColumnType, string>,
  );

  // turn date-of-birth into Date objects
  const data = rawData.map(
    (row): Record<string, string | Date> => ({
      ...row,
      [typeNameMap["dateOfBirth"]]: new Date(row[typeNameMap["dateOfBirth"]]),
    }),
  );

  return {
    metadata,
    linkageKeys: linkageKeyDefinitions.map((key) => {
      return new ColumnsIterable(
        data,
        ...key.map(({ outputFieldName, inputFieldName, formatter }) => {
          return [
            outputFieldName,
            typeNameMap[inputFieldName as ColumnType],
            formatter,
          ] as [string, string, (x: unknown) => string];
        }),
      );
    }),
  };
}
