#!/usr/bin/env python3
"""One-shot, context-only Pro consultation through the isolated local bridge.

No tools, automatic retries, credential copying, or Pi/Codex configuration changes.
Retains the exact request and SSE stream in a new private directory on every run.
"""
import argparse
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request
import uuid


def extract_answer(response):
    return "\n\n".join(
        part["text"]
        for item in response.get("output", [])
        if item.get("type") == "message" and item.get("role") == "assistant"
        for part in item.get("content", [])
        if part.get("type") == "output_text" and isinstance(part.get("text"), str)
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", type=Path, help="Self-contained UTF-8 question and evidence")
    parser.add_argument("--output", type=Path, required=True, help="New directory; must not exist")
    args = parser.parse_args()
    prompt = args.prompt.read_text()
    if not prompt.strip():
        parser.error("Prompt is empty")
    root = Path(os.environ.get("CODEX_WEB_GPT_HEADLESS_ROOT", Path.home() / ".local/share/codex-web-gpt-headless"))
    config = json.loads((root / "state/core/config.json").read_text())
    if config.get("host") != "127.0.0.1" or config.get("mode") != "browser-only":
        parser.error("Requires the isolated loopback browser-only bridge")
    if not config.get("proAvailable") or config.get("browserInteractionMode") != "automatic":
        parser.error("Bridge has not detected automatic Pro access")
    base = f"http://127.0.0.1:{int(config['port'])}"
    # Never send local context through an environment-configured HTTP proxy.
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with http.open(base + "/healthz", timeout=10) as result:
        health = json.load(result)
    if health.get("service") != "codex-chatgpt-web" or health.get("mode") != "browser-only" or not health.get("accepting_turns"):
        parser.error("Bridge is not ready for browser-only requests")
    if health.get("active_http_turns") or health.get("active_browser_turns"):
        parser.error("Bridge has active turns; inspect them before another consultation")
    thread, turn = str(uuid.uuid4()), str(uuid.uuid4())
    request = {
        "model": "chatgpt-web/pro", "stream": True, "store": False,
        "tools": [], "tool_choice": "none", "prompt_cache_key": thread,
        "client_metadata": {"x-codex-turn-metadata": json.dumps({"thread_id": thread, "turn_id": turn})},
        "input": [{"type": "message", "role": "user", "content": prompt,
                   "internal_chat_message_metadata_passthrough": {"turn_id": turn}}],
    }
    os.umask(0o077)
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    def save(name, value):
        (args.output / name).write_text(json.dumps(value, indent=2) + "\n")
    save("request.json", request)
    status = {"state": "prepared", "thread_id": thread, "turn_id": turn,
              "requested_model": request["model"], "bridge_version": health.get("version")}
    save("status.json", status)
    print(f"Retaining consultation in {args.output.resolve()}", file=sys.stderr, flush=True)
    response = None
    try:
        status["state"] = "submission_uncertain"
        save("status.json", status)
        req = urllib.request.Request(base + "/v1/responses", data=json.dumps(request).encode(),
                                     headers={"Content-Type": "application/json", "Accept": "text/event-stream"})
        with http.open(req, timeout=1800) as result, (args.output / "response.sse").open("wb") as raw:
            if "text/event-stream" not in result.headers.get("Content-Type", ""):
                raise RuntimeError("Expected SSE response; inspect bridge before retrying")
            data = []
            for line in result:
                raw.write(line)
                raw.flush()
                text = line.decode("utf-8").rstrip("\r\n")
                if text.startswith("data:"):
                    data.append(text[5:].lstrip())
                elif not text and data:
                    payload = "\n".join(data)
                    data = []
                    if payload == "[DONE]":
                        continue
                    event = json.loads(payload)
                    if event.get("type") in ("response.completed", "response.failed", "response.incomplete"):
                        response = event.get("response", {})
                        save("response.json", response)
            if not response or response.get("status") != "completed":
                raise RuntimeError("No completed response; inspect retained stream and launcher, do not blindly retry")
        answer = extract_answer(response)
        if not answer.strip():
            raise RuntimeError("Completed response contains no assistant text")
        if response.get("model") != "chatgpt-web/pro":
            raise RuntimeError("Unexpected response route; inspect retained response")
        (args.output / "answer.md").write_text(answer + "\n")
        status.update(state="completed", response_id=response.get("id"), response_model=response.get("model"))
        save("status.json", status)
        print(answer)
    except (Exception, KeyboardInterrupt) as error:
        if isinstance(error, urllib.error.HTTPError):
            (args.output / "http-error.txt").write_bytes(error.read())
        status.update(state="needs_inspection", error=str(error))
        save("status.json", status)
        print(f"Consultation stopped: {error}. Artifacts: {args.output}. No retry was made.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
