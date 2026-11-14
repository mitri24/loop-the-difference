"""Target name → ICRS degrees via Sesame, with a hard timeout and an in-memory cache."""

from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as LookupTimeout
from functools import lru_cache

from astropy.coordinates import SkyCoord
from astropy.coordinates.name_resolve import sesame_url

LOOKUP_TIMEOUT_S = 10.0

# The Harvard mirror answers directly; the CDS host only redirects and is often down.
sesame_url.set(
    [
        "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/",
        "https://cds.unistra.fr/cgi-bin/nph-sesame/",
    ]
)

_lookups = ThreadPoolExecutor(max_workers=8, thread_name_prefix="sesame")


class NameLookupTimeout(Exception):
    """Sesame did not answer within LOOKUP_TIMEOUT_S."""


@lru_cache(maxsize=512)
def _lookup(name: str) -> tuple[float, float]:
    coord = SkyCoord.from_name(name)
    return coord.ra.deg, coord.dec.deg


def resolve(name: str) -> tuple[float, float]:
    """Raise NameResolveError for unknown names, NameLookupTimeout once the deadline passes.

    Only successful lookups are cached; a late answer still fills the cache for the next call.
    """
    future = _lookups.submit(_lookup, name)
    try:
        return future.result(timeout=LOOKUP_TIMEOUT_S)
    except LookupTimeout:
        future.cancel()
        raise NameLookupTimeout() from None
