"""Case discussion attached to one work - where the officers who actually
have to act on an anomaly talk about it.

Everything else on a case file is computed: the detectors produce findings,
the models produce scores, the reviewer records a verdict per finding. None
of that is a conversation, and a state officer who wants to ask the district
why a work was marked complete without a certificate currently has nowhere in
this tool to ask it. That is what this is for.

Same "flat JSON file" precedent as api/finding_status.py and api/reports.py,
for the same reason: one demo instance, no multi-tenant concerns, and a case
that realistically collects a handful of comments.

Authorship is never supplied by the client - it is read off the caller's own
signed token (role + entity), so a comment cannot be posted in someone else's
name. Editing and deleting are restricted to the author for the same reason.

ponytail: replies are one level deep. A reply to a reply attaches to the same
thread root, which is what a case discussion actually needs - arbitrary
nesting is a threading model to maintain, not a feature anyone asked for.
"""
import json
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

from engine.paths import ROOT

COMMENTS_PATH = ROOT / "data" / "case_comments.json"

# Supporting documents live beside the thread, one directory per comment. The
# directory name is the comment's own server-generated id, never anything the
# client sent, so no upload can steer a write outside this tree.
ATTACH_DIR = ROOT / "data" / "case_attachments"

# An allowlist, not a blocklist: this accepts the things an officer actually
# attaches to a case (a certificate, a photo, a sanction order, a sheet) and
# refuses everything else, so nothing executable can be stored or served back.
ALLOWED_ATTACHMENTS = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
MAX_ATTACH_BYTES = 10 * 1024 * 1024
MAX_ATTACH_PER_COMMENT = 5

# who a comment can be addressed to - the fixed set of roles this tool signs
# people in as (see config/auth.yaml), which is also what the frontend offers
# in its mention menu. Free-text mentions are deliberately not a thing: a
# mention that doesn't resolve to a real desk is just decoration.
MENTIONABLE_ROLES = {
    "mospi": "MoSPI",
    "state": "State Nodal Authority",
    "district": "District Authority",
    "agency": "Implementing Agency",
    "mp": "Member of Parliament",
}

