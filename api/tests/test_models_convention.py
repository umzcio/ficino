"""Convention test for R10 BP-4 (promote half): every router's pydantic
`BaseModel` subclass must live in `api/models/` (request bodies in
`models.requests`, response models in `models.feed`/`models.paper`/etc.) —
not be defined inline in the router module itself.

Static/import-based rather than a hardcoded name list: walks every module
in `api.routers`, imports it, and asserts no `BaseModel` subclass in that
module's own `__dict__` has `__module__` pointing back at the router (i.e.
was defined there rather than imported).
"""
from __future__ import annotations

import importlib
import pkgutil

from pydantic import BaseModel

import routers


def _router_module_names() -> list[str]:
    return [
        f"routers.{info.name}"
        for info in pkgutil.iter_modules(routers.__path__)
        if not info.name.startswith("_")
    ]


def test_no_router_defines_a_basemodel_locally():
    offenders: list[str] = []
    for mod_name in _router_module_names():
        mod = importlib.import_module(mod_name)
        for attr_name, attr in vars(mod).items():
            if (
                isinstance(attr, type)
                and issubclass(attr, BaseModel)
                and attr is not BaseModel
                and attr.__module__ == mod_name
            ):
                offenders.append(f"{mod_name}.{attr_name}")
    assert offenders == [], (
        "Router(s) define a BaseModel subclass locally instead of "
        f"importing from api/models/: {offenders}"
    )
