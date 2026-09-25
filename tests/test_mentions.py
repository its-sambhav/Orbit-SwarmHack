"""Comment mentions surface as alerts for the mentioned desk."""
import pytest

from api import comments

WORK = ("101", "Lok Sabha", "18th Lok Sabha")
STATE = {"role": "state", "entity": "Bihar"}
DISTRICT = {"role": "district", "entity": "Bihar|Patna"}


@pytest.fixture(autouse=True)
def tmp_store(tmp_path, monkeypatch):
    monkeypatch.setattr(comments, "COMMENTS_PATH", tmp_path / "c.json")
    monkeypatch.setattr(comments, "MENTION_READS_PATH", tmp_path / "reads.json")
    monkeypatch.setattr(comments, "ATTACH_DIR", tmp_path / "attachments")


def test_mentioned_desk_sees_it_and_others_do_not():
    comments.add(*WORK, "District, please share the completion certificate.", STATE, mentions=["district"])
    assert [r["body"][:8] for r in comments.mentions_for(DISTRICT)] == ["District"]
    # must NOT alert: an unmentioned desk, or the author's own desk
    assert comments.mentions_for({"role": "agency", "entity": "PWD"}) == []
    assert comments.mentions_for(STATE) == []


def test_own_mention_and_withdrawn_comment_do_not_alert():
    comments.add(*WORK, "note to self", DISTRICT, mentions=["district"])
    row = comments.add(*WORK, "withdrawn", STATE, mentions=["district"])
    comments.remove(row["id"], STATE)
    assert comments.mentions_for(DISTRICT) == []


def test_internal_note_does_not_reach_a_desk_that_cannot_read_it():
    comments.add(*WORK, "internal", STATE, mentions=["district", "mospi"], internal=True)
    assert comments.mentions_for(DISTRICT) == []
    # MoSPI may read internal notes, so its mention still arrives
    assert len(comments.mentions_for({"role": "mospi", "entity": None})) == 1


def test_seen_marker_is_per_desk():
    assert comments.mentions_seen_at(DISTRICT) is None
    seen = comments.mark_mentions_seen(DISTRICT)
    assert comments.mentions_seen_at(DISTRICT) == seen
    assert comments.mentions_seen_at({"role": "district", "entity": "Bihar|Gaya"}) is None
