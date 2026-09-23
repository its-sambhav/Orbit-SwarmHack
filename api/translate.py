"""Machine translation for the DATA the dashboard renders - work descriptions,
and the proper nouns (state/district/constituency/MP/agency names) that come
out of the source CSVs in English only.

This is separate from web/src/i18n.jsx, which holds the hand-written UI
strings. That table can only ever cover text that ships with the code; the
CSVs carry hundreds of thousands of free-text descriptions, so the only way
the language toggle can reach them is a translator. Same OpenRouter/Gemini
setup api/narrative.py already uses - one HTTP POST, no provider SDK, and
OPENROUTER_API_KEY read from the project-root .env.

Two rules the prompt enforces, because they are what makes the output usable
rather than merely translated:

  1. Proper nouns are TRANSLITERATED, not translated - "Bihar" becomes the
     Bihar sound written in Telugu script, never a Telugu word meaning
     something. A translated place name is a different place.
  2. Numbers, codes, amounts and units are copied through verbatim. A work
     number or a rupee figure that changes digits in translation is worse
     than no translation at all.

Every translated string is cached to disk per language, so a string is sent
to the model once ever and every later view of it - by anyone, in any
session - is a local dict lookup. Cache misses degrade to the English
original rather than an error: an untranslated description still reads.

ponytail: one JSON file per language, loaded whole into memory on first use.
Fine at demo scale (only what someone actually looks at is ever cached). If
the cache outgrows memory, move these to SQLite - the get/put interface
below is the only thing that would change.
"""
import json
import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor

import httpx
from dotenv import load_dotenv

from engine.paths import ROOT

load_dotenv(ROOT / ".env")

log = logging.getLogger(__name__)

CACHE_DIR = ROOT / "data" / "translation_cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL = "google/gemini-2.5-flash"

# must match web/src/i18n.jsx's LANGUAGES - 'en' is absent on purpose, it is
# the source language and never needs a round trip.
LANGUAGE_NAMES = {
    "hi": "Hindi", "bn": "Bengali", "ta": "Tamil", "te": "Telugu",
    "mr": "Marathi", "gu": "Gujarati", "kn": "Kannada", "ml": "Malayalam",
}

# one model call per this many strings. Large enough that a 50-row page is a
# couple of calls, small enough that one bad batch doesn't lose a whole page
# (and stays well inside the response token budget).
BATCH_SIZE = 40
# a hard ceiling per HTTP request, matched by the chunk size the frontend
# sends (see dataStore.flush in web/src/i18n.jsx). The two must agree: if the
# server quietly dropped the tail of an over-long request, the client would
# still mark those strings as asked-for and they would stay English forever.
MAX_TEXTS_PER_REQUEST = 400
MAX_TEXT_LEN = 600
# batches go out concurrently - a directory page can be 1,000+ new strings,
# which is 25+ model calls, and running those in series is a minute of
# staring at English. Bounded so a big page can't open 25 sockets at once.
MAX_CONCURRENT_BATCHES = 6

SYSTEM_PROMPT = """You translate short strings from an Indian government financial-oversight dashboard (MPLADS) into {language}.

You are given a JSON array of English strings. Return ONLY a JSON array of the same length, in the same order, with each string converted to {language}. No markdown, no code fence, no commentary, no keys - just the array.

Rules:
1. PROPER NOUNS (names of states, districts, constituencies, people, agencies, departments, schemes) must be TRANSLITERATED into the {language} script - write the same sound, do not translate the meaning. "Bihar" must come out as the sound "Bihar" in {language} script, never as a {language} word meaning something else.
2. DESCRIPTIVE TEXT (what a work is: construction, purchase, installation, repair, etc.) must be TRANSLATED into natural {language}.
3. Copy through UNCHANGED, in the original characters: all digits, numbers, amounts, currency symbols (Rs, INR), years, dates, work/serial numbers, measurements and units (Cr, L, km, m, NOS, sq.ft), abbreviations and acronyms (MP, MLA, IDA, SC, ST, CC, PWD, GOVT, HSS, DIET), and anything inside brackets that is a code or an ID.
4. Keep it roughly as short as the English. These render in narrow table cells and list rows.
5. If a string is already in {language}, or is only a number/code with no words, return it exactly as given.
6. Never add explanation, transliteration hints, alternatives in brackets, or a translator's note.

The array you return must have exactly the same number of elements as the array you were given."""

