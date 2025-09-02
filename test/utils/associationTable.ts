import type { AssociationTable } from 'src/psi/psi'

export const sortAssociationTable = (
  value: AssociationTable,
  reverse?: boolean
) => {
  return reverse ?
    value[1]
    .map((x, i) => ({ x: x, y: value[0][i]}))
    .sort((a, b) => a.x - b.x)
    .reduce((acc, v) => {
        acc[1].push(v.x);
        acc[0].push(v.y);
        return acc
      },
      [[], []] as [Array<number>, Array<number>]
    ) :
    value[0]
    .map((x, i) => ({ x: x, y: value[1][i]}))
    .sort((a, b) => a.x - b.x)
    .reduce((acc, v) => {
        acc[0].push(v.x);
        acc[1].push(v.y);
        return acc
      },
      [[], []] as [Array<number>, Array<number>]
    );
}