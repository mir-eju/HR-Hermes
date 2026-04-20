"""Hermes plugin: forward tool audit events to HR-Hermes Firestore via `admin/dist/cli.js hook-audit`."""

from __future__ import annotations

import json
import os
import subprocess
from typing import Any, Dict


def _audit(payload: Dict[str, Any]) -> None:
    root = os.environ.get("HR_HERMES_ROOT", ".")
    subprocess.run(
        ["node", "admin/dist/cli.js", "hook-audit"],
        cwd=root,
        input=json.dumps(payload).encode("utf-8"),
        check=False,
    )


def register(ctx: Any) -> None:
    def pre_tool_call(tool_name: str, args: dict, task_id: str, **kwargs: Any) -> None:
        _audit(
            {
                "kind": "hook",
                "tool": tool_name,
                "input": args,
                "hermesTurnId": task_id,
            }
        )

    def post_tool_call(tool_name: str, args: dict, result: str, task_id: str, **kwargs: Any) -> None:
        _audit(
            {
                "kind": "hook",
                "tool": tool_name,
                "input": args,
                "output": result,
                "hermesTurnId": task_id,
            }
        )

    ctx.register_hook("pre_tool_call", pre_tool_call)
    ctx.register_hook("post_tool_call", post_tool_call)