_lock = threading.Lock()
_caches: dict[str, dict[str, str]] = {}


def _cache_path(lang: str):
    return CACHE_DIR / f"{lang}.json"


def _cache(lang: str) -> dict[str, str]:
    """Lazily load (and memoise) one language's whole cache."""
    if lang not in _caches:
        path = _cache_path(lang)
        try:
            _caches[lang] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        except (json.JSONDecodeError, OSError):
            # a half-written cache must never take the dashboard down - the
            # worst case is re-translating, which is correct, just not free.
            _caches[lang] = {}
    return _caches[lang]


def _persist(lang: str) -> None:
    tmp = _cache_path(lang).with_suffix(".json.tmp")
    tmp.write_text(json.dumps(_caches[lang], ensure_ascii=False), encoding="utf-8")
    tmp.replace(_cache_path(lang))   # atomic, so a crash mid-write can't corrupt the cache


def _call_openrouter(texts: list[str], lang: str) -> list[str]:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY not set - paste your key into .env and restart the API server")

    language = LANGUAGE_NAMES[lang]
    response = httpx.post(
        OPENROUTER_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "X-Title": "MPLADS Review",
        },
        json={
            "model": MODEL,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT.format(language=language)},
                {"role": "user", "content": json.dumps(texts, ensure_ascii=False)},
            ],
            "max_tokens": 8000,
            "temperature": 0,   # a translation should be the same every time it is asked for
            "response_format": {"type": "json_object"},
        },
        timeout=60.0,
    )
    response.raise_for_status()
    data = response.json()
    if "error" in data:
        raise RuntimeError(f"OpenRouter error: {data['error'].get('message', data['error'])}")
    return _parse_array(data["choices"][0]["message"]["content"] or "", len(texts))


def _parse_array(content: str, expected: int) -> list[str]:
    """The model is asked for a bare JSON array, but response_format=json_object
    can wrap it in an object, and some models still fence it. Accept all three,
    and reject anything whose length doesn't match - a short array would
    silently shift every translation onto the wrong string."""
    text = content.strip()
    if text.startswith("```"):
        text = text.split("```")[1] if "```" in text[3:] else text.strip("`")
        text = text[4:] if text.lower().startswith("json") else text
    text = text.strip()

    parsed = json.loads(text)
    if isinstance(parsed, dict):
        arrays = [v for v in parsed.values() if isinstance(v, list)]
        if len(arrays) != 1:
            raise ValueError(f"expected one array in the response object, found {len(arrays)}")
        parsed = arrays[0]
    if not isinstance(parsed, list):
        raise ValueError(f"expected a JSON array, got {type(parsed).__name__}")
    if len(parsed) != expected:
        raise ValueError(f"model returned {len(parsed)} strings for {expected} inputs")
    return [str(x) for x in parsed]


