"""LLM narrative formatting for the case-file view - the ONLY place in this
project that lets a model turn evidence into prose, and under hard rules:

  The LLM formats reasoning the deterministic layer already computed. It
  never generates reasoning. It receives only the evidence object and a
  template; it may not add facts, infer motive, or characterise intent, and
  it may never use "fraud"/"corruption"/"misappropriation" or a synonym.
  Every number in its output must appear in the input evidence object, or
  the generation is rejected and the raw evidence table is shown instead.

Calls Gemini 2.5 Flash via OpenRouter (OpenAI-compatible REST API) - no
provider SDK needed, one HTTP POST. OPENROUTER_API_KEY is read from a local
.env file (see .env in the project root).

Every response is cached to disk keyed by a hash of the finding's own
content, so a repeat view of the same case file costs nothing and the demo
can run with the network unplugged after a first pass.
"""
import hashlib
import json
import os
import re

import httpx
from dotenv import load_dotenv

from engine.paths import ROOT, DATA_FINDINGS

load_dotenv(ROOT / ".env")

CACHE_DIR = DATA_FINDINGS / "narrative_cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL = "google/gemini-2.5-flash"

FORBIDDEN_WORDS = [
    "fraud", "fraudulent", "corrupt", "corruption", "misappropriat",
    "embezzl", "criminal", "illegal", "theft", "steal", "stolen", "scam",
    "bribe", "bribery", "kickback", "launder",
]

SYSTEM_PROMPT = """You are a formatting assistant inside a government MPLADS financial-oversight tool. Your ONLY job: turn one structured evidence record into a short, plain case-file note for a reviewing official.

Hard rules, no exceptions:
1. Use ONLY the facts given in the evidence JSON you are shown. Do not add, infer, or guess anything not present in it.
2. Never speculate about motive, intent, or cause. State only what was observed, in the order: what happened, what the guideline expected, how far apart they are.
3. Never use the words fraud, corruption, corrupt, misappropriation, embezzlement, criminal, illegal, theft, steal, stolen, scam, bribe, bribery, kickback, or launder, or any synonym implying wrongdoing. This is a prioritisation flag for human review, not a finding of wrongdoing - the note must read that way.
4. Every number you write (days, rupee amounts, dates, counts) must appear verbatim (or as an equivalent formatting, e.g. 3138350 vs 3,138,350) somewhere in the evidence JSON. Do not compute, round, or introduce a new number.
5. Write 2-4 plain sentences, neutral tone, no markdown, no headers, no preamble - output only the note itself.
6. Do not use the word "flagged" more than once."""


def _cache_key(finding: dict) -> str:
    payload = json.dumps(
        {"detector": finding["detector"], "evidence": finding["evidence"], "routed_to": finding["routed_to"]},
        sort_keys=True, default=str,
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:24]


def _cache_path(key: str):
    return CACHE_DIR / f"{key}.json"


def _build_prompt(finding: dict) -> str:
    return (
        f"Detector: {finding['detector']}\n"
        f"Tag: {finding['tag']}\n"
        f"Severity: {finding['severity']}\n"
        f"Routed to: {finding['routed_to']}\n"
        f"Evidence JSON: {json.dumps(finding['evidence'], default=str)}\n\n"
        "Write the case-file note now."
    )


def _numbers_in(text: str) -> set[str]:
    return {n.replace(",", "") for n in re.findall(r"\d[\d,]*\.?\d*", text) if n.replace(",", "").strip(".")}


def _numbers_in_evidence(evidence) -> set[str]:
    found = set()

    def walk(v):
        if isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, (int, float)) and not isinstance(v, bool):
            found.add(str(v).replace(",", ""))
            if isinstance(v, float) and v.is_integer():
                found.add(str(int(v)))
        elif isinstance(v, str):
            found.update(_numbers_in(v))

    walk(evidence)
    return found


def validate(text: str, finding: dict) -> tuple[bool, str]:
    lower = text.lower()
    for w in FORBIDDEN_WORDS:
        if w in lower:
            return False, f"generation rejected: contains forbidden word '{w}'"

    text_numbers = _numbers_in(text)
    evidence_numbers = _numbers_in_evidence(finding["evidence"])
    unverified = sorted(n for n in text_numbers if n not in evidence_numbers)
    if unverified:
        return False, f"generation rejected: unverified number(s) {unverified} not present in evidence"

    return True, ""