MAX_BODY_LEN = 4000


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load() -> list[dict]:
    if not COMMENTS_PATH.exists():
        return []
    try:
        return json.loads(COMMENTS_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        # a corrupt file must not take the case file down with it
        return []


def _save(rows: list[dict]) -> None:
    COMMENTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = COMMENTS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(COMMENTS_PATH)   # atomic - a crash mid-write can't truncate the thread


def _author(claims: dict) -> dict:
    return {"author_role": claims.get("role"), "author_entity": claims.get("entity")}


def _is_author(row: dict, claims: dict) -> bool:
    return (row.get("author_role") == claims.get("role")
            and row.get("author_entity") == claims.get("entity"))


def _key(work_number: str, scope_house: str, scope_tenure: str) -> tuple:
    return (str(work_number), scope_house, scope_tenure)


def _can_see(row: dict, claims: dict) -> bool:
    """An internal comment is a working note between the desk that wrote it and
    MoSPI, who oversees every case. Enforced here rather than hidden in the UI:
    a flag the client could ignore would be worse than no flag at all, because
    an officer would trust it and write something they shouldn't."""
    if not row.get("internal"):
        return True
    return claims.get("role") == "mospi" or row.get("author_role") == claims.get("role")


def list_for_work(work_number: str, scope_house: str, scope_tenure: str,
                  claims: dict) -> list[dict]:
    """Every comment on this work the caller is allowed to see, oldest first.
    Ordering into threads is the caller's job - the frontend already knows how
    it wants to render them, and a flat list keeps this function honest about
    what it stores."""
    want = _key(work_number, scope_house, scope_tenure)
    rows = [r for r in _load()
            if _key(r["work_number"], r["scope_house"], r["scope_tenure"]) == want
            and _can_see(r, claims)]
    # a reply whose root was filtered out would render as a stray fragment of a
    # conversation nobody on this side can read - drop it with its root
    visible = {r["id"] for r in rows if not r.get("parent_id")}
    rows = [r for r in rows if not r.get("parent_id") or r["parent_id"] in visible]
    return sorted(rows, key=lambda r: r["created_at"])


def add(work_number: str, scope_house: str, scope_tenure: str, body: str,
        claims: dict, parent_id: str | None = None, mentions: list[str] | None = None,
        internal: bool = False) -> dict:
    body = (body or "").strip()
    if not body:
        raise ValueError("comment body is required")
    if len(body) > MAX_BODY_LEN:
        raise ValueError(f"comment body is longer than {MAX_BODY_LEN} characters")

    rows = _load()
    if parent_id is not None:
        parent = next((r for r in rows if r["id"] == parent_id), None)
        if parent is None:
            raise ValueError(f"no comment {parent_id} to reply to")
        # one level deep: replying to a reply joins that reply's own thread
        parent_id = parent.get("parent_id") or parent["id"]

    row = {
        "id": uuid.uuid4().hex[:12],
        "work_number": str(work_number),
        "scope_house": scope_house,
        "scope_tenure": scope_tenure,
        "parent_id": parent_id,
        **_author(claims),
        "body": body,
        "mentions": [m for m in (mentions or []) if m in MENTIONABLE_ROLES],
        "created_at": _now(),
        "edited_at": None,
        "pinned": False,
        "resolved": False,
        "internal": bool(internal),
        "attachments": [],
        "deleted": False,
    }
    rows.append(row)
    _save(rows)
    return row


def update(comment_id: str, claims: dict, body: str | None = None,
           pinned: bool | None = None, resolved: bool | None = None,
           internal: bool | None = None) -> dict:
    rows = _load()
    row = next((r for r in rows if r["id"] == comment_id), None)
    if row is None:
        raise KeyError(comment_id)

    # editing the words is the author's alone; pinning and resolving are
    # curation of a shared case, so any reviewer on it may do those - every
    # one of them is attributed, and MoSPI oversees all of them anyway.
    if body is not None:
        if not _is_author(row, claims):
            raise PermissionError("only the author can edit a comment")
        body = body.strip()
        if not body:
            raise ValueError("comment body is required")
        if len(body) > MAX_BODY_LEN:
            raise ValueError(f"comment body is longer than {MAX_BODY_LEN} characters")
        row["body"] = body
        row["edited_at"] = _now()
    if pinned is not None:
        row["pinned"] = bool(pinned)
    if resolved is not None:
        if row.get("parent_id"):
            raise ValueError("only a thread's first comment can be resolved")
        row["resolved"] = bool(resolved)
    if internal is not None:
        # unlike pin/resolve, this decides who can read the words - so it stays
        # with the desk that wrote them, not with whoever is passing through
        if not _is_author(row, claims):
            raise PermissionError("only the author can change who can read a comment")
        row["internal"] = bool(internal)

    _save(rows)
    return row


def _safe_name(filename: str) -> str:
    """The display name only - the bytes are stored under a generated id, so
    this never has to be safe as a path, just safe to render and download as."""
    name = Path(str(filename or "")).name.replace("\\", "").strip()
    return name[:120] or "document"


def attach(comment_id: str, claims: dict, filename: str, data: bytes) -> dict:
    """Store a supporting document against one comment. Author-only: an
    attachment is part of what that desk said, not shared thread furniture."""
    rows = _load()
    row = next((r for r in rows if r["id"] == comment_id), None)
    if row is None:
        raise KeyError(comment_id)
    if not _is_author(row, claims):
        raise PermissionError("only the author can attach a document")
    if row.get("deleted"):
        raise ValueError("cannot attach to a withdrawn comment")

    display = _safe_name(filename)
    ext = Path(display).suffix.lower()
    if ext not in ALLOWED_ATTACHMENTS:
        raise ValueError(f"{ext or 'that file type'} is not an accepted document type")
    if not data:
        raise ValueError("the file is empty")
    if len(data) > MAX_ATTACH_BYTES:
        raise ValueError(f"the file is larger than {MAX_ATTACH_BYTES // (1024 * 1024)} MB")
    existing = row.setdefault("attachments", [])
    if len(existing) >= MAX_ATTACH_PER_COMMENT:
        raise ValueError(f"a comment takes at most {MAX_ATTACH_PER_COMMENT} documents")

    aid = uuid.uuid4().hex[:12]
    folder = ATTACH_DIR / row["id"]        # server-generated id, never client input
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{aid}{ext}").write_bytes(data)

    record = {"id": aid, "filename": display, "size": len(data),
              "content_type": ALLOWED_ATTACHMENTS[ext], "ext": ext,
              "uploaded_at": _now()}
    existing.append(record)
    _save(rows)
    return record


def find_attachment(comment_id: str, attachment_id: str, claims: dict) -> tuple[Path, dict]:
    """Resolve one attachment for download, applying the same read rule as the
    comment it hangs off - an internal note's evidence is internal too."""
    row = next((r for r in _load() if r["id"] == comment_id), None)
    if row is None:
        raise KeyError(comment_id)
    if not _can_see(row, claims):
        raise PermissionError("this document is not visible to your desk")
    record = next((a for a in row.get("attachments", []) if a["id"] == attachment_id), None)
    if record is None:
        raise KeyError(attachment_id)
    path = ATTACH_DIR / row["id"] / f"{record['id']}{record['ext']}"
    if not path.exists():
        raise KeyError(attachment_id)
    return path, record


def remove(comment_id: str, claims: dict) -> dict:
    """Tombstone, not an erase - a reply must not lose the comment it answers,
    and a case record should show that something was withdrawn rather than
    quietly closing the gap."""
    rows = _load()
    row = next((r for r in rows if r["id"] == comment_id), None)
    if row is None:
        raise KeyError(comment_id)
    if not _is_author(row, claims):
        raise PermissionError("only the author can delete a comment")
    row["deleted"] = True
    row["body"] = ""
    row["mentions"] = []
    row["attachments"] = []
    row["edited_at"] = _now()
    # the tombstone keeps the thread's shape, but withdrawing a comment has to
    # withdraw the documents filed with it too, or "delete" only half means it
    shutil.rmtree(ATTACH_DIR / row["id"], ignore_errors=True)
    _save(rows)
    return row


# ---------- mentions as alerts ----------
# A mention names a desk (a role). Which *office* of that desk it reaches is
# decided by the work: "District Authority" on a Patna work is the Patna
# district desk. That work-to-entity check lives with the other access rules
# (api/auth.check_work_access), so the API layer filters what this returns.

# when each desk (role|entity) last opened its alerts - only newer mentions
# count as unread
MENTION_READS_PATH = ROOT / "data" / "mention_reads.json"


def _desk(claims: dict) -> str:
    return f"{claims.get('role')}|{claims.get('entity') or ''}"


def mentions_for(claims: dict) -> list[dict]:
    """Live comments that mention the caller's role, newest first - excluding
    the caller's own comments and internal notes the caller may not read."""
    role = claims.get("role")
    rows = [r for r in _load()
            if role in (r.get("mentions") or []) and not r.get("deleted")
            and not _is_author(r, claims) and _can_see(r, claims)]
    return sorted(rows, key=lambda r: r["created_at"], reverse=True)


def _load_reads() -> dict:
    if not MENTION_READS_PATH.exists():
        return {}
    try:
        return json.loads(MENTION_READS_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def mentions_seen_at(claims: dict) -> str | None:
    return _load_reads().get(_desk(claims))


def mark_mentions_seen(claims: dict) -> str:
    reads = _load_reads()
    reads[_desk(claims)] = _now()
    MENTION_READS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = MENTION_READS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(reads, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(MENTION_READS_PATH)
    return reads[_desk(claims)]


def demo():
    """Offline self-check for the threading, permission, visibility and
    attachment rules - the parts with real branching. Writes to a temp
    directory, never the real one."""
    global COMMENTS_PATH, ATTACH_DIR
    import tempfile
    real, real_attach = COMMENTS_PATH, ATTACH_DIR
    with tempfile.TemporaryDirectory() as d:
        COMMENTS_PATH = Path(d) / "c.json"
        ATTACH_DIR = Path(d) / "attachments"

        state = {"role": "state", "entity": "Telangana"}
        district = {"role": "district", "entity": "Telangana|NIZAMABAD"}
        mospi = {"role": "mospi", "entity": None}

        root = add("226603", "Lok Sabha", "18th Lok Sabha", "Why no certificate?", state)
        assert root["parent_id"] is None and not root["pinned"]

        reply = add("226603", "Lok Sabha", "18th Lok Sabha", "Requested it.", district,
                    parent_id=root["id"])
        assert reply["parent_id"] == root["id"]

        # a reply to a reply flattens onto the same thread root
        nested = add("226603", "Lok Sabha", "18th Lok Sabha", "Attach it here.", state,
                     parent_id=reply["id"])
        assert nested["parent_id"] == root["id"], "replies stay one level deep"

        # another work's thread must not leak into this one
        add("999999", "Lok Sabha", "18th Lok Sabha", "Different work.", state)
        assert len(list_for_work("226603", "Lok Sabha", "18th Lok Sabha", state)) == 3

        # only the author may edit or delete
        for op in (lambda: update(root["id"], district, body="hijacked"),
                   lambda: remove(root["id"], district)):
            try:
                op()
                raise AssertionError("expected a PermissionError for a non-author")
            except PermissionError:
                pass

        edited = update(root["id"], state, body="Why was it marked complete?")
        assert edited["edited_at"] and edited["body"].startswith("Why was it")

        # pin/resolve are curation, open to any reviewer on the case
        assert update(root["id"], district, pinned=True)["pinned"]
        assert update(root["id"], district, resolved=True)["resolved"]
        try:
            update(reply["id"], state, resolved=True)
            raise AssertionError("a reply should not be resolvable")
        except ValueError:
            pass

        # delete is a tombstone: the row stays so its replies keep their parent
        gone = remove(root["id"], state)
        assert gone["deleted"] and gone["body"] == ""
        assert len(list_for_work("226603", "Lok Sabha", "18th Lok Sabha", state)) == 3

        # mentions are filtered to real desks
        m = add("226603", "Lok Sabha", "18th Lok Sabha", "ping", state,
                mentions=["district", "not-a-role"])
        assert m["mentions"] == ["district"]

        # an empty body is rejected, before and after the strip
        for bad in ("", "   "):
            try:
                add("226603", "Lok Sabha", "18th Lok Sabha", bad, state)
                raise AssertionError("expected an empty body to raise")
            except ValueError:
                pass

        # --- internal comments: the author's desk and MoSPI, nobody else ---
        note = add("777", "Lok Sabha", "18th Lok Sabha", "Working note.", state,
                   internal=True)
        assert note["internal"]
        seen = lambda who: {r["id"] for r in list_for_work("777", "Lok Sabha", "18th Lok Sabha", who)}
        assert note["id"] in seen(state), "the author's own desk must see its note"
        assert note["id"] in seen(mospi), "MoSPI oversees every case"
        assert note["id"] not in seen(district), "another desk must not see an internal note"

        # a reply under an internal root goes with it, rather than surfacing alone
        under = add("777", "Lok Sabha", "18th Lok Sabha", "Reply to note.", state,
                    parent_id=note["id"])
        assert under["id"] not in seen(district), "a reply must not outlive a root it hangs off"

        # only the author decides who can read their words
        try:
            update(note["id"], district, internal=False)
            raise AssertionError("a non-author must not be able to expose a note")
        except PermissionError:
            pass
        assert not update(note["id"], state, internal=False)["internal"]
        assert note["id"] in seen(district), "cleared, it is an ordinary comment again"

        # --- attachments ---
        host = add("777", "Lok Sabha", "18th Lok Sabha", "Certificate attached.", state)
        rec = attach(host["id"], state, "completion certificate.pdf", b"%PDF-1.4 fake")
        assert rec["filename"] == "completion certificate.pdf" and rec["size"] == 13
        path, found = find_attachment(host["id"], rec["id"], district)
        assert path.exists() and found["content_type"] == "application/pdf"

        # a traversing filename cannot escape the attachment tree
        evil = attach(host["id"], state, "../../../../etc/passwd.txt", b"x")
        stored = ATTACH_DIR / host["id"] / f"{evil['id']}.txt"
        assert stored.exists(), "the file must land under its own comment's folder"
        assert evil["filename"] == "passwd.txt", "the display name is stripped to a basename"

        for bad_name, bad_bytes in (("script.sh", b"x"), ("payload.exe", b"x"),
                                    ("empty.pdf", b""), ("big.pdf", b"x" * (MAX_ATTACH_BYTES + 1))):
            try:
                attach(host["id"], state, bad_name, bad_bytes)
                raise AssertionError(f"expected {bad_name} to be refused")
            except ValueError:
                pass

        try:
            attach(host["id"], district, "notmine.pdf", b"x")
            raise AssertionError("only the author may attach")
        except PermissionError:
            pass

        # an internal comment's evidence is internal too
        update(host["id"], state, internal=True)
        try:
            find_attachment(host["id"], rec["id"], district)
            raise AssertionError("an internal note's document must not be downloadable")
        except PermissionError:
            pass

        # withdrawing a comment withdraws its documents from disk with it
        remove(host["id"], state)
        assert not (ATTACH_DIR / host["id"]).exists()
        try:
            find_attachment(host["id"], rec["id"], state)
            raise AssertionError("a withdrawn comment's attachment must be gone")
        except KeyError:
            pass

    COMMENTS_PATH, ATTACH_DIR = real, real_attach
    print("ok - api/comments.py self-check passed")


if __name__ == "__main__":
    demo()