def translate(texts: list[str], lang: str) -> dict:
    """English -> `lang`, as {"translations": {original: translated}, "reason": str|None}.

    Cached strings cost nothing. Anything the model fails on is simply left
    out of `translations` and the caller keeps showing the English - a partial
    translation is the correct degradation here, not an error page. `reason`
    carries why, when nothing could be translated at all, so that a missing
    API key is diagnosable instead of looking like "translated to nothing".
    """
    if lang == "en" or lang not in LANGUAGE_NAMES:
        return {"translations": {}, "reason": None}

    # Dedupe and drop what can't or needn't be translated, preserving order so
    # the same page produces the same batches (and so the same cache hits).
    #
    # `originals` maps each stripped form back to every spelling it arrived as.
    # This matters: 36 MP names in the source CSV carry a trailing space, and
    # keying the reply by the stripped form alone left the caller looking up a
    # string it would never find - and, having already marked it as asked-for,
    # never retrying it either. The reply is keyed by what the caller sent.
    wanted, originals = [], {}
    for raw in texts[:MAX_TEXTS_PER_REQUEST]:
        t = (raw or "").strip()
        if not t or len(t) > MAX_TEXT_LEN:
            continue
        if not any(c.isalpha() for c in t):   # pure numbers/codes - nothing to translate
            continue
        if t in originals:
            originals[t].add(raw)
            continue
        originals[t] = {raw}
        wanted.append(t)

    def spell_out(pairs):
        """{stripped: translated} -> {every spelling the caller sent: translated}"""
        return {orig: dst for src, dst in pairs.items() for orig in originals[src]}

    with _lock:
        cache = _cache(lang)
        out = {t: cache[t] for t in wanted if t in cache}
        missing = [t for t in wanted if t not in cache]

    if not missing:
        return {"translations": spell_out(out), "reason": None}

    batches = [missing[i:i + BATCH_SIZE] for i in range(0, len(missing), BATCH_SIZE)]

    def run(batch):
        try:
            return batch, _call_openrouter(batch, lang), None
        except Exception as e:
            # one failed batch must not lose the batches around it; those
            # strings stay English this time and are retried on the next view.
            log.warning("translation batch failed (%s, %d strings): %s", lang, len(batch), e)
            return batch, None, f"{type(e).__name__}: {e}"

    fresh: dict[str, str] = {}
    reason = None
    with ThreadPoolExecutor(max_workers=min(MAX_CONCURRENT_BATCHES, len(batches))) as pool:
        for batch, translated, err in pool.map(run, batches):
            if err:
                reason = reason or err
                continue
            for src, dst in zip(batch, translated):
                if dst.strip():
                    fresh[src] = dst.strip()

    if fresh:
        with _lock:
            # the cache is keyed by the stripped form - one entry serves every
            # spelling, so a stray trailing space is never paid for twice
            _cache(lang).update(fresh)
            _persist(lang)
        out.update(fresh)
    return {"translations": spell_out(out), "reason": None if fresh else reason}


def demo():
    """Offline self-check for the parsing and filtering logic - the parts with
    real branching. Needs no API key and no network."""
    assert _parse_array('["a","b"]', 2) == ["a", "b"]
    assert _parse_array('```json\n["a","b"]\n```', 2) == ["a", "b"]
    assert _parse_array('{"translations":["a","b"]}', 2) == ["a", "b"]

    # a length mismatch must raise, never silently misalign translations
    for bad in ('["a"]', '["a","b","c"]'):
        try:
            _parse_array(bad, 2)
            raise AssertionError(f"expected a length mismatch to raise for {bad}")
        except ValueError:
            pass

    # en is a no-op, and unknown languages don't reach the network
    assert translate(["Bihar"], "en")["translations"] == {}
    assert translate(["Bihar"], "xx")["translations"] == {}

    # pure numbers/codes are filtered out before any call would be made, so
    # this returns without touching the network even with no API key set
    assert translate(["12345", "  ", "₹4.52"], "te")["translations"] == {}

    # a string that arrives with stray whitespace must come back keyed by the
    # spelling the caller actually sent, or the caller can never look it up
    # (this is the 36-trailing-space-MP-names bug)
    _caches["te"] = {"Anurag Sharma": "\u0c05"}
    result = translate(["Anurag Sharma ", "Anurag Sharma"], "te")["translations"]
    assert result == {"Anurag Sharma ": "\u0c05", "Anurag Sharma": "\u0c05"}, result
    _caches.pop("te", None)

    # a missing key must surface as a reason, not as a silent empty result -
    # otherwise "no API key" and "nothing to translate" look identical
    saved = os.environ.pop("OPENROUTER_API_KEY", None)
    try:
        result = translate(["A string that is definitely not cached yet."], "te")
        assert result["translations"] == {}, "no key means nothing translated"
        assert result["reason"] and "OPENROUTER_API_KEY" in result["reason"], \
            f"expected a missing-key reason, got {result['reason']!r}"
    finally:
        if saved is not None:
            os.environ["OPENROUTER_API_KEY"] = saved

    print("ok - api/translate.py self-check passed")


if __name__ == "__main__":
    demo()