def _call_openrouter(prompt: str) -> tuple[str, str]:
    """One chat-completion call via OpenRouter's OpenAI-compatible REST API.
    Returns (text, finish_reason). Raises on missing key / HTTP / network errors -
    generate_narrative() below is what turns those into a clean result dict."""
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError(
            "OPENROUTER_API_KEY not set - paste your key into the .env file "
            "in the project root, then restart the API server"
        )

    response = httpx.post(
        OPENROUTER_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "X-Title": "MPLADS Review",   # OpenRouter's optional app-identification header
        },
        json={
            "model": MODEL,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": 600,
            "temperature": 0.2,   # low - this is a formatting task, not creative generation
        },
        timeout=30.0,
    )
    response.raise_for_status()
    data = response.json()
    if "error" in data:   # OpenRouter can return 200 with an {"error": ...} body on some upstream failures
        raise RuntimeError(f"OpenRouter error: {data['error'].get('message', data['error'])}")
    choice = data["choices"][0]
    text = (choice["message"]["content"] or "").strip()
    finish_reason = choice.get("finish_reason", "")
    return text, finish_reason


def generate_narrative(finding: dict) -> dict:
    """Returns {"generated": bool, "narrative": str|None, "reason": str|None, "cached": bool}."""
    key = _cache_key(finding)
    cache_file = _cache_path(key)
    if cache_file.exists():
        result = json.loads(cache_file.read_text())
        result["cached"] = True
        return result

    try:
        text, finish_reason = _call_openrouter(_build_prompt(finding))
        if finish_reason == "content_filter":
            result = {"generated": False, "narrative": None, "reason": "model declined to generate"}
        elif not text:
            result = {"generated": False, "narrative": None, "reason": "model returned an empty response"}
        else:
            ok, reason = validate(text, finding)
            result = {"generated": ok, "narrative": text if ok else None, "reason": None if ok else reason}
    except httpx.HTTPStatusError as e:
        result = {"generated": False, "narrative": None,
                   "reason": f"OpenRouter HTTP {e.response.status_code}: {e.response.text[:200]}"}
    except httpx.RequestError as e:
        result = {"generated": False, "narrative": None, "reason": f"network error calling OpenRouter: {e}"}
    except Exception as e:
        result = {"generated": False, "narrative": None, "reason": f"LLM call failed: {e}"}

    cache_file.write_text(json.dumps(result))
    result["cached"] = False
    return result


def demo():
    """Offline self-check for the validator (the part with real branching
    logic) - doesn't need OPENROUTER_API_KEY or the network."""
    sample_finding = {
        "detector": "SANCTION_DELAY", "tag": "TIME DELAY", "severity": "high", "routed_to": "District IDA",
        "evidence": {"observed": {"sanction_delay_days": 192}, "threshold": {"guideline_days": 45},
                     "peer_benchmark": None, "deviation": "sanctioned 192 days after recommendation"},
    }

    ok, reason = validate("Sanctioned 192 days after recommendation, against a 45-day guideline.", sample_finding)
    assert ok, f"expected valid text to pass, got: {reason}"

    ok, reason = validate("This looks like fraud.", sample_finding)
    assert not ok and "forbidden word" in reason, "forbidden-word text should be rejected"

    ok, reason = validate("Delayed by 999 days.", sample_finding)
    assert not ok and "unverified number" in reason, "a number not in evidence should be rejected"

    ok, reason = validate("Delayed by 192 days (guideline: 45).", sample_finding)
    assert ok, f"numbers that ARE in evidence should pass, got: {reason}"

    # cache key is deliberately scoped to (detector, evidence, routed_to) -
    # what actually determines the narrative text - not every field on the
    # finding. severity is a label derived from the same evidence, so it
    # should NOT change the key; the evidence itself should.
    key_same_severity_changed = _cache_key({**sample_finding, "severity": "low"})
    assert key_same_severity_changed == _cache_key(sample_finding), (
        "cache key should NOT change when only severity changes (same underlying evidence)"
    )
    changed_evidence = {**sample_finding, "evidence": {**sample_finding["evidence"],
                         "observed": {"sanction_delay_days": 999}}}
    assert _cache_key(changed_evidence) != _cache_key(sample_finding), (
        "cache key SHOULD change when evidence changes"
    )

    print("narrative self-check: PASS (validator + cache-key logic; no network call made)")
    if not os.environ.get("OPENROUTER_API_KEY"):
        print("  note: OPENROUTER_API_KEY not set, so the actual OpenRouter call path is untested here")


if __name__ == "__main__":
    demo()
