import { parseXml, XmlDocumentType, XmlElement } from "@rgrove/parse-xml";
import type { Envelope, TestResult } from "./format.ts";

type TestPayload = Extract<Envelope, { kind: "test" }>["payload"];
type TestFinding = Pick<TestResult, "suite" | "name"> & {
  readonly surface?: string;
  readonly behavior?: string;
  readonly outcome: TestResult["outcome"] | "duplicate" | "deleted" | "unmapped";
};

function junit(xml: string): TestResult[] {
  const document = parseXml(xml, { preserveDocumentType: true, rejectAttributeListDeclarations: true });
  if (document.children.some((node) => node instanceof XmlDocumentType)) {
    throw new Error("JUnit reports must omit the document type declaration.");
  }
  const root = document.root;
  if (root === null || (root.name !== "testsuite" && root.name !== "testsuites")) {
    throw new Error("JUnit reports must have a testsuite or testsuites root.");
  }
  const results: TestResult[] = [];
  const visit = (node: XmlElement): void => {
    for (const child of node.children) {
      if (!(child instanceof XmlElement)) continue;
      if (child.name === "testsuite") {
        visit(child);
      } else if (node.name === "testsuite" && child.name === "testcase") {
        const name = child.attributes.name;
        if (name === undefined || name.trim() === "") throw new Error("Every JUnit testcase needs a name.");
        const tags = new Set(child.children.filter((item) => item instanceof XmlElement).map((item) => item.name));
        const outcome = tags.has("failure") || tags.has("error") ? "failed" : tags.has("skipped") ? "skipped" : "passed";
        results.push({ suite: child.attributes.classname ?? node.attributes.name ?? "", name, outcome });
      } else if (child.name === "testcase") {
        throw new Error("JUnit testcase must be inside a testsuite.");
      }
    }
  };
  visit(root);
  return results;
}

function testKey(test: Pick<TestResult, "suite" | "name">): string {
  return JSON.stringify([test.suite, test.name]);
}

/** One row per qualified name, including catalog entries absent from the run. */
export function testFindings(payload: TestPayload): readonly TestFinding[] {
  const report = typeof payload.results === "string" ? junit(payload.results) : payload.results;
  const catalog = new Map<string, TestPayload["catalog"][number]>();
  for (const entry of payload.catalog) {
    const key = testKey(entry);
    if (catalog.has(key)) throw new Error(`Duplicate test catalog name ${key}.`);
    catalog.set(key, entry);
  }
  const results = new Map<string, TestFinding>();
  for (const test of report) {
    const key = testKey(test);
    const target = catalog.get(key);
    const outcome = results.has(key) ? "duplicate" : target === undefined ? "unmapped" : test.outcome;
    results.set(key, { suite: test.suite, name: test.name, ...(target ?? {}), outcome });
  }
  for (const [key, target] of catalog) {
    if (!results.has(key)) results.set(key, { ...target, outcome: "deleted" });
  }
  return [...results.keys()].sort().map((key) => results.get(key)!);
}
