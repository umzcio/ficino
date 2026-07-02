"""The shims must BE the shared implementations, not copies (R10 DUP-3/4)."""
import ficino_shared.sanitize
# Task 3 uncomments: import ficino_shared.signed_url  # populated by Task 3; keep one file for both
import sanitize
# Task 3 uncomments: import signed_url


def test_sanitize_shim_is_shared_module():
    assert sanitize.fence_untrusted is ficino_shared.sanitize.fence_untrusted
    assert sanitize.sanitize_inline is ficino_shared.sanitize.sanitize_inline


# Task 3 uncomments:
# def test_signed_url_shim_is_shared_module():
#     assert signed_url.sign_resource is ficino_shared.signed_url.sign_resource
#     # api/signed_url.py exports `verify_token`, not `verify_resource` --
#     # the brief's placeholder name; use the real one Task 3 moves.
#     assert signed_url.verify_token is ficino_shared.signed_url.verify_token
