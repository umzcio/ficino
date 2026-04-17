"""Tests for `api/models/feed.py` post_type Literal validation.

Phase 2 item 2.30: every post subclass locks its `post_type` field to a single
Literal value so an API client can't lie about the discriminator. These tests
lock the contract down — negative cases use `pydantic.ValidationError`.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from models.feed import (
    FigurePost,
    PostBase,
    QuotePost,
    ReplyPost,
    ThreadPost,
)


# ---------- PostBase ----------

def test_postbase_accepts_valid_post_type():
    obj = PostBase(persona="socrates", post_type="post", content="hello")
    assert obj.post_type == "post"
    assert obj.persona == "socrates"


@pytest.mark.parametrize(
    "post_type", ["post", "thread", "quote", "reply", "figure"]
)
def test_postbase_accepts_all_valid_types(post_type):
    obj = PostBase(persona="p", post_type=post_type, content="c")
    assert obj.post_type == post_type


def test_postbase_rejects_invalid_post_type():
    with pytest.raises(ValidationError):
        PostBase(persona="p", post_type="invalid", content="c")


def test_postbase_rejects_empty_post_type():
    with pytest.raises(ValidationError):
        PostBase(persona="p", post_type="", content="c")


# ---------- Subclass defaults + literal enforcement ----------

def test_threadpost_accepts_thread_literal():
    obj = ThreadPost(persona="p", content="c")
    assert obj.post_type == "thread"


def test_threadpost_rejects_non_thread_type():
    with pytest.raises(ValidationError):
        ThreadPost(persona="p", post_type="quote", content="c")


def test_quotepost_accepts_quote_literal():
    obj = QuotePost(persona="p", content="c")
    assert obj.post_type == "quote"


def test_quotepost_rejects_non_quote_type():
    with pytest.raises(ValidationError):
        QuotePost(persona="p", post_type="reply", content="c")


def test_replypost_accepts_reply_literal():
    obj = ReplyPost(persona="p", content="c")
    assert obj.post_type == "reply"


def test_replypost_rejects_non_reply_type():
    with pytest.raises(ValidationError):
        ReplyPost(persona="p", post_type="figure", content="c")


def test_figurepost_accepts_figure_literal():
    obj = FigurePost(persona="p", content="c")
    assert obj.post_type == "figure"


def test_figurepost_rejects_non_figure_type():
    with pytest.raises(ValidationError):
        FigurePost(persona="p", post_type="post", content="c")
