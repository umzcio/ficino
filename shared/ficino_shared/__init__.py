"""Shared api/worker code for Ficino.

Both containers `pip install ./shared` at image build. Modules here must
stay dependency-light: stdlib only at import time; optional third-party
imports (supabase) happen inside functions/constructors.
"""
