from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shlex
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]
HARNESS = ROOT / "scripts/complete-web-check"
STAGE = ROOT / "scripts/pi-package-stage"
CUTOVER = ROOT / "scripts/pi-package-cutover"
MOCK = pathlib.Path(__file__).with_name("mock-shipped-entrypoint.py")
PACKAGE = pathlib.Path(__file__).with_name("package-fixture")


def run(*values, cwd=ROOT):
    return subprocess.run([str(item) for item in values], cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)


def digest(root: pathlib.Path) -> str:
    result = hashlib.sha256()
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            raise AssertionError(relative)
        if path.is_file():
            result.update(relative.encode())
            result.update(b"\0")
            result.update(path.read_bytes())
            result.update(b"\0")
    return result.hexdigest()


class QualificationTest(unittest.TestCase):
    def test_complete_fixed_harness_and_five_journeys(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = pathlib.Path(temporary) / "evidence"
            result = run(HARNESS, "--wiring-only", "--entrypoint", "python3", "--entrypoint-arg", MOCK, "--fixtures", ROOT / "packages/test-fixtures", "--output", output, "--timeout-ms", "5000")
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            manifest = json.loads((output / "complete-manifest.json").read_text())
            self.assertTrue(manifest["ok"])
            self.assertFalse(manifest["acceptanceEligible"])
            self.assertEqual(manifest["requiredPaths"], ["agent-browser/chrome", "pinchtab/chrome"])
            self.assertEqual(manifest["journeys"], ["J1", "J2", "J3", "J4", "J5"])
            self.assertGreaterEqual(manifest["browserCaseCount"], 26)
            self.assertEqual([case["id"] for case in manifest["cases"]], ["L01", "L02", "L03", "L04", "L05"])

    def test_harness_requires_shipped_entrypoint(self):
        result = run(HARNESS)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--entrypoint", result.stderr)

    def test_mock_cannot_satisfy_shipped_entrypoint_gate(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = run(HARNESS, "--profile", "clean-install", "--entrypoint", "python3", "--entrypoint-arg", MOCK, "--package", PACKAGE, "--output", pathlib.Path(temporary) / "evidence", "--timeout-ms", "5000")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("mock wiring cannot satisfy", result.stderr)

    def test_false_pass_lifecycle_evidence_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = run(HARNESS, "--wiring-only", "--profile", "clean-install", "--entrypoint", "python3", "--entrypoint-arg", MOCK, "--entrypoint-arg=--false-pass", "--entrypoint-arg", "L02", "--package", PACKAGE, "--output", pathlib.Path(temporary) / "evidence", "--timeout-ms", "5000")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unsafe or false evidence", result.stderr)

    def test_stage_isolated_package_and_reject_developer_link(self):
        with tempfile.TemporaryDirectory() as temporary:
            temporary = pathlib.Path(temporary)
            output = temporary / "stage"
            result = run(STAGE, "--source", PACKAGE, "--output", output)
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            record = json.loads(result.stdout)
            self.assertTrue(record["isolatedState"])
            self.assertFalse(record["registrationChanged"])
            self.assertEqual(record["aggregateSha256"], digest(output))
            self.assertTrue((output / "src/index.js").is_file())

            bad = temporary / "bad"
            shutil.copytree(PACKAGE, bad)
            manifest = json.loads((bad / "package.json").read_text())
            manifest["dependencies"] = {"unsafe": "workspace:*"}
            (bad / "package.json").write_text(json.dumps(manifest))
            bad_result = run(STAGE, "--source", bad, "--output", temporary / "bad-output")
            self.assertNotEqual(bad_result.returncode, 0)
            self.assertIn("developer link", bad_result.stderr)

    def test_cutover_dry_run_negatives_atomic_apply_and_rollback(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary).resolve()
            prior = root / "prior"
            candidate = root / "candidate"
            shutil.copytree(PACKAGE, prior)
            shutil.copytree(PACKAGE, candidate)
            (candidate / "src/index.js").write_text("export default () => ({ fixture: 'candidate' });\n")
            link = root / "registration/pi-web"
            link.parent.mkdir()
            os.symlink(str(prior), link)
            common = ["--registration-link", link, "--candidate", candidate, "--expected-current-target", str(prior), "--expected-current-sha256", digest(prior), "--candidate-sha256", digest(candidate), "--test-root", root]

            dry = run(CUTOVER, *common)
            self.assertEqual(dry.returncode, 0, dry.stderr)
            self.assertEqual(link.resolve(), prior)
            self.assertFalse(json.loads(dry.stdout.splitlines()[0])["applied"])
            self.assertIn("ROLLBACK:", dry.stdout)
            self.assertIn("/reload", dry.stdout)

            drift = run(CUTOVER, *["0" * 64 if value == digest(prior) else value for value in common])
            self.assertNotEqual(drift.returncode, 0)
            self.assertIn("identity drift", drift.stderr)

            unsafe = run(CUTOVER, "--registration-link", link, "--candidate", candidate, "--expected-current-target", str(prior), "--expected-current-sha256", digest(prior), "--candidate-sha256", digest(candidate), "--test-root", root / "registration")
            self.assertNotEqual(unsafe.returncode, 0)
            self.assertIn("non-live link", unsafe.stderr)

            unconfirmed = run(CUTOVER, *common, "--apply")
            self.assertNotEqual(unconfirmed.returncode, 0)
            self.assertEqual(link.resolve(), prior)

            applied = run(CUTOVER, *common, "--apply", "--confirm-atomic-link-replacement")
            self.assertEqual(applied.returncode, 0, applied.stderr)
            self.assertEqual(link.resolve(), candidate)
            plan = json.loads(applied.stdout.splitlines()[0])
            self.assertTrue(plan["applied"])
            rollback = run(*shlex.split(plan["rollbackCommand"]))
            self.assertEqual(rollback.returncode, 0, rollback.stderr)
            self.assertEqual(link.resolve(), prior)


if __name__ == "__main__":
    unittest.main()
