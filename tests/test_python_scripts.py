import importlib.util
import json
import os
import sqlite3
import stat
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def encode_varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def pb_bytes(field_no, payload):
    return encode_varint((field_no << 3) | 2) + encode_varint(len(payload)) + payload


def pb_varint(field_no, val):
    return encode_varint((field_no << 3) | 0) + encode_varint(val)


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestSessionsCli(unittest.TestCase):
    def run_cli(self, args, env):
        return subprocess.run(
            [sys.executable, "-I", str(ROOT / "lib" / "sessions.py"), *args],
            capture_output=True, text=True, env=env, check=True,
        )

    def test_list_claude_slug_boundary(self):
        with tempfile.TemporaryDirectory() as td:
            proj = Path(td) / "projects"
            for slug in ("-Users-me-repo", "-Users-me-repo-sub", "-Users-me-repo2"):
                d = proj / slug
                d.mkdir(parents=True)
                (d / "sess-1.jsonl").write_text('{"type":"user"}\n', encoding="utf-8")
            res = self.run_cli(["list-claude", "--slug", "-Users-me-repo"], {**os.environ, "CLAUDE_CONFIG_DIR": td})
            files = [p for _, p in json.loads(res.stdout)["files"]]
            self.assertTrue(any("-Users-me-repo/sess-1.jsonl" in p for p in files))
            self.assertTrue(any("-Users-me-repo-sub/sess-1.jsonl" in p for p in files))
            self.assertFalse(any("-Users-me-repo2" in p for p in files))

    def test_read_claude_handles_at_at_null_text_and_sdk(self):
        with tempfile.TemporaryDirectory() as td:
            f = Path(td) / "abc-123.jsonl"
            f.write_text("\n".join([
                json.dumps({"type": "custom-title", "customTitle": "Fix @@ -1,2 +1,2 @@ hunk"}),
                json.dumps({"type": "user", "entrypoint": "sdk-cli", "cwd": "/tmp/proj", "gitBranch": "main",
                            "message": {"content": [{"type": "text", "text": None}, {"type": "text", "text": "check @@ diff"}]}}),
            ]) + "\n", encoding="utf-8")
            rec = json.loads(self.run_cli(["read-claude", str(f)], os.environ).stdout.strip())
            self.assertEqual((rec["id"], rec["title"], rec["prompt"], rec["n"], rec["sdk"]),
                             ("abc-123", "Fix @@ -1,2 +1,2 @@ hunk", "check @@ diff", 1, True))

    def test_list_others_filters_traversal_and_codex_null_text(self):
        with tempfile.TemporaryDirectory() as td:
            agy_dir = Path(td) / ".gemini" / "antigravity-cli"
            agy_dir.mkdir(parents=True)
            (agy_dir / "history.jsonl").write_text(
                "\n".join([
                    json.dumps({"conversationId": "../evil", "display": "bad", "timestamp": 1700000000000}),
                    json.dumps({"conversationId": "11111111-2222-3333-4444-555555555555", "display": "good agy", "timestamp": 1700000000000, "workspace": "/tmp/w"}),
                ]) + "\n",
                encoding="utf-8",
            )
            codex_sess = Path(td) / "codex_home" / "sessions" / "2026" / "01"
            codex_sess.mkdir(parents=True)
            (codex_sess / "rollout-2026-abcdef12.jsonl").write_text(
                "\n".join([
                    json.dumps({"type": "session_meta", "payload": {"id": "abcdef12", "cwd": "/tmp/c"}}),
                    json.dumps({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"text": None}, {"text": "hello codex"}]}}),
                ]) + "\n",
                encoding="utf-8",
            )
            env = {**os.environ, "HOME": td, "CODEX_HOME": str(Path(td) / "codex_home")}
            res = self.run_cli(["list-others"], env)
            recs = [json.loads(line) for line in res.stdout.splitlines() if line.strip()]
            ids = {r["id"] for r in recs}
            self.assertNotIn("../evil", ids)
            self.assertIn("11111111-2222-3333-4444-555555555555", ids)
            self.assertIn("abcdef12", ids)


