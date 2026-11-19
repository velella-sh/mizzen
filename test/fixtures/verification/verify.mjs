import { readFileSync } from "node:fs";
import { parseVerificationProof } from "../../../src/verification/proof.ts";
import { independentlyVerify } from "../../../src/verification/verify.ts";

const [proofPath, inputPath] = process.argv.slice(2);
if (proofPath === undefined || inputPath === undefined) {
  console.error("usage: verify.mjs <proof.json> <input.json>");
  process.exit(2);
}
const proof = parseVerificationProof(readFileSync(proofPath, "utf8"));
const input = JSON.parse(readFileSync(inputPath, "utf8"));
const report = await independentlyVerify(proof, { input });
process.stdout.write(JSON.stringify(report));
