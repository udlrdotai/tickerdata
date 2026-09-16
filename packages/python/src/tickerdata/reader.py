from copy import deepcopy
from importlib.resources import files
import json
import re


_IDENTIFIER = re.compile(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*")
_MIC = re.compile(r"[A-Z0-9]{4}")


def _read_json(name):
    return json.loads(files("tickerdata").joinpath("data", name).read_text(encoding="utf-8"))


_manifest = _read_json("manifest.json")
_instruments_payload = _read_json("instruments.json")
_index_payload = _read_json("symbol-index.json")

if (
    _manifest["schema_version"] != "4.0.0"
    or _instruments_payload["schema_version"] != _manifest["schema_version"]
    or _index_payload["schema_version"] != _manifest["schema_version"]
    or _instruments_payload["data_version"] != _manifest["data_version"]
    or _index_payload["data_version"] != _manifest["data_version"]
):
    raise RuntimeError("The embedded tickerdata snapshot has inconsistent versions")

_records = {record["id"]: record for record in _instruments_payload["instruments"]}
_entries_by_symbol = {}
for _entry in _index_payload["entries"]:
    _entries_by_symbol.setdefault(_entry["symbol"], []).append(_entry)


class UnknownSymbolError(LookupError):
    def __init__(self, symbol, mic, provider, include_inactive):
        self.symbol = symbol
        super().__init__(
            "Unknown symbol {!r} (MIC={!r}, provider={!r}, active_only={})".format(
                symbol, mic, provider, not include_inactive
            )
        )


class AmbiguousSymbolError(LookupError):
    def __init__(self, symbol, candidates):
        self.symbol = symbol
        self.candidates = candidates
        detail = ", ".join(
            "{} ({})".format(item["instrument_id"], item["mic"] or "no MIC")
            for item in candidates
        )
        super().__init__("Ambiguous symbol {!r}: {}".format(symbol, detail))


def lookup(symbol, *, mic=None, provider=None, include_inactive=True):
    if not isinstance(symbol, str) or not symbol.strip():
        raise TypeError("symbol must be a non-empty string")
    normalized = symbol.strip().upper()
    if mic is not None:
        if not isinstance(mic, str):
            raise TypeError("mic must be a string or None")
        mic = mic.strip().upper()
        if _MIC.fullmatch(mic) is None:
            raise ValueError("mic must be a four-character MIC")
    if provider is not None:
        if not isinstance(provider, str):
            raise TypeError("provider must be a string or None")
        provider = provider.strip().lower()
        if len(provider) > 100 or _IDENTIFIER.fullmatch(provider) is None:
            raise ValueError("provider must be a lowercase identifier")
    if not isinstance(include_inactive, bool):
        raise TypeError("include_inactive must be a boolean")

    candidates = {}
    for entry in _entries_by_symbol.get(normalized, []):
        record = _records.get(entry["instrument_id"])
        if record is None:
            raise RuntimeError(
                "Snapshot index references missing instrument {}".format(entry["instrument_id"])
            )
        if mic is not None and entry["mic"] != mic:
            continue
        if provider is not None and entry["provider"] not in (None, provider):
            continue
        if not include_inactive and record["listing_status"] != "active":
            continue
        candidates[record["id"]] = record

    if not candidates:
        raise UnknownSymbolError(normalized, mic, provider, include_inactive)
    if len(candidates) > 1:
        raise AmbiguousSymbolError(
            normalized,
            [
                {"instrument_id": identifier, "mic": candidates[identifier]["symbol"]["mic"]}
                for identifier in sorted(candidates)
            ],
        )
    return deepcopy(next(iter(candidates.values())))
