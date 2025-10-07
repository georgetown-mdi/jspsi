import fs from 'node:fs'

import { expect, test } from 'vitest'

import { getDataForFixedRuleLink } from '../src/fixedRuleLink'

const dataA = await getDataForFixedRuleLink(
  fs.createReadStream('../../fake_data_1.csv'),
  true
);

test('no results are empty', () => {
  for (const col of dataA) {
    for (const val of col) {
      expect(val).toBeDefined();
      expect(val).toSatisfy((x: any) => x !== '');
    }
  }
});