class TestConvoAndPrompts(unittest.TestCase):
    def test_convo_agy_traversal_and_sqlite(self):
        with tempfile.TemporaryDirectory() as td:
            env = {**os.environ, "HOME": td}
            bad = subprocess.run(
                [sys.executable, "-I", str(ROOT / "mods" / "vnh-convo" / "convo.py"), "agy", "../../etc/passwd"],
                capture_output=True, text=True, env=env, check=True,
            )
            out = json.loads(bad.stdout)
            self.assertEqual(out["turns"], [])
            self.assertIn("Invalid", out["note"])

            cid = "11111111-2222-3333-4444-555555555555"
            cdir = Path(td) / ".gemini" / "antigravity-cli" / "conversations"
            cdir.mkdir(parents=True)
            db = cdir / f"{cid}.db"
            with sqlite3.connect(str(db)) as con:
                con.execute("CREATE TABLE steps (idx INTEGER, metadata BLOB, step_type INTEGER, step_payload BLOB)")
                md = pb_bytes(1, pb_varint(1, 1700000000))
                p14 = pb_bytes(19, pb_bytes(2, b"User prompt"))
                p15 = pb_bytes(20, pb_bytes(1, b"Agent reply"))
                con.execute("INSERT INTO steps VALUES (1, ?, 14, ?)", (md, p14))
                con.execute("INSERT INTO steps VALUES (2, ?, 15, ?)", (md, p15))
            good = subprocess.run(
                [sys.executable, "-I", str(ROOT / "mods" / "vnh-convo" / "convo.py"), "agy", cid],
                capture_output=True, text=True, env=env, check=True,
            )
            parsed = json.loads(good.stdout)
            self.assertEqual(parsed["note"], "")
            self.assertEqual(len(parsed["turns"]), 1)
            self.assertEqual(parsed["turns"][0]["text"], "User prompt")
            self.assertEqual(parsed["turns"][0]["reply"], "Agent reply")

    def test_convo_codex_short_cid_and_null_text(self):
        with tempfile.TemporaryDirectory() as td:
            sdir = Path(td) / "sessions" / "2026"
            sdir.mkdir(parents=True)
            (sdir / "rollout-feedbeef12.jsonl").write_text(
                "\n".join([
                    json.dumps({"type": "response_item", "timestamp": "2026-01-01T00:00:00Z", "payload": {"type": "message", "role": "user", "content": [{"text": None}, {"text": "hi"}]}}),
                    json.dumps({"type": "response_item", "timestamp": "2026-01-01T00:00:01Z", "payload": {"type": "message", "role": "assistant", "content": [{"text": "yo"}]}}),
                ]) + "\n",
                encoding="utf-8",
            )
            env = {**os.environ, "HOME": td, "CODEX_HOME": td}
            bad = subprocess.run(
                [sys.executable, "-I", str(ROOT / "mods" / "vnh-convo" / "convo.py"), "codex", "!!!"],
                capture_output=True, text=True, env=env, check=True,
            )
            self.assertEqual(json.loads(bad.stdout)["turns"], [])
            ok = subprocess.run(
                [sys.executable, "-I", str(ROOT / "mods" / "vnh-convo" / "convo.py"), "codex", "feedbeef12"],
                capture_output=True, text=True, env=env, check=True,
            )
            data = json.loads(ok.stdout)
            self.assertEqual(data["turns"][0]["text"], "hi")
            self.assertEqual(data["turns"][0]["reply"], "yo")

    def test_claude_info_alive_and_effort(self):
        mod = load_module("claude_info", ROOT / "mods" / "vnh-prompts" / "claude-info.py")
        self.assertFalse(mod.alive(0))
        self.assertFalse(mod.alive(-5))
        self.assertFalse(mod.alive("123"))
        with tempfile.TemporaryDirectory() as td:
            tr = Path(td) / "t.jsonl"
            tr.write_text(
                json.dumps({"type": "api-request", "params": {"model": "claude-opus-5-5", "effort": "high"}}) + "\n",
                encoding="utf-8",
            )
            info = mod.read(str(tr))
            self.assertEqual(info["effort"], "high")
            self.assertEqual(info["model"], "Opus 5.5")

    def test_prompts_py_handles_null_text(self):
        with tempfile.TemporaryDirectory() as td:
            tr = Path(td) / "t.jsonl"
            tr.write_text(
                "\n".join([
                    json.dumps({"type": "user", "timestamp": "2026-01-01T00:00:00Z", "message": {"content": [{"type": "text", "text": None}, {"type": "text", "text": "hello"}]}}),
                    json.dumps({"type": "assistant", "timestamp": "2026-01-01T00:00:02Z", "message": {"id": "m1", "usage": {"input_tokens": 10, "output_tokens": 5}, "content": [{"type": "text", "text": None}, {"type": "text", "text": "done"}]}}),
                ]) + "\n",
                encoding="utf-8",
            )
            res = subprocess.run(
                [sys.executable, "-I", str(ROOT / "mods" / "vnh-prompts" / "prompts.py"), str(tr)],
                capture_output=True, text=True, check=True,
            )
            data = json.loads(res.stdout)
            self.assertEqual(len(data["prompts"]), 1)
            self.assertEqual(data["prompts"][0]["text"], "hello")
            self.assertEqual(data["prompts"][0]["reply"], "done")


