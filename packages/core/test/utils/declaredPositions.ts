import { fileURLToPath } from "node:url";

import ts from "typescript";

const CORE_ROOT_URL = new URL("../../", import.meta.url);

/** Absolute path of a `packages/core` file named relative to the package root. */
function corePath(relative: string): string {
  return fileURLToPath(new URL(relative, CORE_ROOT_URL));
}

/**
 * Type flags holding no properties of their own, so a position of that type is
 * where a path ends. `VoidLike` covers the `undefined` an optional property's
 * union holds.
 */
const STRUCTURELESS_TYPE =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.VoidLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Never |
  ts.TypeFlags.Any |
  ts.TypeFlags.Unknown;

/** What to walk, and the two respects in which callers differ. */
export interface DeclaredPositionsRequest {
  /** The file declaring {@link rootInterface}, relative to `packages/core`. */
  sourcePathFromCoreRoot: string;
  /** Name of the interface the walk descends from. */
  rootInterface: string;
  /**
   * Whether an intersection holding a string constituent ends a path. A
   * `Displayable` is `string` intersected with a phantom brand property, so a
   * caller whose structs hold one sets this: descending into the brand would
   * invent a position no value ever holds.
   */
  stringIntersectionEndsPath?: boolean;
  /**
   * Positions whose index-signature type IS the value the caller reasons
   * about, rather than structure to descend through. An index signature
   * declares no property paths, so a type holding one contributes nothing to
   * the walk; naming a position here declares that silence intended, and
   * every unnamed position with one throws instead. A named position holding
   * no index signature throws too, so the exemption cannot outlive its cause.
   */
  recordValuePositions?: ReadonlyArray<string>;
}

/** The positions a walk found, and the subset of them declared optional. */
export interface DeclaredPositions {
  /** Every position the root interface and the structs under it declare. */
  all: Set<string>;
  /**
   * The subset declared `?` -- the positions that hold nothing unless a fixture
   * reaches them, and so the ones a walk over built values says nothing about
   * until one does.
   */
  optional: Set<string>;
}

/**
 * Every property path {@link DeclaredPositionsRequest.rootInterface} and the
 * structs nested under it declare, read from those declarations with the
 * compiler API at test time, with array and tuple indices collapsed to `[]`.
 * Derived rather than listed by its callers, so what each of them checks
 * must fail on a field added to core; throwing rather than returning less
 * keeps a walk that stops short from silently shrinking that coverage.
 */
export function declaredPositions({
  sourcePathFromCoreRoot,
  rootInterface,
  stringIntersectionEndsPath = false,
  recordValuePositions = [],
}: DeclaredPositionsRequest): DeclaredPositions {
  const sourcePath = corePath(sourcePathFromCoreRoot);
  const configPath = corePath("tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error !== undefined)
    throw new Error(
      `cannot read ${configPath} for the ${rootInterface} derivation`,
    );
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    corePath("."),
  );
  const program = ts.createProgram({
    rootNames: [sourcePath],
    options: { ...parsed.options, noEmit: true },
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(sourcePath);
  if (source === undefined)
    throw new Error(`${sourcePath} is not in the program`);
  const root = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === rootInterface,
  );
  if (root === undefined)
    throw new Error(`${rootInterface} is not declared in ${sourcePath}`);

  const all = new Set<string>();
  const optional = new Set<string>();
  const recordValue = new Set(recordValuePositions);
  const recordValueFound = new Set<string>();

  const endsPath = (type: ts.Type): boolean => {
    if ((type.flags & STRUCTURELESS_TYPE) !== 0) return true;
    return (
      stringIntersectionEndsPath &&
      type.isIntersection() &&
      type.types.some(
        (member) => (member.flags & ts.TypeFlags.StringLike) !== 0,
      )
    );
  };

  // `enclosing` is the chain of struct types the current path runs through, so a
  // struct that ever nests itself terminates instead of descending forever; every
  // other repetition is a distinct path and is walked.
  const collect = (
    type: ts.Type,
    prefix: string,
    enclosing: ReadonlySet<ts.Type>,
  ): void => {
    for (const property of type.getProperties()) {
      const declaration =
        property.valueDeclaration ?? property.declarations?.[0];
      if (declaration === undefined)
        throw new Error(`no declaration for ${prefix}.${property.name}`);
      const position =
        prefix === "" ? property.name : `${prefix}.${property.name}`;
      all.add(position);
      if ((property.flags & ts.SymbolFlags.Optional) !== 0)
        optional.add(position);
      descend(
        checker.getTypeOfSymbolAtLocation(property, declaration),
        position,
        enclosing,
      );
    }
  };

  const descend = (
    type: ts.Type,
    position: string,
    enclosing: ReadonlySet<ts.Type>,
  ): void => {
    if (endsPath(type) || enclosing.has(type)) return;
    if (type.isUnion()) {
      for (const member of type.types) descend(member, position, enclosing);
      return;
    }
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      for (const element of checker.getTypeArguments(type as ts.TypeReference))
        descend(element, `${position}[]`, enclosing);
      return;
    }
    if (type.isIntersection()) {
      for (const member of type.types) descend(member, position, enclosing);
      return;
    }
    if (checker.getIndexInfosOfType(type).length > 0) {
      const named = position === "" ? rootInterface : position;
      if (!recordValue.has(named))
        throw new Error(
          `${named} carries an index signature, which declares no property paths for the ${rootInterface} derivation to walk`,
        );
      recordValueFound.add(named);
    }
    collect(type, position, new Set(enclosing).add(type));
  };

  descend(checker.getTypeAtLocation(root.name), "", new Set());

  const unfound = [...recordValue]
    .filter((position) => !recordValueFound.has(position))
    .sort();
  if (unfound.length > 0)
    throw new Error(
      `the ${rootInterface} derivation reached no index signature at ${unfound.join(", ")}`,
    );

  return { all, optional };
}
