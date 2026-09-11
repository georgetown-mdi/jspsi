import { describe, expect, test } from "vitest";

import {
  REGEX_STEP_PATTERN_PARAM,
  regexStepPatternParam,
} from "../src/config/transformRegexDialect";
import {
  declaredTransformParamType,
  transformParamTypeRefusals,
} from "../src/config/transformParamTypes";
import { safeParseLinkageTerms } from "../src/config/linkageTermsSchema";
import {
  summarizeInvitation,
  TRANSFORM_FUNCTION_GLOSSARY,
} from "../src/consent/invitationSummary";
import { UnknownStandardizationFunctionError } from "../src/errors";
import { CONSENT_VERDICT_PARAM_NAMES } from "../src/linkageSatisfiability";
import {
  runPipeline,
  STANDARDIZATION_FUNCTION_DESCRIPTORS,
} from "../src/standardization";

// A transform step's `function` is free text a counterparty authors, and every
// table below is keyed by one. Each is built with no prototype and frozen, so
// the names that resolve only on Object.prototype resolve to nothing, whether a
// reader guards its own index or not.
const PROTOTYPE_MEMBER_NAMES = [
  "constructor",
  "toString",
  "__proto__",
  "hasOwnProperty",
];

const exportedRegistries: Array<[string, object]> = [
  ["CONSENT_VERDICT_PARAM_NAMES", CONSENT_VERDICT_PARAM_NAMES],
  ["REGEX_STEP_PATTERN_PARAM", REGEX_STEP_PATTERN_PARAM],
  [
    "STANDARDIZATION_FUNCTION_DESCRIPTORS",
    STANDARDIZATION_FUNCTION_DESCRIPTORS,
  ],
  ["TRANSFORM_FUNCTION_GLOSSARY", TRANSFORM_FUNCTION_GLOSSARY],
];

const termsNamingFunction = (
  functionName: string,
  params: Record<string, unknown> = { pattern: "^x$" },
): Record<string, unknown> => ({
  version: "1.0.0",
  identity: "Test Party",
  date: "2025-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [
    {
      name: "SSN",
      elements: [
        {
          field: "ssn",
          transform: [{ function: functionName, params }],
        },
      ],
    },
  ],
});

describe("the transform registries a decoded document indexes", () => {
  test("carry no prototype and no writable rows", () => {
    for (const [label, table] of exportedRegistries) {
      expect(Object.getPrototypeOf(table), label).toBeNull();
      expect(Object.isFrozen(table), label).toBe(true);
      expect(() => {
        (table as Record<string, unknown>)["split_on"] = "replaced";
      }, label).toThrow(TypeError);
    }
  });

  test("answer an Object.prototype member name with nothing on a direct index", () => {
    for (const [label, table] of exportedRegistries)
      for (const name of PROTOTYPE_MEMBER_NAMES)
        expect(
          (table as Record<string, unknown>)[name],
          `${label}.${name}`,
        ).toBeUndefined();
  });

  test("answer an Object.prototype member name with nothing through their readers", () => {
    // The registries the readers below index are module-private, so the reader
    // is where a name reaches them: the pattern-param map, both levels of the
    // declared-type table, and the factory registry.
    for (const name of PROTOTYPE_MEMBER_NAMES) {
      expect(regexStepPatternParam(name), name).toBeUndefined();
      expect(declaredTransformParamType(name, "pattern"), name).toBeUndefined();
      expect(
        declaredTransformParamType("filter_regex", name),
        name,
      ).toBeUndefined();
      expect(
        transformParamTypeRefusals({
          function: name,
          params: { pattern: 123 },
        }),
        name,
      ).toEqual([]);
      expect(() => runPipeline("x", [{ function: name }]), name).toThrow(
        UnknownStandardizationFunctionError,
      );
    }
  });

  test("leave a decoded step naming an Object.prototype member unrecognized", () => {
    // The whole path a partner's document takes: the decode admits the name as
    // the bounded free text it is, and compiling the step it decoded refuses it
    // as a function this build does not have -- never an inherited member the
    // pipeline would call.
    for (const name of PROTOTYPE_MEMBER_NAMES) {
      const decoded = safeParseLinkageTerms(termsNamingFunction(name));
      expect(decoded.success, name).toBe(true);
      if (!decoded.success) continue;
      const steps = decoded.data.linkageKeys[0].elements[0].transform ?? [];
      expect(steps[0].function, name).toBe(name);
      expect(() => runPipeline("x", steps), name).toThrow(
        UnknownStandardizationFunctionError,
      );
    }
  });

  test("lead the displayed params of a listed name, never of a prototype member", () => {
    // CONSENT_VERDICT_PARAM_NAMES is read by a module-private ordering step, so
    // the consent summary is where a partner-authored name reaches it: a listed
    // function leads with the params a verdict reads, and a name resolving only
    // on Object.prototype leads with nothing rather than with the inherited
    // member a bare index would hand the ordering set.
    const declared = {
      unlistedParam: "x",
      outputFormat: "YYYYMMDD",
      inputFormat: "MM/DD/YYYY",
    };
    const displayedParams = (functionName: string): string[] => {
      const decoded = safeParseLinkageTerms(
        termsNamingFunction(functionName, declared),
      );
      expect(decoded.success, functionName).toBe(true);
      if (!decoded.success) return [];
      const summary = summarizeInvitation({ linkageTerms: decoded.data });
      return summary.linkageKeys[0].elements[0].transforms[0].params.map(
        String,
      );
    };
    expect(displayedParams("parse_date")).toEqual([
      "outputFormat: YYYYMMDD",
      "inputFormat: MM/DD/YYYY",
      "unlistedParam: x",
    ]);
    for (const name of PROTOTYPE_MEMBER_NAMES)
      expect(displayedParams(name), name).toEqual([
        "unlistedParam: x",
        "outputFormat: YYYYMMDD",
        "inputFormat: MM/DD/YYYY",
      ]);
  });
});