class TestHxOpen(unittest.TestCase):
    def test_hx_open_toml_quoting_sections_and_theme_bools(self):
        with tempfile.TemporaryDirectory() as td:
            cfg_dir = Path(td) / "xdg" / "helix"
            themes_dir = cfg_dir / "themes"
            themes_dir.mkdir(parents=True)
            (cfg_dir / "config.toml").write_text(
                'theme = "mytheme"\n[keys.normal]\nm = "move"\nesc = "collapse_selection"\n[keys.normal.space] # user note\n',
                encoding="utf-8",
            )
            (themes_dir / "mytheme.toml").write_text(
                '"ui.background" = { bg = "#000000" }\n"ui.text" = { bg = "#000000", bold = true }\n',
                encoding="utf-8",
            )
            bin_dir = Path(td) / "bin"
            bin_dir.mkdir()
            hx_stub = bin_dir / "hx"
            hx_stub.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            hx_stub.chmod(hx_stub.stat().st_mode | stat.S_IEXEC)

            evil_path = os.path.join(td, "$(touch /tmp/pwn)'\" .md")
            env = {**os.environ, "HOME": td, "XDG_CONFIG_HOME": str(Path(td) / "xdg"), "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}"}
            env.pop("HC_TERMINAL_ID", None)
            subprocess.run(
                [sys.executable, "-I", str(ROOT / "mods" / "vnh-filetree" / "hx-open.py"), evil_path, "", "#112233"],
                env=env, check=True,
            )
            cfg = tomllib.loads((Path(td) / ".cache" / "vnh-hx" / "config.toml").read_text(encoding="utf-8"))
            self.assertEqual(cfg["theme"], "vnh-herdr")
            self.assertEqual(cfg["keys"]["normal"]["esc"], ":quit")
            bind = cfg["keys"]["normal"]["space"]["m"]
            self.assertNotIn("%{buffer_name}", bind)
            self.assertIn("hx-md.py", bind)
            self.assertIn("$(touch /tmp/pwn)", bind)

            theme = tomllib.loads((themes_dir / "vnh-herdr.toml").read_text(encoding="utf-8"))
            self.assertEqual(theme["ui.text"]["bg"], "#112233")
            self.assertIs(theme["ui.text"]["bold"], True)


if __name__ == "__main__":
    unittest.main()
